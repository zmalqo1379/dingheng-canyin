const express = require('express');
const router = express.Router();

const Order = require('../models/Order');
const PurchaseOrder = require('../models/PurchaseOrder');
const { requireMerchant } = require('../middlewares/auth');
const { checkFeature } = require('../middlewares/featureCheck');

// 全部报表接口需商家身份；具体功能按会员等级鉴权（reportBasic / reportAdvanced）
router.use(requireMerchant);

// 统计区间起始（含今天，往前 days-1 天），并归一化到当天 00:00
function rangeStart(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}
function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseDays(q) {
  const n = parseInt(q, 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(n, 1), 90);
}

// ============ GET /api/admin/reports/overview ============
// 经营报表：营收/订单/客单价 + 逐日趋势 + 热销菜品 + 分类占比（进阶版+）
router.get('/overview', checkFeature('reportBasic'), async (req, res) => {
  try {
    const shopId = req.shopId;
    const days = parseDays(req.query.days);
    const start = rangeStart(days);
    const orders = await Order.find({ shopId, status: 'completed', createdAt: { $gte: start } }).lean();

    // 逐日趋势（补齐无订单日期，保证前端柱状连续）
    const dayMap = new Map();
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      dayMap.set(dayKey(d), { date: dayKey(d), revenue: 0, count: 0 });
    }

    let revenueTotal = 0;
    const dishMap = new Map();
    const catMap = new Map();
    orders.forEach(o => {
      const amount = Number(o.totalPrice) || 0;
      revenueTotal += amount;
      const k = dayKey(new Date(o.createdAt));
      if (dayMap.has(k)) {
        const row = dayMap.get(k);
        row.revenue += amount;
        row.count += 1;
      }
      (o.items || []).forEach(it => {
        const qty = Number(it.quantity) || 0;
        const line = (Number(it.price) || 0) * qty;
        const dn = it.dishName || '未知菜品';
        const dRow = dishMap.get(dn) || { name: dn, qty: 0, revenue: 0 };
        dRow.qty += qty;
        dRow.revenue += line;
        dishMap.set(dn, dRow);
        const cat = it.category || '未分类';
        const cRow = catMap.get(cat) || { category: cat, qty: 0, revenue: 0 };
        cRow.qty += qty;
        cRow.revenue += line;
        catMap.set(cat, cRow);
      });
    });

    const orderCount = orders.length;
    res.json({
      success: true,
      data: {
        days,
        orderCount,
        revenueTotal: +revenueTotal.toFixed(2),
        avgTicket: orderCount ? +(revenueTotal / orderCount).toFixed(2) : 0,
        byDay: [...dayMap.values()],
        topDishes: [...dishMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
        categoryMix: [...catMap.values()].sort((a, b) => b.revenue - a.revenue)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/admin/reports/customers ============
// 顾客画像：按手机号聚合消费次数/金额，区分新客与回头客（尊享版）
router.get('/customers', checkFeature('reportAdvanced'), async (req, res) => {
  try {
    const shopId = req.shopId;
    const days = parseDays(req.query.days);
    const start = rangeStart(days);
    const orders = await Order.find({
      shopId,
      status: 'completed',
      createdAt: { $gte: start },
      customerPhone: { $nin: ['', null] }
    }).select('customerPhone totalPrice createdAt').lean();

    const map = new Map();
    orders.forEach(o => {
      const phone = String(o.customerPhone || '').trim();
      if (!phone) return;
      const row = map.get(phone) || { phone, count: 0, amount: 0, lastAt: null };
      row.count += 1;
      row.amount += Number(o.totalPrice) || 0;
      const t = new Date(o.createdAt);
      if (!row.lastAt || t > row.lastAt) row.lastAt = t;
      map.set(phone, row);
    });

    const customers = [...map.values()].map(c => ({
      phone: c.phone,
      // 手机号脱敏展示
      masked: c.phone.length >= 7 ? `${c.phone.slice(0, 3)}****${c.phone.slice(-4)}` : c.phone,
      count: c.count,
      amount: +c.amount.toFixed(2),
      avg: +(c.amount / c.count).toFixed(2),
      lastAt: c.lastAt
    })).sort((a, b) => b.amount - a.amount);

    const totalCustomers = customers.length;
    const repeatCustomers = customers.filter(c => c.count > 1).length;
    res.json({
      success: true,
      data: {
        days,
        totalCustomers,
        repeatCustomers,
        newCustomers: totalCustomers - repeatCustomers,
        repeatRate: totalCustomers ? +(repeatCustomers / totalCustomers * 100).toFixed(1) : 0,
        top: customers.slice(0, 20)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/admin/reports/cost ============
// 损耗分析：采购投入 vs 点餐营收（按品类对比，估算食材成本占比）（尊享版）
router.get('/cost', checkFeature('reportAdvanced'), async (req, res) => {
  try {
    const shopId = req.shopId;
    const days = parseDays(req.query.days);
    const start = rangeStart(days);

    const [orders, purchases] = await Promise.all([
      Order.find({ shopId, status: 'completed', createdAt: { $gte: start } }).lean(),
      PurchaseOrder.find({ shopId, status: '已完成', createdAt: { $gte: start } }).lean()
    ]);

    const salesRevenue = orders.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);

    // 采购按品类汇总（采购明细带下单时的品类快照）
    const catMap = new Map();
    let purchaseAmount = 0;
    purchases.forEach(p => {
      purchaseAmount += Number(p.actualPayAmount != null ? p.actualPayAmount : p.totalAmount) || 0;
      (p.items || []).forEach(it => {
        const cat = it.category || '未分类';
        const line = Number(it.actualLineTotal) || Number(it.totalPrice) || 0;
        const row = catMap.get(cat) || { category: cat, amount: 0 };
        row.amount += line;
        catMap.set(cat, row);
      });
    });

    res.json({
      success: true,
      data: {
        days,
        purchaseAmount: +purchaseAmount.toFixed(2),
        salesRevenue: +salesRevenue.toFixed(2),
        // 成本占比 = 采购投入 / 点餐营收（营收为 0 时无意义，返回 null）
        costRatio: salesRevenue > 0 ? +(purchaseAmount / salesRevenue * 100).toFixed(1) : null,
        purchaseByCategory: [...catMap.values()]
          .map(r => ({ category: r.category, amount: +r.amount.toFixed(2) }))
          .sort((a, b) => b.amount - a.amount)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
