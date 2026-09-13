/**
 * 【已废弃】返点计算服务
 *
 * 加价分销 + 云分账改造后，返点体系已全面停用：本模块不再被任何路由/定时任务调用，
 * 返点规则（RebateRule）/月度结算（RebateSettlement）/供应商余额回写（Supplier.balance）
 * 均不再参与任何金额计算。平台收入改由采购订单分账字段（platformShare）体现。
 * 保留本文件仅为历史代码参考，请勿新增调用。
 *
 * ============ 以下为历史实现（仅供追溯）============
 * 返点计算服务（返点系统唯一计算入口）
 *
 * 数据源链路：RebateRule（规则）→ 本服务计算 → PurchaseOrder/RebateSettlement（落库）→ dev 接口 → 页面展示
 * 费率单位：全程小数（0.05 = 5%），仅前端展示层 ×100 格式化。
 *
 * 供应商返点模式（Supplier.rebateMode，入驻时自选，默认 unified）：
 *   unified    = 统一全品类阶梯返点：整单/整月全部采购额合并，按 DEFAULT_TIERS_UNIFIED 定档
 *   byCategory = 按品类分类阶梯返点：items 按品类分组，各组按品类毛利档
 *                （低/中/高毛利 DEFAULT_TIERS_BY_CATEGORY）分别定档计返点后汇总
 * 专属 RebateRule（分品类/「全部」通用规则）优先于平台默认阶梯；rebateMode 仅决定无规则时的默认计法。
 *
 * 两种累进算法（tier.mode）：
 *   full（全额累进）：月累计额命中某档后，全部金额按该档费率计返点
 *   marginal（超额累进）：各档门槛之间的金额分段按各档费率计，逐段求和
 * 规则 enabled=false 时视为不存在，回退该供应商「全部」通用规则或平台默认阶梯。
 */
const RebateRule = require('../models/RebateRule');
const RebateSettlement = require('../models/RebateSettlement');
const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const SupplyProduct = require('../models/SupplyProduct');
const dhConfig = require('./dhConfig');

// 平台公示默认阶梯（统一全品类，全额累进，按月）：
//   0-5万 1% / 5-15万 1.5% / 15-50万 2% / 50-100万 2.5% / 100-200万 3% / 200-500万 4% / 500万以上 5%
const DEFAULT_TIERS = dhConfig.DEFAULT_TIERS_UNIFIED;
const DEFAULT_TIERS_UNIFIED = dhConfig.DEFAULT_TIERS_UNIFIED;
const DEFAULT_TIERS_BY_CATEGORY = dhConfig.DEFAULT_TIERS_BY_CATEGORY;
// 兜底边际费率：取统一阶梯第一档 1%
const DEFAULT_REBATE_RATE = 0.01;
// 通用品类规则标识
const ALL_CATEGORY = '全部';
// 建议品类（前端表单下拉建议用，不强制）
const SUGGESTED_CATEGORIES = ['肉类', '蔬菜', '粮油', '酒水', '冻品', '调料', '其他'];

// 品类毛利分档：'lowMargin' | 'midMargin' | 'highMargin'（未命中映射保守按低毛利）
function classifyMarginCategory(categoryName) {
  return dhConfig.classifyMarginCategory(categoryName);
}

// 按品类名取对应毛利档阶梯（全额累进）；未命中映射的品类回退低毛利阶梯
function getCategoryTiers(categoryName) {
  const marginType = classifyMarginCategory(categoryName);
  return (DEFAULT_TIERS_BY_CATEGORY[marginType] || DEFAULT_TIERS_BY_CATEGORY.lowMargin)
    .map(t => ({ ...t }));
}

// 返回平台默认阶梯规则（合成 RebateRule 形态的对象，供无规则供应商计算用）
function getDefaultRule() {
  return { tiers: DEFAULT_TIERS.map(t => ({ ...t })), enabled: true };
}

// 返回某品类的默认阶梯规则（byCategory 模式无专属规则时用）
function getCategoryDefaultRule(categoryName) {
  return { tiers: getCategoryTiers(categoryName), enabled: true };
}

// 归一化供应商返点模式（老数据无字段时按 unified）
function normalizeRebateMode(supplier) {
  const m = supplier && supplier.rebateMode;
  return m === 'byCategory' ? 'byCategory' : 'unified';
}

// ============ 基础工具 ============

function monthKeyOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(month) {
  const parts = String(month).split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

// 档位归一化：数值化 + 按门槛升序
function normalizeTiers(tiers) {
  return (Array.isArray(tiers) ? tiers : [])
    .map(t => ({
      minAmount: Math.max(0, Number(t.minAmount) || 0),
      rate: Math.min(1, Math.max(0, Number(t.rate) || 0)),
      mode: t.mode === 'marginal' ? 'marginal' : 'full'
    }))
    .sort((a, b) => a.minAmount - b.minAmount);
}

// 档位校验（供路由层调用），返回错误消息或 null
function validateTiers(tiers) {
  const raw = Array.isArray(tiers) ? tiers : [];
  if (raw.length === 0) return '档位不能为空，至少配置一档';
  // 先按原始入参校验范围，避免非法值被归一化静默截断
  for (const t of raw) {
    const rate = Number(t && t.rate);
    if (isNaN(rate) || rate < 0 || rate > 1) {
      return '档位费率必须在 0~1 之间（小数，如 0.05 表示 5%）';
    }
    const minAmount = Number(t && t.minAmount);
    if (isNaN(minAmount) || minAmount < 0) {
      return '档位门槛金额必须为不小于 0 的数字';
    }
    if (t.mode !== undefined && t.mode !== 'full' && t.mode !== 'marginal') {
      return '累进方式 mode 只能为 full（全额累进）或 marginal（超额累进）';
    }
  }
  // 门槛不可重复（归一化后比较）
  const list = normalizeTiers(tiers);
  const seen = new Set();
  for (const t of list) {
    if (seen.has(t.minAmount)) return `档位门槛 ${t.minAmount} 重复`;
    seen.add(t.minAmount);
  }
  return null;
}

/**
 * 取供应商某品类的生效规则（仅 enabled=true）：
 * 优先品类专属规则，其次「全部」通用规则，都没有返回 null
 */
async function getEffectiveRule(supplierId, category) {
  const sid = String(supplierId);
  if (category && category !== ALL_CATEGORY) {
    const exact = await RebateRule.findOne({ supplierId: sid, category, enabled: true });
    if (exact) return exact;
  }
  return await RebateRule.findOne({ supplierId: sid, category: ALL_CATEGORY, enabled: true });
}

/**
 * 根据规则与月累计金额计算返点（核心算法，函数2）
 * 返回 { hasRule, rebate, rate(综合费率), tierIndex, tierMinAmount, tierRate, mode,
 *        nextTierMinAmount, gapToNext, gainToNext, tiers }
 * gainToNext：距下一档还差 gapToNext 元，补足后返点将增加 gainToNext 元
 */
function calcRebate(rule, amount) {
  amount = Math.max(0, Number(amount) || 0);

  // 没有配置规则：按平台公示默认阶梯返点（全额累进）计算
  // mode 记为 'default'，但 tiers 仍返回默认阶梯，供前端公示展示
  if (!rule || !Array.isArray(rule.tiers) || rule.tiers.length === 0) {
    const defaultRule = getDefaultRule();
    const tiers = normalizeTiers(defaultRule.tiers);
    let tierIndex = -1;
    for (let i = 0; i < tiers.length; i++) {
      if (amount >= tiers[i].minAmount) tierIndex = i;
    }
    if (tierIndex === -1) {
      // 默认阶梯首档门槛为 0，理论上必命中；防御性兜底返 0
      return {
        hasRule: false, rebate: 0, rate: 0, tierIndex: -1,
        tierMinAmount: null, tierRate: 0, mode: 'default',
        nextTierMinAmount: tiers[0] ? tiers[0].minAmount : null,
        gapToNext: tiers[0] ? +(tiers[0].minAmount - amount).toFixed(2) : null,
        gainToNext: tiers[0] ? +(calcRebate(defaultRule, tiers[0].minAmount).rebate).toFixed(2) : null,
        tiers
      };
    }
    const active = tiers[tierIndex];
    // 默认阶梯一律全额累进
    const rebate = +(amount * active.rate).toFixed(2);
    const next = tiers[tierIndex + 1] || null;
    let gainToNext = null;
    if (next) {
      const gap = next.minAmount - amount;
      if (gap > 0) {
        gainToNext = +(calcRebate(defaultRule, next.minAmount).rebate - rebate).toFixed(2);
      }
    }
    return {
      hasRule: false,
      rebate,
      rate: amount > 0 ? +(rebate / amount).toFixed(6) : active.rate,
      tierIndex,
      tierMinAmount: active.minAmount,
      tierRate: active.rate,
      mode: 'default',
      nextTierMinAmount: next ? next.minAmount : null,
      gapToNext: next ? +(next.minAmount - amount).toFixed(2) : null,
      gainToNext,
      tiers
    };
  }

  const tiers = normalizeTiers(rule.tiers);

  // 命中档 = minAmount <= amount 的最高一档
  let tierIndex = -1;
  for (let i = 0; i < tiers.length; i++) {
    if (amount >= tiers[i].minAmount) tierIndex = i;
  }

  // 未达第一档门槛：返点为 0
  if (tierIndex === -1) {
    const first = tiers[0];
    const atFirst = calcRebate(rule, first.minAmount).rebate;
    return {
      hasRule: true,
      rebate: 0,
      rate: 0,
      tierIndex: -1,
      tierMinAmount: null,
      tierRate: 0,
      mode: first.mode,
      nextTierMinAmount: first.minAmount,
      gapToNext: +(first.minAmount - amount).toFixed(2),
      gainToNext: +atFirst.toFixed(2),
      tiers
    };
  }

  const active = tiers[tierIndex];
  let rebate = 0;
  if (active.mode === 'marginal') {
    // 超额累进：逐档分段计费
    for (let i = 0; i <= tierIndex; i++) {
      const lo = tiers[i].minAmount;
      const hi = (i + 1 <= tierIndex) ? tiers[i + 1].minAmount : Infinity;
      const portion = Math.min(amount, hi) - lo;
      if (portion > 0) rebate += portion * tiers[i].rate;
    }
  } else {
    // 全额累进：全部金额按命中档费率
    rebate = amount * active.rate;
  }
  rebate = +rebate.toFixed(2);

  const next = tiers[tierIndex + 1] || null;
  // 升档增益：补足到下一档门槛后，返点将增加的金额
  let gainToNext = null;
  if (next) {
    const gap = next.minAmount - amount;
    if (gap > 0) {
      gainToNext = +(calcRebate(rule, next.minAmount).rebate - rebate).toFixed(2);
    }
  }

  return {
    hasRule: true,
    rebate,
    rate: amount > 0 ? +(rebate / amount).toFixed(6) : 0,
    tierIndex,
    tierMinAmount: active.minAmount,
    tierRate: active.rate,
    mode: active.mode,
    nextTierMinAmount: next ? next.minAmount : null,
    gapToNext: next ? +(next.minAmount - amount).toFixed(2) : null,
    gainToNext,
    tiers
  };
}

/**
 * 月累计额对应的「边际费率」——新增 1 元采购额适用的费率
 * 用于订单完成时计算本单预估返点（本单金额 × 当月累计定档后的边际费率）
 * 无规则时按平台默认阶梯定档返回边际费率
 */
function marginalRateAt(rule, amount) {
  amount = Math.max(0, Number(amount) || 0);
  const tiers = normalizeTiers(
    (!rule || !Array.isArray(rule.tiers) || rule.tiers.length === 0)
      ? getDefaultRule().tiers
      : rule.tiers
  );
  let tierIndex = -1;
  for (let i = 0; i < tiers.length; i++) {
    if (amount >= tiers[i].minAmount) tierIndex = i;
  }
  if (tierIndex === -1) return 0;
  return tiers[tierIndex].rate;
}

// ============ 月度数据聚合 ============

/**
 * 取供应商某月已完成订单（按确认收货时间 receiveAt 归属月份；老数据无 receiveAt 时回退 createdAt）
 */
async function getMonthCompletedOrders(supplierId, month) {
  const { start, end } = monthRange(month);
  const filter = {
    status: '已完成',
    $or: [
      { receiveAt: { $gte: start, $lt: end } },
      { receiveAt: null, createdAt: { $gte: start, $lt: end } }
    ]
  };
  if (supplierId) filter.supplierId = supplierId;
  return await PurchaseOrder.find(filter)
    .select('orderNo shopId shopName supplierId items totalAmount actualPayAmount receiveAt createdAt preRebate actualRebateAmount rebateSettled')
    .sort({ receiveAt: 1, createdAt: 1 })
    .lean();
}

/**
 * 将一批订单按品类聚合采购额
 * item.category 快照优先；缺失时按 productId 批量回查 SupplyProduct
 * extraItems：传入一笔尚未入库/刚完成的订单明细参与聚合（完成时实时预估用）
 * 返回 { byCategory: Map<category, amount>, perOrder: Map<orderId, Map<category, amount>> }
 */
async function aggregateByCategory(orders, extraOrder) {
  const byCategory = new Map();
  const perOrder = new Map();

  const addAmount = (map, category, amount) => {
    const key = category || '未分类';
    map.set(key, +((map.get(key) || 0) + amount).toFixed(2));
  };

  // 收集缺失品类快照的商品 ID
  const missingProductIds = new Set();
  orders.forEach(o => {
    (o.items || []).forEach(it => {
      if (!it.category && it.productId) missingProductIds.add(String(it.productId));
    });
  });
  if (extraOrder && Array.isArray(extraOrder.items)) {
    extraOrder.items.forEach(it => {
      if (!it.category && it.productId) missingProductIds.add(String(it.productId));
    });
  }

  const productCache = new Map();
  if (missingProductIds.size > 0) {
    const products = await SupplyProduct.find({ _id: { $in: [...missingProductIds] } })
      .select('category')
      .lean();
    products.forEach(p => productCache.set(String(p._id), p.category || '未分类'));
  }

  const itemCategory = (it) => {
    if (it.category) return it.category;
    if (it.productId && productCache.has(String(it.productId))) return productCache.get(String(it.productId));
    return '未分类';
  };

  orders.forEach(o => {
    const orderMap = new Map();
    (o.items || []).forEach(it => {
      const amount = Number(it.totalPrice) || 0;
      const cat = itemCategory(it);
      addAmount(byCategory, cat, amount);
      addAmount(orderMap, cat, amount);
    });
    perOrder.set(String(o._id), orderMap);
  });

  if (extraOrder && Array.isArray(extraOrder.items)) {
    const extraMap = new Map();
    extraOrder.items.forEach(it => {
      const amount = Number(it.totalPrice) || (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0);
      const cat = itemCategory(it);
      addAmount(byCategory, cat, amount);
      addAmount(extraMap, cat, amount);
    });
    perOrder.set(String(extraOrder._id || 'extra'), extraMap);
  }

  return { byCategory, perOrder };
}

/**
 * 函数1：计算某供应商某品类本月已完成采购总额
 */
async function getMonthCategoryTotal(supplierId, category, month) {
  const orders = await getMonthCompletedOrders(supplierId, month);
  const { byCategory } = await aggregateByCategory(orders);
  return byCategory.get(category) || 0;
}

/**
 * 计算某供应商某月的返点（实时预估口径，按供应商 rebateMode 分模式）
 *   unified   ：整月全部采购额合并，按统一阶梯（或「全部」通用规则）定档，categories 仅一条「全部」
 *   byCategory：分品类聚合，各品类按毛利档阶梯（或品类专属规则）定档后汇总
 */
async function calcSupplierMonthRebate(supplierId, month) {
  const supplier = await Supplier.findById(supplierId).select('name rebateMode').lean();
  const rebateMode = normalizeRebateMode(supplier);

  const orders = await getMonthCompletedOrders(supplierId, month);
  const { byCategory } = await aggregateByCategory(orders);

  const categories = [];
  let totalPurchase = 0;
  let totalRebate = 0;

  if (rebateMode === 'unified') {
    // 统一模式：全品类采购额合并定档
    for (const amount of byCategory.values()) totalPurchase += amount;
    const rule = await getEffectiveRule(supplierId, ALL_CATEGORY);
    const r = calcRebate(rule, totalPurchase);
    totalRebate = r.rebate;
    categories.push({
      category: ALL_CATEGORY,
      purchaseAmount: +totalPurchase.toFixed(2),
      rebateAmount: r.rebate,
      rate: r.rate,
      hasRule: r.hasRule,
      mode: r.mode,
      marginType: 'unified',
      tierIndex: r.tierIndex,
      tierMinAmount: r.tierMinAmount,
      tierRate: r.tierRate,
      nextTierMinAmount: r.nextTierMinAmount,
      gapToNext: r.gapToNext,
      gainToNext: r.gainToNext,
      enabled: rule ? rule.enabled !== false : false,
      effectiveDate: rule ? rule.effectiveDate : null,
      tiers: r.tiers
    });
  } else {
    // 分类模式：各品类按毛利档阶梯分别定档
    for (const [category, purchaseAmount] of byCategory) {
      const marginType = classifyMarginCategory(category);
      let rule = await getEffectiveRule(supplierId, category);
      if (!rule) rule = getCategoryDefaultRule(category); // 无专属规则 → 该品类毛利档默认阶梯
      const r = calcRebate(rule, purchaseAmount);
      categories.push({
        category,
        purchaseAmount,
        rebateAmount: r.rebate,
        rate: r.rate,
        hasRule: r.hasRule,
        mode: r.mode,
        marginType,
        tierIndex: r.tierIndex,
        tierMinAmount: r.tierMinAmount,
        tierRate: r.tierRate,
        nextTierMinAmount: r.nextTierMinAmount,
        gapToNext: r.gapToNext,
        gainToNext: r.gainToNext,
        enabled: rule.enabled !== false,
        effectiveDate: rule.effectiveDate || null,
        tiers: r.tiers
      });
      totalPurchase += purchaseAmount;
      totalRebate += r.rebate;
    }
    // 品类按采购额降序，便于展示
    categories.sort((a, b) => b.purchaseAmount - a.purchaseAmount);
  }

  return {
    supplierId: String(supplierId),
    month,
    rebateMode,
    orderCount: orders.length,
    totalPurchase: +totalPurchase.toFixed(2),
    totalRebate: +totalRebate.toFixed(2),
    categories
  };
}

/**
 * 订单完成时的本单预估返点（按供应商 rebateMode 分模式），聚合口径含本单（extraOrder）：
 *   unified   ：本单全部金额合并，按当月累计总额（含本单）定统一阶梯档 → 本单金额 × 边际费率
 *   byCategory：本单 items 按品类分组，各组按当月同品类累计额（含本单）定毛利档阶梯，
 *               本单返点 = Σ(本单分品类金额 × 该品类当月累计定档后的边际费率)
 * 专属 RebateRule 优先于平台默认阶梯。
 * 返回 { month, mode, preRebate, preRebateRate, lines }
 */
async function estimateOrderRebate(order, supplier) {
  const month = monthKeyOf(order.receiveAt || new Date());
  // supplier 可由调用方传入（避免重复查询）；未传则按 supplierId 查 rebateMode
  let sup = supplier;
  if (!sup || sup.rebateMode == null) {
    sup = await Supplier.findById(order.supplierId).select('rebateMode').lean();
  }
  const mode = normalizeRebateMode(sup);

  const orders = await getMonthCompletedOrders(order.supplierId, month);
  const agg = await aggregateByCategory(orders, order);
  const monthByCategory = agg.byCategory;
  const orderMap = agg.perOrder.get(String(order._id)) || agg.perOrder.get('extra') || new Map();

  const lines = [];
  let orderRebate = 0;
  let orderBase = 0;

  if (mode === 'unified') {
    // 统一模式：本单金额与当月累计均按全品类合并
    let orderAmount = 0;
    let monthAmount = 0;
    for (const [category, amount] of orderMap) {
      orderAmount += amount;
      monthAmount += (monthByCategory.get(category) || amount);
    }
    const rule = await getEffectiveRule(order.supplierId, ALL_CATEGORY);
    const rate = marginalRateAt(rule, monthAmount);
    orderRebate = orderAmount * rate;
    orderBase = orderAmount;
    lines.push({
      category: ALL_CATEGORY,
      amount: +orderAmount.toFixed(2),
      monthAmount: +monthAmount.toFixed(2),
      rate,
      rebate: +(orderAmount * rate).toFixed(2),
      marginType: 'unified'
    });
  } else {
    // 分类模式：逐品类按毛利档阶梯定档
    for (const [category, amount] of orderMap) {
      const monthAmount = monthByCategory.get(category) || amount;
      const marginType = classifyMarginCategory(category);
      let rule = await getEffectiveRule(order.supplierId, category);
      if (!rule) rule = getCategoryDefaultRule(category);
      const rate = marginalRateAt(rule, monthAmount);
      const lineRebate = amount * rate;
      orderRebate += lineRebate;
      orderBase += amount;
      lines.push({
        category,
        amount: +amount.toFixed(2),
        monthAmount: +monthAmount.toFixed(2),
        rate,
        rebate: +lineRebate.toFixed(2),
        marginType
      });
    }
  }

  orderRebate = +orderRebate.toFixed(2);
  const preRebateRate = orderBase > 0 ? +(orderRebate / orderBase).toFixed(6) : 0;

  return { month, mode, preRebate: orderRebate, preRebateRate, lines };
}

// ============ 月度结算 ============

/**
 * 执行某月返点结算（幂等：已有结算记录的供应商跳过）
 * 流程（每供应商一个事务）：
 *   1) 聚合当月已完成订单分品类采购额 → 按规则计算实际返点
 *   2) 写入 RebateSettlement 结算记录
 *   3) 回写每笔订单 actualRebateAmount / rebateSettled / rebateMonth
 *   4) 实际返点累计计入 Supplier.balance
 * 返回 { month, settled: [...], skipped: [...] }
 */
async function settleMonth(month, opts = {}) {
  const { session: externalSession } = opts;
  const ordersAll = await getMonthCompletedOrders(null, month);

  // 按供应商分组
  const bySupplier = new Map();
  ordersAll.forEach(o => {
    const sid = String(o.supplierId);
    if (!bySupplier.has(sid)) bySupplier.set(sid, []);
    bySupplier.get(sid).push(o);
  });

  const settled = [];
  const skipped = [];

  for (const [sid, orders] of bySupplier) {
    const existing = await RebateSettlement.findOne({ month, supplierId: sid });
    if (existing) {
      skipped.push({ supplierId: sid, supplierName: existing.supplierName, reason: '该月已结算' });
      continue;
    }

    const supplier = await Supplier.findById(sid).select('name balance rebateMode').lean();
    const supplierName = (supplier && supplier.name) || '';
    const rebateMode = normalizeRebateMode(supplier);

    const run = async (session) => {
      const { byCategory, perOrder } = await aggregateByCategory(orders);
      const details = [];
      let totalPurchase = 0;
      let totalRebate = 0;
      // 品类 → 结算综合费率（用于回写订单实际返点）；统一模式另存 ALL_CATEGORY 兜底费率
      const catRateMap = new Map();

      if (rebateMode === 'unified') {
        // 统一模式：全品类采购额合并定档，明细仅一条「全部」
        for (const amount of byCategory.values()) totalPurchase += amount;
        const rule = await getEffectiveRule(sid, ALL_CATEGORY);
        const r = calcRebate(rule, totalPurchase);
        totalRebate = r.rebate;
        details.push({
          category: ALL_CATEGORY,
          purchaseAmount: +totalPurchase.toFixed(2),
          rebateAmount: r.rebate,
          rate: r.rate,
          tierMinAmount: r.tierMinAmount,
          mode: r.mode === 'default' ? 'full' : r.mode,
          marginType: 'unified'
        });
        // 统一费率：所有品类订单行均按整单综合费率分摊
        catRateMap.set(ALL_CATEGORY, r.rate);
      } else {
        // 分类模式：按品类分组，各组按毛利档阶梯（或品类专属规则）分别定档
        for (const [category, purchaseAmount] of byCategory) {
          const marginType = classifyMarginCategory(category);
          let rule = await getEffectiveRule(sid, category);
          if (!rule) rule = getCategoryDefaultRule(category);
          const r = calcRebate(rule, purchaseAmount);
          details.push({
            category,
            purchaseAmount,
            rebateAmount: r.rebate,
            rate: r.rate,
            tierMinAmount: r.tierMinAmount,
            mode: r.mode === 'default' ? 'full' : r.mode,
            marginType
          });
          catRateMap.set(category, r.rate);
          totalPurchase += purchaseAmount;
          totalRebate += r.rebate;
        }
      }
      totalPurchase = +totalPurchase.toFixed(2);
      totalRebate = +totalRebate.toFixed(2);

      await RebateSettlement.create([{
        month,
        supplierId: sid,
        supplierName,
        rebateMode,
        totalPurchaseAmount: totalPurchase,
        totalRebateAmount: totalRebate,
        details,
        // 新结算单生成即「待结算」，需开发者后续确认 → 已收款
        status: '待结算',
        settledAt: new Date()
      }], session ? { session } : {});

      // 回写订单实际返点（按订单分品类金额 × 结算综合费率分摊；统一模式取整单费率）
      for (const o of orders) {
        const orderCats = perOrder.get(String(o._id)) || new Map();
        let orderRebate = 0;
        for (const [cat, amt] of orderCats) {
          const rate = catRateMap.has(cat)
            ? catRateMap.get(cat)
            : (catRateMap.get(ALL_CATEGORY) != null ? catRateMap.get(ALL_CATEGORY) : DEFAULT_REBATE_RATE);
          orderRebate += amt * rate;
        }
        orderRebate = +orderRebate.toFixed(2);
        await PurchaseOrder.updateOne(
          { _id: o._id },
          { $set: { actualRebateAmount: orderRebate, rebateSettled: true, rebateMonth: month } },
          session ? { session } : {}
        );
      }

      // 实际返点计入供应商应付余额
      if (totalRebate > 0) {
        await Supplier.updateOne(
          { _id: sid },
          { $inc: { balance: totalRebate } },
          session ? { session } : {}
        );
      }

      return { supplierId: sid, supplierName, totalPurchaseAmount: totalPurchase, totalRebateAmount: totalRebate, details };
    };

    if (externalSession) {
      const result = await run(externalSession);
      settled.push(result);
    } else {
      // 每供应商独立事务；若部署环境为不支持事务的单节点，降级为无事务顺序写入
      const mongoose = require('mongoose');
      const session = await mongoose.startSession();
      try {
        const result = await session.withTransaction(() => run(session));
        settled.push(result);
      } catch (err) {
        if (err && (err.code === 20 || /Transaction|replica|replset/i.test(err.message))) {
          const result = await run(null);
          settled.push(result);
        } else {
          throw err;
        }
      } finally {
        session.endSession();
      }
    }
  }

  return { month, settled, skipped };
}

/**
 * 返点概览：指定月份每个供应商的采购总额/分品类明细/当前档位/预估（或实际）返点/距下一档差额与增益
 * 已结算月份取结算记录（实际口径），未结算月份实时计算（预估口径）
 */
async function getMonthOverview(month) {
  const suppliers = await Supplier.find().select('name rebateMode').sort({ createdAt: 1 }).lean();
  const settlements = await RebateSettlement.find(month ? { month } : {}).lean();
  const settlementMap = new Map(settlements.map(s => [String(s.supplierId), s]));

  const result = [];
  for (const s of suppliers) {
    const sid = String(s._id);
    const settledDoc = settlementMap.get(sid);
    if (settledDoc) {
      // 已结算：实际口径
      result.push({
        supplierId: sid,
        supplierName: settledDoc.supplierName || s.name,
        settled: true,
        settledAt: settledDoc.settledAt,
        rebateMode: settledDoc.rebateMode || 'unified',
        totalPurchase: Number(settledDoc.totalPurchaseAmount) || 0,
        totalRebate: Number(settledDoc.totalRebateAmount) || 0,
        orderCount: null,
        categories: (settledDoc.details || []).map(d => ({
          category: d.category,
          purchaseAmount: Number(d.purchaseAmount) || 0,
          rebateAmount: Number(d.rebateAmount) || 0,
          rate: Number(d.rate) || 0,
          hasRule: d.mode !== 'default',
          mode: d.mode,
          marginType: d.marginType || 'unified',
          tierIndex: null,
          tierMinAmount: d.tierMinAmount,
          tierRate: Number(d.rate) || 0,
          nextTierMinAmount: null,
          gapToNext: null,
          gainToNext: null,
          tiers: []
        })),
        // 结算单状态流
        settleStatus: normalizeSettlementStatus(settledDoc.status),
        confirmedAt: settledDoc.confirmedAt || null,
        paidAt: settledDoc.paidAt || null,
        overdue: isSettlementOverdue(settledDoc)
      });
    } else {
      // 未结算：实时预估口径
      const calc = await calcSupplierMonthRebate(sid, month);
      result.push({
        supplierId: sid,
        supplierName: s.name,
        settled: false,
        settledAt: null,
        rebateMode: calc.rebateMode || normalizeRebateMode(s),
        totalPurchase: calc.totalPurchase,
        totalRebate: calc.totalRebate,
        orderCount: calc.orderCount,
        categories: calc.categories
      });
    }
  }

  // 有采购额的排前面
  result.sort((a, b) => b.totalPurchase - a.totalPurchase);
  return result;
}

// ============ 结算单状态流工具 ============
// 逾期阈值：自结算单生成（settledAt）起超过 15 天未进入「已收款」即逾期
const SETTLEMENT_OVERDUE_DAYS = 15;

/**
 * 判断结算单是否逾期（status 非「已收款」且自 settledAt 起超过 15 天）
 * 历史状态「已结算」视为已确认（未付款），同样参与逾期判定
 */
function isSettlementOverdue(settlement) {
  if (!settlement) return false;
  const status = settlement.status || settlement.get && settlement.get('status');
  if (status === '已收款') return false;
  const settledAt = settlement.settledAt || (settlement.get && settlement.get('settledAt'));
  if (!settledAt) return false;
  const ageMs = Date.now() - new Date(settledAt).getTime();
  return ageMs > SETTLEMENT_OVERDUE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * 规范结算单状态用于展示：历史「已结算」归并为「已确认」
 */
function normalizeSettlementStatus(status) {
  if (status === '已结算') return '已确认';
  return status;
}

module.exports = {
  DEFAULT_REBATE_RATE,
  DEFAULT_TIERS,
  DEFAULT_TIERS_UNIFIED,
  DEFAULT_TIERS_BY_CATEGORY,
  getDefaultRule,
  getCategoryDefaultRule,
  getCategoryTiers,
  classifyMarginCategory,
  normalizeRebateMode,
  ALL_CATEGORY,
  SUGGESTED_CATEGORIES,
  SETTLEMENT_OVERDUE_DAYS,
  monthKeyOf,
  monthRange,
  normalizeTiers,
  validateTiers,
  getEffectiveRule,
  calcRebate,
  marginalRateAt,
  getMonthCompletedOrders,
  aggregateByCategory,
  getMonthCategoryTotal,
  calcSupplierMonthRebate,
  estimateOrderRebate,
  settleMonth,
  getMonthOverview,
  isSettlementOverdue,
  normalizeSettlementStatus
};
