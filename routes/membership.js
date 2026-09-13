const express = require('express');
const router = express.Router();

const MembershipOrder = require('../models/MembershipOrder');
const ShopAccount = require('../models/ShopAccount');
const Member = require('../models/Member');
const Supplier = require('../models/Supplier');
const PlatformConfig = require('../models/PlatformConfig');
const dhConfig = require('../utils/dhConfig');
const wechatPay = require('../utils/wechatPay');
const { computeSplitAmounts, initiateSplit } = require('../utils/membershipSplit');
const { requireMerchant } = require('../middlewares/auth');

// 客服电话（现金购卡引导商家线下付款/联系确认）
const SERVICE_PHONE = '400-888-6666';

// 解析购卡方案：按产品线取定价（basic / free 为永久免费档，不可购买）
//   productLine='pos'      → POS_PRICING（advanced/premium）
//   productLine='purchase' → PURCHASE_PRICING（plus/pro）
function resolvePlan(productLine, level) {
  const isPurchase = productLine === 'purchase';
  const pricing = isPurchase ? dhConfig.PURCHASE_PRICING : dhConfig.POS_PRICING;
  const p = pricing[level];
  if (!p) return null;
  return { isPurchase, name: p.name, price: p.monthlyRmb, coinCost: p.monthlyCoin };
}

// 生成订单号：MO + yyyymmdd + 6 位随机数
function genOrderNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `MO${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${rand}`;
}

// 生成微信商户订单号（out_trade_no，≤32 位，字母数字）
function genOutTradeNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `MO${ts}${rand}`;
}

// 支付截止时间（分钟，默认 30）
const PAY_EXPIRE_MINUTES = Number(process.env.WXPAY_PAY_EXPIRE_MINUTES) > 0
  ? Number(process.env.WXPAY_PAY_EXPIRE_MINUTES) : 30;

// RFC3339（+08:00）格式，微信支付 time_expire 要求
function toRfc3339(date) {
  const p = (n) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const oh = p(Math.floor(Math.abs(offsetMin) / 60));
  const om = p(Math.abs(offsetMin) % 60);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}${sign}${oh}:${om}`;
}

// ============ 开通会员（双产品线：按订单 productLine 写入对应线等级/到期） ============
async function activateMembership(order, source) {
  let member = await Member.findOne({ shopId: order.shopId });
  if (!member) member = await Member.create({ shopId: order.shopId });

  const isPurchase = order.productLine === 'purchase';
  const ranks = isPurchase ? dhConfig.PURCHASE_LEVELS : dhConfig.POS_LEVELS;
  const levelField = isPurchase ? 'purchaseLevel' : 'memberLevel';
  const expireField = isPurchase ? 'purchaseExpire' : 'memberExpire';
  const trialField = isPurchase ? 'purchaseIsTrial' : 'memberIsTrial';
  const sourceField = isPurchase ? 'purchaseSource' : 'memberSource';

  if ((ranks[member[levelField]] ?? 0) > (ranks[order.level] ?? 0)) {
    const e = new Error('商家当前会员等级更高，不能按此订单开通低等级');
    e.code = 'LEVEL_CONFLICT';
    throw e;
  }

  const today = new Date();
  const curExpire = member[expireField];
  const isActive = curExpire && curExpire > today;
  const base = (member[levelField] === order.level && isActive)
    ? new Date(curExpire)
    : new Date();
  base.setDate(base.getDate() + 30 * order.months);

  member[levelField] = order.level;
  member[expireField] = base;
  member[trialField] = false;
  member[sourceField] = source || 'wechat';
  if (!isPurchase) member.customerPointsEnabled = true;
  await member.save();
  return base;
}

// 取默认分账供应商（平台配置）+ 抽佣比例
async function resolveSplitContext() {
  const cfg = await PlatformConfig.getSingleton();
  const rate = Number.isFinite(Number(cfg.membershipSplitRate)) ? Number(cfg.membershipSplitRate) : 6;
  let supplier = null;
  if (cfg.defaultSplitSupplierId) {
    supplier = await Supplier.findById(cfg.defaultSplitSupplierId).lean();
  }
  return { rate, supplier };
}

// ============ 确认微信支付成功（幂等 + 并发安全） ============
// 原子抢占：仅第一个把 payStatus 由非 paid 置为 paid 的调用者负责「开通会员」，
// 其余（微信重复回调 / 前端轮询并发）只补发起分账，避免会员被重复开通、多送月数。
async function confirmWechatPaid(outTradeNo, payload) {
  const order = await MembershipOrder.findOne({ outTradeNo });
  if (!order) return null;

  // 已支付：仅补发起分账（幂等）
  if (order.payStatus === 'paid') {
    if (order.splitStatus !== 'done' && order.splitStatus !== 'returned') {
      try { await initiateSplit(order); } catch (e) { /* 已记录 */ }
    }
    return order;
  }

  const claimed = await MembershipOrder.findOneAndUpdate(
    { _id: order._id, payStatus: { $ne: 'paid' } },
    {
      $set: {
        payStatus: 'paid',
        status: 'paid',
        transactionId: (payload && payload.transaction_id) || order.transactionId,
        payerOpenid: (payload && payload.payer && payload.payer.openid) || order.payerOpenid,
        paidAt: new Date(),
        confirmedBy: 'wechat_pay'
      }
    },
    { new: true }
  );
  // 未抢到：已被并发处理，补一次分账后返回
  if (!claimed) {
    const fresh = await MembershipOrder.findById(order._id);
    if (fresh && fresh.splitStatus !== 'done' && fresh.splitStatus !== 'returned') {
      try { await initiateSplit(fresh); } catch (e) { /* 已记录 */ }
    }
    return fresh;
  }

  // 抢占成功者：开通会员（失败仅记录，不阻断回调确认）
  try {
    claimed.memberExpireAfter = await activateMembership(claimed, 'wechat');
  } catch (e) {
    claimed.splitError = `会员开通异常：${e.message}`.slice(0, 300);
    console.error('[Membership] 开通会员失败', claimed.orderNo, e.message);
  }
  await claimed.save();

  try {
    await initiateSplit(claimed);
  } catch (e) {
    console.error('[Membership] 发起分账异常', claimed.orderNo, e.message);
  }
  return claimed;
}

// ============ POST /api/membership/cash-orders（线下现金购卡，保留原有流程） ============
router.post('/cash-orders', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const { level, months = 1, buyerNote = '' } = req.body || {};
    const productLine = req.body.productLine === 'purchase' ? 'purchase' : 'pos';

    const plan = resolvePlan(productLine, level);
    if (!plan) {
      return res.status(400).json({
        success: false,
        message: productLine === 'purchase'
          ? '采购线等级无效（可选 plus / pro；free 永久免费）'
          : '点餐线等级无效（可选 advanced / premium；basic 永久免费）'
      });
    }
    const m = parseInt(months, 10);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      return res.status(400).json({ success: false, message: '购买月数需为 1-12 的整数' });
    }

    const exist = await MembershipOrder.findOne({ shopId, productLine, level, status: 'pending', payChannel: 'cash' });
    if (exist) {
      return res.json({ success: true, data: exist, reused: true, servicePhone: SERVICE_PHONE });
    }

    const member = await Member.findOne({ shopId }).lean();
    if (member) {
      const ranks = plan.isPurchase ? dhConfig.PURCHASE_LEVELS : dhConfig.POS_LEVELS;
      const curLevel = plan.isPurchase ? (member.purchaseLevel || 'free') : (member.memberLevel || 'basic');
      if ((ranks[curLevel] ?? 0) > (ranks[level] ?? 0)) {
        return res.status(400).json({ success: false, message: '当前已是更高等级会员，无需购买低等级' });
      }
    }

    const account = await ShopAccount.findOne({ shopId }).lean();
    const order = await MembershipOrder.create({
      orderNo: genOrderNo(),
      shopId,
      shopName: account ? (account.shopName || '') : '',
      productLine,
      level,
      months: m,
      amountRmb: +(plan.price * m).toFixed(2),
      buyerNote: String(buyerNote || '').slice(0, 200),
      payChannel: 'cash'
    });

    res.status(201).json({ success: true, data: order, servicePhone: SERVICE_PHONE });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/membership/orders ============
// 商家查询自己的购卡订单（现金 + 微信，含历史）
router.get('/orders', requireMerchant, async (req, res) => {
  try {
    const list = await MembershipOrder.find({ shopId: req.shopId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({
      success: true,
      data: list,
      servicePhone: SERVICE_PHONE,
      wechatPayEnabled: wechatPay.isConfigured()
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// 兼容旧前端路径
router.get('/cash-orders', requireMerchant, async (req, res) => {
  try {
    const list = await MembershipOrder.find({ shopId: req.shopId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, data: list, servicePhone: SERVICE_PHONE, wechatPayEnabled: wechatPay.isConfigured() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/membership/pay-config ============
// 前端判断是否展示微信支付入口
router.get('/pay-config', (req, res) => {
  res.json({
    success: true,
    data: {
      wechatPayEnabled: wechatPay.isConfigured(),
      splitConfigured: wechatPay.isSplitConfigured()
    }
  });
});

// ============ POST /api/membership/wechat-orders ============
// 创建微信支付单（Native 扫码）：下单生成支付单 → 返回二维码链接
router.post('/wechat-orders', requireMerchant, async (req, res) => {
  try {
    if (!wechatPay.isConfigured()) {
      return res.status(503).json({ success: false, message: '微信支付未配置，暂不可用' });
    }
    const shopId = req.shopId;
    const { level, months = 1, buyerNote = '' } = req.body || {};
    const productLine = req.body.productLine === 'purchase' ? 'purchase' : 'pos';

    const plan = resolvePlan(productLine, level);
    if (!plan) {
      return res.status(400).json({
        success: false,
        message: productLine === 'purchase'
          ? '采购线等级无效（可选 plus / pro；free 永久免费）'
          : '点餐线等级无效（可选 advanced / premium；basic 永久免费）'
      });
    }
    const m = parseInt(months, 10);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      return res.status(400).json({ success: false, message: '购买月数需为 1-12 的整数' });
    }

    // 复用同一产品线同一等级未过期的待支付微信单，避免重复下单
    const now = new Date();
    const exist = await MembershipOrder.findOne({
      shopId, productLine, level, payChannel: 'wechat', payStatus: 'unpaid',
      payExpireAt: { $gt: now }
    });
    if (exist && exist.codeUrl) {
      return res.json({ success: true, data: exist, reused: true, codeUrl: exist.codeUrl });
    }

    const member = await Member.findOne({ shopId }).lean();
    if (member) {
      const ranks = plan.isPurchase ? dhConfig.PURCHASE_LEVELS : dhConfig.POS_LEVELS;
      const curLevel = plan.isPurchase ? (member.purchaseLevel || 'free') : (member.memberLevel || 'basic');
      if ((ranks[curLevel] ?? 0) > (ranks[level] ?? 0)) {
        return res.status(400).json({ success: false, message: '当前已是更高等级会员，无需购买低等级' });
      }
    }

    const account = await ShopAccount.findOne({ shopId }).lean();
    const amountRmb = +(plan.price * m).toFixed(2);
    const amountFen = Math.round(amountRmb * 100);

    // 分账拆分（平台抽佣 + 供应商）
    const { rate, supplier } = await resolveSplitContext();
    const { platformAmount, supplyAmount } = computeSplitAmounts(amountRmb, rate);

    const payExpireAt = new Date(Date.now() + PAY_EXPIRE_MINUTES * 60 * 1000);
    const order = await MembershipOrder.create({
      orderNo: genOrderNo(),
      outTradeNo: genOutTradeNo(),
      shopId,
      shopName: account ? (account.shopName || '') : '',
      level,
      months: m,
      amountRmb,
      buyerNote: String(buyerNote || '').slice(0, 200),
      payChannel: 'wechat',
      payStatus: 'unpaid',
      payExpireAt,
      splitSupplierId: supplier ? supplier._id : null,
      splitSupplierName: supplier ? (supplier.name || '') : '',
      platformAmount,
      supplyAmount,
      splitStatus: 'none'
    });

    try {
      const prepay = await wechatPay.nativePrepay({
        outTradeNo: order.outTradeNo,
        description: `鼎恒餐饮${plan.isPurchase ? '采购省钱卡' : '点餐会员卡'}-${plan.name}×${m}个月`,
        amountFen,
        attach: order.orderNo,
        timeExpire: toRfc3339(payExpireAt)
      });
      order.prepayId = (prepay && prepay.prepay_id) || '';
      order.codeUrl = (prepay && prepay.code_url) || '';
      await order.save();
    } catch (e) {
      await MembershipOrder.updateOne(
        { _id: order._id },
        { $set: { payStatus: 'closed', status: 'cancelled', splitError: '' } }
      );
      return res.status(502).json({
        success: false,
        message: `微信下单失败：${e.message}`,
        code: e.code || 'WXPAY_PREPAY_FAILED'
      });
    }

    res.status(201).json({ success: true, data: order, codeUrl: order.codeUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/membership/wechat/notify ============
// 微信支付结果回调：验签解密 → 幂等确认 → 开通会员 → 发起分账
router.post('/wechat/notify', async (req, res) => {
  try {
    const payload = await wechatPay.verifyAndDecryptNotify(req.headers, req.rawBody);
    const eventType = req.body && req.body.event_type;
    if (eventType && eventType !== 'TRANSACTION.SUCCESS') {
      return res.json({ code: 'SUCCESS', message: '成功' });
    }
    if (!payload || payload.trade_state !== 'SUCCESS' || !payload.out_trade_no) {
      return res.json({ code: 'SUCCESS', message: '忽略非成功交易' });
    }

    // 确认支付（幂等 + 并发安全）：开通会员 + 发起分账；未知订单也回 200 避免重复推送
    await confirmWechatPaid(payload.out_trade_no, payload);
    return res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('[Membership] 回调处理失败', err.message);
    // 返回非 200 让微信按策略重试
    return res.status(500).json({ code: 'FAIL', message: String(err.message || '处理失败').slice(0, 200) });
  }
});

// ============ GET /api/membership/wechat-orders/:id/status ============
// 前端轮询支付状态（回调延迟时主动向微信查单）
router.get('/wechat-orders/:id/status', requireMerchant, async (req, res) => {
  try {
    const order = await MembershipOrder.findById(req.params.id);
    if (!order || String(order.shopId) !== String(req.shopId)) {
      return res.status(404).json({ success: false, message: '订单不存在' });
    }
    // 未支付且未过期：主动查单，补偿回调未达
    if (order.payChannel === 'wechat' && order.payStatus === 'unpaid' && wechatPay.isConfigured()) {
      try {
        const q = await wechatPay.queryOrder(order.outTradeNo);
        if (q && q.trade_state === 'SUCCESS') {
          order.payStatus = 'paid';
          order.status = 'paid';
          order.transactionId = q.transaction_id || order.transactionId;
          order.payerOpenid = (q.payer && q.payer.openid) || order.payerOpenid;
          order.paidAt = new Date();
          try { order.memberExpireAfter = await activateMembership(order, 'wechat'); } catch (e) { /* 记录 */ }
          await order.save();
          try { await initiateSplit(order); } catch (e) { /* 已记录 */ }
        }
      } catch (e) { /* 查单失败不阻断 */ }
    }
    res.json({
      success: true,
      data: {
        _id: order._id,
        orderNo: order.orderNo,
        payStatus: order.payStatus,
        status: order.status,
        payExpireAt: order.payExpireAt,
        transactionId: order.transactionId,
        memberExpireAfter: order.memberExpireAfter,
        splitStatus: order.splitStatus,
        splitError: order.splitError
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/membership/wechat-orders/:id/refund ============
// 退款（先退款后退分账：已分账则先回退分账，再原路退款）
router.post('/wechat-orders/:id/refund', requireMerchant, async (req, res) => {
  try {
    const order = await MembershipOrder.findById(req.params.id);
    if (!order || String(order.shopId) !== String(req.shopId)) {
      return res.status(404).json({ success: false, message: '订单不存在' });
    }
    if (order.payChannel !== 'wechat' || order.payStatus !== 'paid') {
      return res.status(400).json({ success: false, message: '仅已支付的微信订单可退款' });
    }
    if (order.refundStatus === 'refunded' || order.payStatus === 'refunded') {
      return res.status(400).json({ success: false, message: '该订单已退款' });
    }
    if (!wechatPay.isConfigured()) {
      return res.status(503).json({ success: false, message: '微信支付未配置，暂不可用' });
    }

    const totalFen = Math.round(order.amountRmb * 100);

    // 已分账 → 先回退分账，回收供应商分得的资金
    if (order.splitStatus === 'done') {
      let wxOrderId = order.wxSplitOrderId;
      if (!wxOrderId && order.splitOrderNo) {
        const q = await wechatPay.queryProfitSharing({
          outOrderNo: order.splitOrderNo,
          transactionId: order.transactionId
        });
        wxOrderId = q && q.order_id;
      }
      const supplier = order.splitSupplierId ? await Supplier.findById(order.splitSupplierId).lean() : null;
      const returnMchid = supplier && supplier.wechatSubMchId;
      if (!wxOrderId || !returnMchid) {
        return res.status(400).json({ success: false, message: '缺少分账单号或供应商商户号，无法回退分账' });
      }
      await wechatPay.returnProfitSharing({
        orderId: wxOrderId,
        outOrderNo: order.splitOrderNo,
        outReturnNo: `RT${order.outTradeNo}`,
        returnMchid,
        amountFen: Math.round(order.supplyAmount * 100)
      });
      order.splitStatus = 'returned';
    }

    const outRefundNo = `RF${order.outTradeNo}`;
    const r = await wechatPay.refund({
      transactionId: order.transactionId,
      outRefundNo,
      refundFen: totalFen,
      totalFen,
      reason: '会员购卡退款',
      notifyUrl: process.env.WXPAY_REFUND_NOTIFY_URL || ''
    });
    order.refundNo = outRefundNo;
    order.refundAmount = order.amountRmb;
    order.refundAt = new Date();
    order.refundStatus = (r && r.status === 'SUCCESS') ? 'refunded' : 'refunding';
    if (order.refundStatus === 'refunded') {
      order.payStatus = 'refunded';
      order.status = 'cancelled';
    }
    order.refundError = '';
    await order.save();

    res.json({ success: true, data: order });
  } catch (err) {
    // 记录退款失败原因
    try {
      await MembershipOrder.updateOne(
        { _id: req.params.id },
        { $set: { refundStatus: 'failed', refundError: String(err.message || '').slice(0, 300) } }
      );
    } catch (e) { /* 忽略 */ }
    res.status(500).json({ success: false, message: `退款失败：${err.message}` });
  }
});

// ============ POST /api/membership/wechat/refund-notify ============
// 退款结果回调：更新退款状态
router.post('/wechat/refund-notify', async (req, res) => {
  try {
    const payload = await wechatPay.verifyAndDecryptNotify(req.headers, req.rawBody);
    if (payload && payload.out_refund_no) {
      const order = await MembershipOrder.findOne({ refundNo: payload.out_refund_no });
      if (order && payload.refund_status === 'SUCCESS') {
        order.refundStatus = 'refunded';
        order.payStatus = 'refunded';
        order.status = 'cancelled';
        order.refundAt = order.refundAt || new Date();
        await order.save();
      }
    }
    return res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('[Membership] 退款回调处理失败', err.message);
    return res.status(500).json({ code: 'FAIL', message: String(err.message || '处理失败').slice(0, 200) });
  }
});

// ============ 取消待支付订单（现金单 / 未支付的微信单） ============
async function cancelMembershipOrder(req, res) {
  try {
    const order = await MembershipOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '订单不存在' });
    }
    if (String(order.shopId) !== String(req.shopId)) {
      return res.status(403).json({ success: false, message: '无权操作该订单' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: '仅待支付订单可取消' });
    }
    order.status = 'cancelled';
    if (order.payChannel === 'wechat') order.payStatus = 'closed';
    await order.save();
    // 微信单：顺带关闭微信侧订单（失败不阻断）
    if (order.payChannel === 'wechat' && order.outTradeNo && wechatPay.isConfigured()) {
      try { await wechatPay.closeOrder(order.outTradeNo); } catch (e) { /* 忽略 */ }
    }
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}
router.post('/cash-orders/:id/cancel', requireMerchant, cancelMembershipOrder);
router.post('/wechat-orders/:id/cancel', requireMerchant, cancelMembershipOrder);

module.exports = router;
