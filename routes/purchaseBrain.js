const express = require('express');
const router = express.Router();

const PurchaseOrder = require('../models/PurchaseOrder');
const PriceCheck = require('../models/PriceCheck');
const CoinHistory = require('../models/CoinHistory');
const ServiceTicket = require('../models/ServiceTicket');
const { requireMerchant } = require('../middlewares/auth');

// ============ 采购大脑（一屏看清采购这本账）============
// 老板每天真正想看的东西就四样：这个月花了多少、省了多少、攒了多少币、今天要办什么。
// 原来这些数字散在采购订单 / 采购监控 / 币中心 / 智能补货四个地方，
// 要来回点四五次才能拼出全貌 —— 这里一次性算好，打开就是答案。
//
// 口径纪律（宁可不显示，也不编造）：
//   - 花费只认「已收货 / 已完成」的订单，未收货的不算成交；
//   - 省钱只认有平台参考价（PriceCheck）的商品，没有参考价就不出这个数字；
//   - 币余额按 FIFO 未消耗余额汇总，过期的不计入。
// 全部按 req.shopId 隔离，只读，不写任何业务数据。

const SPENT_STATUS = ['已收货', '已完成'];          // 算作真实成交的状态
const WARN_RATIO = 1.2;                             // 采购价 > 参考价 20% → 提醒
const DANGER_RATIO = 1.3;                           // > 30% → 重点提醒

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

// 某月范围（offset: 0 本月 / -1 上月），按服务器本地时区
function monthRange(offset = 0) {
  const now = new Date();
  return {
    start: new Date(now.getFullYear(), now.getMonth() + offset, 1),
    end: new Date(now.getFullYear(), now.getMonth() + offset + 1, 1)
  };
}

// 订单计入哪个月：以收货时间为准（没收货的用创建时间兜底）
function orderDate(o) {
  return o.receiveAt ? new Date(o.receiveAt) : new Date(o.createdAt);
}

// 订单实付金额：优先 actualPayAmount（已扣券），退回 totalAmount
function orderAmount(o) {
  const pay = Number(o.actualPayAmount);
  if (Number.isFinite(pay) && pay > 0) return pay;
  return Number(o.totalAmount) || 0;
}

// ============ GET /overview ============
router.get('/overview', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const now = new Date();
    const cur = monthRange(0);
    const prev = monthRange(-1);

    const orders = await PurchaseOrder.find({ shopId }).sort({ createdAt: -1 }).lean();

    // ---------- 1) 本月花了多少（含环比）----------
    let curSpent = 0, curOrders = 0, prevSpent = 0;
    const curOrderList = [];
    for (const o of orders) {
      const d = orderDate(o);
      const amt = orderAmount(o);
      if (d >= cur.start && d < cur.end) {
        if (SPENT_STATUS.includes(o.status)) { curSpent += amt; }
        curOrders++;
        curOrderList.push(o);
      } else if (d >= prev.start && d < prev.end && SPENT_STATUS.includes(o.status)) {
        prevSpent += amt;
      }
    }
    // 环比：上月为 0 时不给比率（0→100% 这种数字没有意义，只显示「上月无采购」）
    const momRatio = prevSpent > 0 ? r1(((curSpent - prevSpent) / prevSpent) * 100) : null;

    // ---------- 2) 本月省了多少 + 买贵提醒（同一份参考价，两个方向）----------
    const pidSet = new Set();
    for (const o of curOrderList) {
      for (const it of (o.items || [])) {
        if (it.productId) pidSet.add(String(it.productId));
      }
    }
    const checks = await PriceCheck.find({ productId: { $in: [...pidSet] } })
      .select('productId refPrice').lean();
    const refMap = new Map(checks.map(c => [String(c.productId), Number(c.refPrice) || 0]));

    let monthSaved = 0, coveredItems = 0;
    const expensive = [];   // 买贵的明细（采购价明显高于参考价）
    for (const o of curOrderList) {
      for (const it of (o.items || [])) {
        const pid = it.productId ? String(it.productId) : '';
        if (!pid) continue;
        const ref = refMap.get(pid);
        if (!ref || ref <= 0) continue;
        coveredItems++;
        const price = Number(it.unitPrice) || 0;
        const qty = Number(it.quantity) || 0;
        if (price <= 0 || qty <= 0) continue;
        if (ref > price) {
          monthSaved += (ref - price) * qty;
        } else if (price > ref * WARN_RATIO) {
          expensive.push({
            name: String(it.name || '商品'),
            unitPrice: r2(price),
            refPrice: r2(ref),
            overRatio: r1(((price / ref) - 1) * 100),
            level: price > ref * DANGER_RATIO ? 'danger' : 'warning'
          });
        }
      }
    }
    expensive.sort((a, b) => b.overRatio - a.overRatio);

    // ---------- 3) 鼎恒币：余额 + 本月到手多少 ----------
    const [incomeRows, monthIncomeRows] = await Promise.all([
      // 余额 = 未过期的收入流水里「还没用掉」的部分（FIFO 口径）
      CoinHistory.find({
        shopId,
        remaining: { $gt: 0 },
        isExpired: false,
        $or: [{ expireAt: null }, { expireAt: { $gt: now } }]
      }).select('remaining').lean(),
      CoinHistory.find({
        shopId,
        amount: { $gt: 0 },
        createdAt: { $gte: cur.start, $lt: cur.end }
      }).select('amount').lean()
    ]);
    const coinBalance = incomeRows.reduce((s, r) => s + (Number(r.remaining) || 0), 0);
    const coinMonthEarned = monthIncomeRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

    // ---------- 4) 今天要办什么（只列真正需要老板动手的）----------
    const [unpaid, toReceive, ticketConfirm] = await Promise.all([
      PurchaseOrder.countDocuments({ shopId, status: '待支付' }),
      // 已发货 = 在路上，到货后要点「收货」，是老板今天的动作
      PurchaseOrder.countDocuments({ shopId, status: '已发货' }),
      // 售后只在「供应商给了方案、等老板拍板」时才算待办 —— 等供应商受理的不算
      ServiceTicket.countDocuments({ shopId, status: '待商家确认' })
    ]);
    const todoTotal = unpaid + toReceive + ticketConfirm;

    // ---------- 5) 本月采购结构（钱都给了谁）----------
    const supMap = new Map();
    for (const o of curOrderList) {
      if (!SPENT_STATUS.includes(o.status)) continue;
      const name = String(o.supplierName || '未知供应商');
      supMap.set(name, (supMap.get(name) || 0) + orderAmount(o));
    }
    const suppliers = [...supMap.entries()]
      .map(([name, amount]) => ({ name, amount: r2(amount) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);
    const supplierTotal = suppliers.reduce((s, x) => s + x.amount, 0);
    suppliers.forEach(s => { s.ratio = supplierTotal > 0 ? r1((s.amount / supplierTotal) * 100) : 0; });

    res.json({
      success: true,
      data: {
        month: {
          spent: r2(curSpent),
          prevSpent: r2(prevSpent),
          momRatio,            // null = 上月无采购，前端显示「—」
          orderCount: curOrders
        },
        saving: {
          hasData: coveredItems > 0,
          monthSaved: r2(monthSaved),
          note: '口径：本月已收货商品，按「平台参考价 − 你的实际采购价」× 数量累计，仅统计有参考价的商品'
        },
        coin: {
          balance: Math.floor(coinBalance),
          monthEarned: Math.floor(coinMonthEarned)
        },
        todo: { unpaid, toReceive, ticketConfirm, total: todoTotal },
        alerts: {
          expensiveCount: expensive.length,
          expensive: expensive.slice(0, 5)
        },
        suppliers,
        updatedAt: now.toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
