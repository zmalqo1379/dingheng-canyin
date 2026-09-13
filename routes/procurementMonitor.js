const express = require('express');
const router = express.Router();

const PurchaseOrder = require('../models/PurchaseOrder');
const SupplyProduct = require('../models/SupplyProduct');
const PriceCheck = require('../models/PriceCheck');
const { requireMerchant } = require('../middlewares/auth');

// ============ 采购监控 · 防回扣价格异常检测 ============
// 全部基于 PurchaseOrder 模型，严格按 req.shopId（JWT）过滤；
// 仅统计 status='已完成' 的订单（确认收货后才算真实采购成交）。
// 异常检测阈值：最新价 > 历史均价 × 1.2 → warning；> × 1.3 → danger（仅监控买贵，不监控买便宜）

const WARN_RATIO = 1.2;   // 偏离均价 +20%
const DANGER_RATIO = 1.3; // 偏离均价 +30%

// ============ 工具函数 ============

// 某月时间范围（offset: 0 本月 / -1 上月），按服务器本地时区
function monthRange(offset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return { start, end };
}

// YYYY-MM-DD
function fmtDate(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

// 金额保留两位；百分比保留一位
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

// 拉取当前商家全部已完成采购订单（populate 供应商名，按时间正序）
async function loadCompletedOrders(shopId) {
  return PurchaseOrder.find({ shopId, status: '已完成' })
    .populate('supplierId', 'name')
    .sort({ createdAt: 1 })
    .lean();
}

// 将订单明细按「商品名 + 供应商」分组，构建价格序列
// 每组：{ productName, supplierId, supplierName, category, records: [{date, price, quantity, amount, orderNo}] }
function buildGroups(orders) {
  const map = new Map();
  for (const o of orders) {
    const date = o.receiveAt ? new Date(o.receiveAt) : new Date(o.createdAt);
    const sup = o.supplierId && typeof o.supplierId === 'object' ? o.supplierId : null;
    const supplierId = sup ? String(sup._id) : String(o.supplierId || '');
    const supplierName = (sup && sup.name) || '未知供应商';
    for (const it of (o.items || [])) {
      const name = String(it.name || '').trim();
      if (!name) continue;
      const key = name + '|' + supplierId;
      if (!map.has(key)) {
        map.set(key, {
          productName: name,
          supplierId,
          supplierName,
          category: String(it.category || '') || '未分类',
          records: []
        });
      }
      map.get(key).records.push({
        date,
        price: Number(it.unitPrice) || 0,
        quantity: Number(it.quantity) || 0,
        amount: Number(it.totalPrice) || 0,
        orderNo: o.orderNo || ''
      });
    }
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.records.sort((a, b) => a.date - b.date);
    const prices = g.records.map(r => r.price).filter(p => p > 0);
    g.count = g.records.length;
    g.avgPrice = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : 0;
    g.latest = g.records[g.records.length - 1] || null;
    // 最新价相对均价偏离（仅监控买高方向；买便宜不算异常）
    g.deviation = (g.avgPrice > 0 && g.latest) ? (g.latest.price - g.avgPrice) / g.avgPrice : 0;
    g.isAbnormal = g.count >= 2 && g.avgPrice > 0 && g.latest && g.latest.price > g.avgPrice * WARN_RATIO;
  }
  return groups;
}

// 异常预警条目（组 → 前端展示结构）
function toAlert(g) {
  const devPercent = r1(g.deviation * 100);
  const severity = g.latest.price > g.avgPrice * DANGER_RATIO ? 'danger' : 'warning';
  return {
    productName: g.productName,
    supplierName: g.supplierName,
    currentPrice: r2(g.latest.price),
    avgPrice: r2(g.avgPrice),
    deviationPercent: devPercent,
    severity,
    orderNo: g.latest.orderNo,
    date: fmtDate(g.latest.date),
    suggestion: '该商品近期价格偏高，建议货比三家或联系供应商确认'
  };
}

// ============ 1) GET /api/admin/procurement-monitor/overview 监控总览 ============
router.get('/overview', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const orders = await loadCompletedOrders(shopId);
    const cur = monthRange(0);
    const prev = monthRange(-1);

    const inRange = (o, r) => {
      const d = o.receiveAt ? new Date(o.receiveAt) : new Date(o.createdAt);
      return d >= r.start && d < r.end;
    };
    const curOrders = orders.filter(o => inRange(o, cur));
    const prevOrders = orders.filter(o => inRange(o, prev));

    const sumAmount = (list) => r2(list.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0));
    const curAmount = sumAmount(curOrders);
    const prevAmount = sumAmount(prevOrders);
    const supplierIds = new Set(curOrders.map(o => String(o.supplierId && o.supplierId._id ? o.supplierId._id : o.supplierId)).filter(Boolean));

    // 本月预警次数：本月发生的最新采购中，偏离均价 ≥20% 的商品组合数
    const groups = buildGroups(orders);
    const alertCount = groups.filter(g =>
      g.isAbnormal && g.latest && inRange({ receiveAt: g.latest.date, createdAt: g.latest.date }, cur)
    ).length;

    res.json({
      success: true,
      data: {
        totalOrders: curOrders.length,
        totalAmount: curAmount,
        supplierCount: supplierIds.size,
        avgOrderAmount: curOrders.length ? r2(curAmount / curOrders.length) : 0,
        // 环比增长率（%）：上月为 0 时，本月有采购记 100，无采购记 0
        monthOverMonthGrowth: prevAmount > 0
          ? r1((curAmount - prevAmount) / prevAmount * 100)
          : (curAmount > 0 ? 100 : 0),
        alertCount
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 2) GET /price-history?productName=&supplierId=&days=90 单品价格历史 ============
router.get('/price-history', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const productName = String(req.query.productName || '').trim();
    const supplierId = String(req.query.supplierId || '').trim();
    let days = parseInt(req.query.days, 10);
    if (!isFinite(days) || days <= 0) days = 90;
    days = Math.min(days, 365);
    if (!productName) {
      return res.status(400).json({ success: false, message: 'productName 不能为空' });
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const orders = (await loadCompletedOrders(shopId)).filter(o => {
      const d = o.receiveAt ? new Date(o.receiveAt) : new Date(o.createdAt);
      return d >= since;
    });
    let groups = buildGroups(orders).filter(g => g.productName === productName);
    if (supplierId) groups = groups.filter(g => g.supplierId === supplierId);

    const records = groups.flatMap(g => g.records)
      .sort((a, b) => a.date - b.date)
      .map(r => ({ date: fmtDate(r.date), price: r2(r.price), quantity: r.quantity, orderNo: r.orderNo }));

    const prices = records.map(r => r.price).filter(p => p > 0);
    const avgPrice = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : 0;
    const latestPrice = prices.length ? prices[prices.length - 1] : 0;
    res.json({
      success: true,
      data: {
        points: records,
        avgPrice: r2(avgPrice),
        minPrice: prices.length ? r2(Math.min(...prices)) : 0,
        maxPrice: prices.length ? r2(Math.max(...prices)) : 0,
        latestPrice: r2(latestPrice),
        // 最新价相对均价偏离百分比（正数偏高，负数偏低；仅 1 条记录时为 0，不触发异常）
        deviationPercent: avgPrice > 0 ? r1((latestPrice - avgPrice) / avgPrice * 100) : 0,
        // 数据不足 2 条时不触发异常提醒
        enoughData: records.length >= 2
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 3) GET /price-trends 全部商品价格趋势（按采购频次前50） ============
router.get('/price-trends', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const orders = await loadCompletedOrders(shopId);
    const groups = buildGroups(orders);

    // 补全商品单位（明细里未存 unit，从商品库回查；老数据/已删商品兜底 '-'）
    const productIds = [...new Set(orders.flatMap(o => (o.items || []).map(i => String(i.productId))).filter(Boolean))];
    const unitMap = {};
    if (productIds.length) {
      const prods = await SupplyProduct.find({ _id: { $in: productIds } }).select('unit').lean();
      prods.forEach(p => { unitMap[String(p._id)] = p.unit || '-'; });
    }
    // 商品名 → 首个出现的 productId（用于回查单位）
    const namePidMap = {};
    for (const o of orders) {
      for (const it of (o.items || [])) {
        const n = String(it.name || '').trim();
        if (n && !namePidMap[n]) namePidMap[n] = String(it.productId || '');
      }
    }

    const list = groups
      .sort((a, b) => b.count - a.count)
      .slice(0, 50)
      .map(g => {
        // 趋势：最新价高于均价 5% 视为上涨，低于 5% 视为下降
        const trend = !g.latest || g.avgPrice <= 0 ? 'stable'
          : (g.latest.price > g.avgPrice * 1.05 ? 'up'
            : (g.latest.price < g.avgPrice * 0.95 ? 'down' : 'stable'));
        return {
          productName: g.productName,
          supplierId: g.supplierId,
          supplierName: g.supplierName,
          unit: unitMap[namePidMap[g.productName]] || '-',
          dataPoints: g.records.map(r => ({ date: fmtDate(r.date), price: r2(r.price) })),
          avgPrice: r2(g.avgPrice),
          latestPrice: r2(g.latest ? g.latest.price : 0),
          trend,
          alert: g.isAbnormal
        };
      });

    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 4) GET /alerts 价格异常预警列表 ============
router.get('/alerts', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const orders = await loadCompletedOrders(shopId);
    const alerts = buildGroups(orders)
      .filter(g => g.isAbnormal)
      .sort((a, b) => b.deviation - a.deviation)
      .map(toAlert);
    res.json({ success: true, data: alerts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 5) GET /category-breakdown 本月品类占比 ============
router.get('/category-breakdown', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const r = monthRange(0);
    const orders = (await loadCompletedOrders(shopId)).filter(o => {
      const d = o.receiveAt ? new Date(o.receiveAt) : new Date(o.createdAt);
      return d >= r.start && d < r.end;
    });
    const map = new Map();
    let total = 0;
    for (const o of orders) {
      for (const it of (o.items || [])) {
        const cat = String(it.category || '').trim() || '未分类';
        const amt = Number(it.totalPrice) || 0;
        map.set(cat, (map.get(cat) || 0) + amt);
        total += amt;
      }
    }
    const data = [...map.entries()]
      .map(([category, amount]) => ({
        category,
        amount: r2(amount),
        percent: total > 0 ? r1(amount / total * 100) : 0
      }))
      .sort((a, b) => b.amount - a.amount);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 6) GET /supplier-breakdown 本月供应商占比 ============
router.get('/supplier-breakdown', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const r = monthRange(0);
    const orders = (await loadCompletedOrders(shopId)).filter(o => {
      const d = o.receiveAt ? new Date(o.receiveAt) : new Date(o.createdAt);
      return d >= r.start && d < r.end;
    });
    const map = new Map();
    let total = 0;
    for (const o of orders) {
      const sup = o.supplierId && typeof o.supplierId === 'object' ? o.supplierId : null;
      const name = (sup && sup.name) || '未知供应商';
      const amt = Number(o.totalAmount) || 0;
      map.set(name, (map.get(name) || 0) + amt);
      total += amt;
    }
    const data = [...map.entries()]
      .map(([supplierName, amount]) => ({
        supplierName,
        amount: r2(amount),
        percent: total > 0 ? r1(amount / total * 100) : 0
      }))
      .sort((a, b) => b.amount - a.amount);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 7) GET /savings 省钱账单（采购价 vs 平台参考价） ============
// 口径：本月「已确认收货」的商品明细，按「平台参考价 − 你的实际采购价」× 数量 累计；
// 仅统计存在参考价（PriceCheck）的商品；实际采购价高于参考价不计入（不虚报）。
// 无任何参考价数据时 hasData=false，前端隐藏该卡片（宁可不显示，不编造）。
router.get('/savings', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const orders = await loadCompletedOrders(shopId);
    const r = monthRange(0);
    const curOrders = orders.filter(o => {
      const d = o.receiveAt ? new Date(o.receiveAt) : new Date(o.createdAt);
      return d >= r.start && d < r.end;
    });

    const pidSet = new Set();
    for (const o of curOrders) {
      for (const it of (o.items || [])) {
        const pid = it.productId ? String(it.productId) : '';
        if (pid) pidSet.add(pid);
      }
    }
    const pids = [...pidSet];
    if (!pids.length) {
      return res.json({ success: true, data: { hasData: false, monthSaved: 0, note: '本月暂无采购记录' } });
    }

    const checks = await PriceCheck.find({ productId: { $in: pids } }).select('productId refPrice source').lean();
    const refMap = new Map(checks.map(c => [String(c.productId), { refPrice: Number(c.refPrice) || 0, source: c.source || '' }]));

    let monthSaved = 0;
    let comparedItems = 0;
    let coveredItems = 0;
    const details = [];
    for (const o of curOrders) {
      for (const it of (o.items || [])) {
        const pid = it.productId ? String(it.productId) : '';
        if (!pid) continue;
        comparedItems++;
        const ref = refMap.get(pid);
        if (!ref || ref.refPrice <= 0) continue;
        coveredItems++;
        const price = Number(it.unitPrice) || 0;
        const qty = Number(it.quantity) || 0;
        const saved = (ref.refPrice - price) * qty;
        if (saved > 0) {
          monthSaved += saved;
          details.push({
            name: String(it.name || '商品'),
            paidPrice: r2(price),
            refPrice: r2(ref.refPrice),
            quantity: qty,
            saved: r2(saved)
          });
        }
      }
    }
    details.sort((a, b) => b.saved - a.saved);

    res.json({
      success: true,
      data: {
        hasData: coveredItems > 0,
        monthSaved: r2(monthSaved),
        comparedItems,   // 本月明细条数
        coveredItems,    // 其中存在参考价的条数
        topSaved: details.slice(0, 10),
        note: '口径：本月已确认收货商品，按「平台参考价 − 你的实际采购价」× 数量累计；仅统计有参考价的商品，仅供参考'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
