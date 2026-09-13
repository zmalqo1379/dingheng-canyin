const express = require('express');
const router = express.Router();

const PurchaseOrder = require('../models/PurchaseOrder');
const SupplyProduct = require('../models/SupplyProduct');
const ShopInventory = require('../models/ShopInventory');
const Order = require('../models/Order');
const DishBom = require('../models/DishBom');
const Member = require('../models/Member');
const entitlements = require('../utils/entitlements');
const { requireMerchant } = require('../middlewares/auth');

// ============ 智能补货 · 阶段1（MVP，零门槛） ============
// 基于商家历史采购频率，判断「该不该补货 + 补多少」，无需商家录配方/库存。
// 算法：对每个已采购商品，统计平均采购间隔 / 平均采购量 / 距上次采购天数；
//       当距上次采购天数 >= 平均间隔时判定为「需要补货」，建议量 = 平均采购量 × 安全系数。
// 数据源：status='已完成' 的采购订单（收货才算真实采购），按 req.shopId（JWT）隔离。

const WINDOW_DAYS = 60;       // 分析窗口：最近 N 天
const SAFETY_FACTOR = 1.1;    // 建议量安全系数（在平均采购量基础上上浮）
const DEFAULT_INTERVAL = 3;   // 只有一条采购记录时，假设的默认采购间隔（天）

// 金额保留两位
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// YYYY-MM-DD
function fmtDate(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

// 拉取商家最近 N 天内的已完成采购订单（收货时间优先，无则用创建时间）
async function loadCompletedOrders(shopId, since) {
  return PurchaseOrder.find({
    shopId,
    status: '已完成',
    $or: [
      { receiveAt: { $gte: since } },
      { receiveAt: null, createdAt: { $gte: since } }
    ]
  })
    .sort({ createdAt: 1 })
    .lean();
}

// 按商品聚合采购记录，计算补货统计
function buildProductStats(orders) {
  const map = new Map();
  for (const o of orders) {
    const date = o.receiveAt ? new Date(o.receiveAt) : new Date(o.createdAt);
    const supplierId = String(o.supplierId || '');
    for (const it of (o.items || [])) {
      const pid = String(it.productId || '');
      if (!pid) continue;
      const quantity = Number(it.quantity) || 0;
      // 商家视角单价：优先 salePrice，回退 unitPrice（老数据）
      const price = Number(it.salePrice) || Number(it.unitPrice) || 0;
      if (!map.has(pid)) {
        map.set(pid, {
          productId: pid,
          name: String(it.name || '').trim(),
          category: String(it.category || '') || '未分类',
          records: []
        });
      }
      map.get(pid).records.push({ date, quantity, price, supplierId });
    }
  }

  const stats = [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (const g of map.values()) {
    g.records.sort((a, b) => a.date - b.date);
    const count = g.records.length;
    const totalQty = g.records.reduce((s, r) => s + r.quantity, 0);
    const latest = g.records[count - 1];
    const earliest = g.records[0];
    // 平均采购间隔：记录跨度 / (次数-1)；仅 1 条时用默认间隔
    const spanDays = (latest.date - earliest.date) / DAY_MS;
    const avgIntervalDays = count >= 2 ? spanDays / (count - 1) : DEFAULT_INTERVAL;
    const avgQuantity = totalQty / count;
    const daysSinceLast = (Date.now() - latest.date.getTime()) / DAY_MS;
    const suggestedQuantity = Math.ceil(avgQuantity * SAFETY_FACTOR);

    stats.push({
      productId: g.productId,
      name: g.name,
      category: g.category,
      supplierId: latest.supplierId, // 以最近一次采购的供应商为准
      count,
      avgIntervalDays: r2(avgIntervalDays),
      avgQuantity: r2(avgQuantity),
      daysSinceLast: r2(daysSinceLast),
      latestPrice: r2(latest.price),
      latestDate: fmtDate(latest.date),
      suggestedQuantity,
      // 距上次采购天数已超过（或等于）平均间隔，判定需要补货
      needReplenish: daysSinceLast >= avgIntervalDays
    });
  }
  return stats;
}

// ============ GET /api/admin/smart-replenish/suggestions ============
router.get('/suggestions', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const orders = await loadCompletedOrders(shopId, since);

    const stats = buildProductStats(orders);
    const needList = stats.filter((s) => s.needReplenish);
    const existingIds = new Set(needList.map((s) => s.productId));

    // ============ 低库存预警：库存 <= 0 的欠料商品（阶段2 融合） ============
    const lowStockList = await ShopInventory.find({ shopId, quantity: { $lte: 0 } }).lean();
    const lowStockProductIds = lowStockList.map((s) => String(s.productId));
    const lowStockProds = lowStockProductIds.length
      ? await SupplyProduct.find({ _id: { $in: lowStockProductIds } })
          .select('name category unit salePrice costPrice supplierName supplierId')
          .lean()
      : [];
    const lowStockMap = new Map(lowStockProds.map((p) => [String(p._id), p]));

    const lowStockSuggestions = lowStockList
      .filter((s) => !existingIds.has(String(s.productId)))
      .map((s) => {
        const p = lowStockMap.get(String(s.productId));
        const shortQty = Math.abs(Number(s.quantity) || 0);
        return {
          productId: String(s.productId),
          name: p ? p.name : '食材',
          category: p ? p.category : '未分类',
          unit: p ? p.unit : '-',
          supplierId: p ? String(p.supplierId) : '',
          supplierName: p ? p.supplierName : '',
          avgIntervalDays: 0,
          avgQuantity: 0,
          daysSinceLast: 0,
          latestPrice: p ? r2(p.salePrice != null ? p.salePrice : p.costPrice) : 0,
          latestPurchaseDate: '',
          suggestedQuantity: Math.max(1, Math.ceil(shortQty * SAFETY_FACTOR)),
          inventoryQuantity: Number(s.quantity) || 0,
          reason: `库存欠料 ${shortQty} 单位，急需补货`
        };
      });

    // 回查商品库补全单位与当前卖价（老数据/已删商品兜底 '-')
    const productIds = needList.map((s) => s.productId);
    const unitMap = {};
    if (productIds.length) {
      const prods = await SupplyProduct.find({ _id: { $in: productIds } })
        .select('unit salePrice costPrice supplierName')
        .lean();
      prods.forEach((p) => {
        unitMap[String(p._id)] = {
          unit: p.unit || '-',
          salePrice: p.salePrice != null ? p.salePrice : p.costPrice,
          supplierName: p.supplierName || ''
        };
      });
    }

    const freqSuggestions = needList
      // 逾期程度排序：距上次天数 / 平均间隔 越大越优先
      .sort((a, b) => (b.daysSinceLast / b.avgIntervalDays) - (a.daysSinceLast / a.avgIntervalDays))
      .map((s) => {
        const info = unitMap[s.productId] || {};
        return {
          productId: s.productId,
          name: s.name,
          category: s.category,
          unit: info.unit || '-',
          supplierId: s.supplierId,
          supplierName: info.supplierName || '',
          avgIntervalDays: s.avgIntervalDays,
          avgQuantity: s.avgQuantity,
          daysSinceLast: s.daysSinceLast,
          latestPrice: info.salePrice != null ? r2(info.salePrice) : s.latestPrice,
          latestPurchaseDate: s.latestDate,
          suggestedQuantity: s.suggestedQuantity,
          reason: `距上次采购 ${s.daysSinceLast} 天，超过平均间隔 ${s.avgIntervalDays} 天`
        };
      });

    // 低库存优先，其次按采购频率
    const suggestions = [...lowStockSuggestions, ...freqSuggestions];

    res.json({
      success: true,
      data: {
        suggestions,
        lowStockCount: lowStockSuggestions.length,
        windowDays: WINDOW_DAYS,
        totalNeedReplenish: suggestions.length,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/admin/smart-replenish/forecast ============
// 阶段3：基于点餐销量 + BOM 配方，预测未来食材需求，对比库存给出采购建议。
// 算法：过去 N 天每道菜日均销量 × 预测天数 × BOM 用量 → 聚合食材需求 → 减去当前库存 → 净需求。
const FORECAST_HISTORY_DAYS = 30; // 历史销量窗口（覆盖月度周期，新商家数据稀疏时更稳）
const FORECAST_DAYS = 7;          // 预测未来天数

router.get('/forecast', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const since = new Date(Date.now() - FORECAST_HISTORY_DAYS * 24 * 60 * 60 * 1000);

    // 1) 拉取历史点餐销量（已完成订单），按星期几聚合（餐饮存在周末/工作日周内波动）
    const orders = await Order.find({ shopId, status: 'completed', createdAt: { $gte: since } }).lean();
    const weekdayDays = new Array(7).fill(0); // 每个星期几在历史窗口内出现的天数（按天去重）
    const dishWeekdaySales = new Map();       // dishName -> Array(7) 每周日销量
    const seenDates = new Set();
    for (const o of orders) {
      const d = new Date(o.createdAt);
      const wd = d.getDay();
      const dateKey = d.toDateString();
      if (!seenDates.has(dateKey)) {
        seenDates.add(dateKey);
        weekdayDays[wd]++;
      }
      for (const it of (o.items || [])) {
        const name = String(it.dishName || '').trim();
        if (!name) continue;
        if (!dishWeekdaySales.has(name)) dishWeekdaySales.set(name, new Array(7).fill(0));
        dishWeekdaySales.get(name)[wd] += Number(it.quantity) || 0;
      }
    }

    // 某道菜未来 FORECAST_DAYS 天的预测销量：逐天按「星期几平均销量」累加
    const forecastDishQty = (weekdaySales) => {
      let total = 0;
      const today = new Date();
      for (let i = 1; i <= FORECAST_DAYS; i++) {
        const wd = new Date(today.getTime() + i * 24 * 60 * 60 * 1000).getDay();
        total += weekdayDays[wd] > 0 ? weekdaySales[wd] / weekdayDays[wd] : 0;
      }
      return total;
    };

    // 2) 拉取该商家全部 BOM
    const boms = await DishBom.find({ shopId }).lean();

    // 3) 按 BOM 折算未来食材需求
    const demandMap = new Map();
    for (const bom of boms) {
      const weekdaySales = dishWeekdaySales.get(bom.dishName);
      if (!weekdaySales) continue;
      const fq = forecastDishQty(weekdaySales);
      if (fq <= 0) continue;
      for (const item of (bom.items || [])) {
        const pid = String(item.productId);
        const need = fq * Number(item.quantity);
        demandMap.set(pid, (demandMap.get(pid) || 0) + need);
      }
    }

    // 4) 对比当前库存，算净需求
    const demandProductIds = [...demandMap.keys()];
    const inventories = demandProductIds.length
      ? await ShopInventory.find({ shopId, productId: { $in: demandProductIds } }).lean()
      : [];
    const invMap = new Map(inventories.map((i) => [String(i.productId), Number(i.quantity) || 0]));

    const prods = demandProductIds.length
      ? await SupplyProduct.find({ _id: { $in: demandProductIds } })
          .select('name category unit salePrice costPrice supplierName supplierId')
          .lean()
      : [];
    const prodMap = new Map(prods.map((p) => [String(p._id), p]));

    const forecastItems = [...demandMap.entries()]
      .map(([pid, need]) => {
        const inv = invMap.get(pid) || 0;
        const net = need - inv;
        const p = prodMap.get(pid);
        return {
          productId: pid,
          name: p ? p.name : '食材',
          category: p ? p.category : '未分类',
          unit: p ? p.unit : '-',
          supplierId: p ? String(p.supplierId) : '',
          supplierName: p ? p.supplierName : '',
          predictedDemand: Math.ceil(need * 100) / 100,
          currentInventory: inv,
          suggestedQuantity: net > 0 ? Math.ceil(net) : 0
        };
      })
      .filter((x) => x.suggestedQuantity > 0)
      .sort((a, b) => b.suggestedQuantity - a.suggestedQuantity);

    // 采购线权益：30 天销量预测需 plus 及以上；free 账号返回引导态（含真实前 3 条预览，前端模糊展示）
    let member = await Member.findOne({ shopId });
    if (!member) member = await Member.create({ shopId });
    const addonFeatures = await entitlements.getActiveAddonFeatures(shopId);
    const unlocked = entitlements.hasPurchaseFeature('smartForecast', member, addonFeatures);

    res.json({
      success: true,
      data: {
        locked: !unlocked,
        needLevel: unlocked ? null : 'plus',
        // 未解锁时给出真实数据前 3 条作为预览（前端模糊 + 升级引导），不编造数据
        previewSample: unlocked ? [] : forecastItems.slice(0, 3),
        forecastItems: unlocked ? forecastItems : [],
        historyDays: FORECAST_HISTORY_DAYS,
        forecastDays: FORECAST_DAYS,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
