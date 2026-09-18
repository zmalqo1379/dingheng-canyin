const cron = require('node-cron');
const Member = require('../models/Member');
const CoinHistory = require('../models/CoinHistory');
const Coupon = require('../models/Coupon');
const MembershipOrder = require('../models/MembershipOrder');
const AddonEntitlement = require('../models/AddonEntitlement');
const CustomerPoint = require('../models/CustomerPoint');
const Setting = require('../models/Setting');
const freshnessCheck = require('./freshnessCheck');
const wechatPay = require('./wechatPay');

// 现金购卡待支付订单的兜底取消时长（小时）
const CASH_PENDING_HOURS = Number(process.env.CASH_ORDER_PENDING_HOURS) > 0
  ? Number(process.env.CASH_ORDER_PENDING_HOURS) : 72;

// ============ 1) 鼎恒币过期清理 ============
// 遍历收入记录 amount>0、remaining>0、expireAt<now、未标记过期 的记录
// 按 shopId 分组汇总过期金额，从 Member.dinghengCoin 扣减（余额不足则扣至 0）
// 插入 CoinHistory（type='expired'）并将原收入记录置 isExpired=true、remaining=0
async function clearExpiredCoins() {
  const now = new Date();
  const expiredLots = await CoinHistory.find({
    amount: { $gt: 0 },
    remaining: { $gt: 0 },
    expireAt: { $lt: now },
    isExpired: false
  });

  // 按 shopId 分组
  const byShop = {};
  for (const lot of expiredLots) {
    if (!byShop[lot.shopId]) byShop[lot.shopId] = { sum: 0, lots: [] };
    byShop[lot.shopId].sum += lot.remaining;
    byShop[lot.shopId].lots.push(lot);
  }

  for (const shopId of Object.keys(byShop)) {
    const info = byShop[shopId];
    const expiredSum = info.sum;

    // 先把过期收入批次清零并标记，避免重复处理
    for (const lot of info.lots) {
      lot.remaining = 0;
      lot.isExpired = true;
      await lot.save();
    }

    const member = await Member.findOne({ shopId });
    if (!member) continue;

    // 实际从余额扣减的金额（余额不足则扣至 0，不为负）
    const deduction = Math.max(0, Math.min(member.dinghengCoin, expiredSum));
    if (deduction > 0) {
      member.dinghengCoin = member.dinghengCoin - deduction;
      await member.save();
      await CoinHistory.create({
        shopId,
        amount: -deduction,
        type: 'expired',
        balanceAfter: member.dinghengCoin,
        expireAt: null,
        remaining: null,
        description: '鼎恒币过期清零'
      });
    }
  }

  return Object.keys(byShop).length;
}

// ============ 2) 会员到期失活（双产品线独立回落） ============
// 两条线各自独立到期：到期即回落免费档（点餐→basic 永久免费、采购→free 永久免费）。
// 注意：免费档不再"失活"，顾客积分等免费权益保持开放，故不再置 customerPointsEnabled=false。
async function downgradeExpiredMembers() {
  const now = new Date();
  // 点餐线到期：memberLevel → basic，清空到期时间与体验标记
  const posRes = await Member.updateMany(
    { memberExpire: { $ne: null, $lt: now } },
    { $set: { memberLevel: 'basic', memberExpire: null, memberIsTrial: false } }
  );
  // 采购线到期：purchaseLevel → free，清空到期时间与体验标记
  const purchaseRes = await Member.updateMany(
    { purchaseExpire: { $ne: null, $lt: now } },
    { $set: { purchaseLevel: 'free', purchaseExpire: null, purchaseIsTrial: false } }
  );
  // 过期 addon 授权清理（惰性判定之外顺手删除，避免集合膨胀）
  let addonCleaned = 0;
  try {
    const r = await AddonEntitlement.deleteMany({ expireAt: { $lt: now } });
    addonCleaned = r.deletedCount || 0;
  } catch (e) {
    console.error('[DH Cron] addon 授权清理出错:', e.message);
  }
  if (addonCleaned) console.log(`[DH Cron] 清理过期 addon 授权 ${addonCleaned} 条`);
  return (posRes.modifiedCount || 0) + (purchaseRes.modifiedCount || 0);
}

// ============ 3) 抵用券过期 ============
// expireDate < now 且 status='unused' → 改为 'expired'
async function expireCoupons() {
  const now = new Date();
  const res = await Coupon.updateMany(
    { expireDate: { $lt: now }, status: 'unused' },
    { $set: { status: 'expired' } }
  );
  return res.modifiedCount;
}

// ============ 3.6) 采购草稿超时软删 + 券锁超时释放（上线加固第一批） ============
// 规则（阈值均取自 utils/dhConfig 唯一事实源）：
//   a) 待支付草稿超过 DRAFT_ORDER_TTL_HOURS(24h) → status 置「已取消」（软删，不物理删除），
//      同时释放该单锁定的抵用券回 unused；
//   b) 抵用券锁定超过 COUPON_LOCK_MINUTES(30min) 仍未支付 → 释放回 unused（订单本身保留，
//      支付时若券仍可用会重新占用，不可用则按无券重算金额）。
async function cleanupUnpaidDrafts() {
  const dhConfig = require('./dhConfig');
  const PurchaseOrder = require('../models/PurchaseOrder');
  const now = new Date();

  // a) 草稿 24h 软删
  const deadline = new Date(now.getTime() - dhConfig.DRAFT_ORDER_TTL_HOURS * 3600 * 1000);
  const staleDrafts = await PurchaseOrder.find({
    status: '待支付',
    payStatus: 'unpaid',
    createdAt: { $lt: deadline }
  }).select('_id appliedCouponId');
  let cancelled = 0;
  for (const o of staleDrafts) {
    await PurchaseOrder.updateOne(
      { _id: o._id, status: '待支付' },
      { $set: { status: '已取消', cancelledAt: new Date(), cancelReason: '超时未支付，系统自动取消' } }
    );
    cancelled++;
    // 一并释放该单锁定的券
    if (o.appliedCouponId) {
      await Coupon.updateOne(
        { _id: o.appliedCouponId, status: 'locked', lockedOrderId: String(o._id) },
        { $set: { status: 'unused', lockedOrderId: '', lockedAt: null } }
      );
    }
  }

  // b) 券锁 30 分钟释放（订单保留）
  const lockDeadline = new Date(now.getTime() - dhConfig.COUPON_LOCK_MINUTES * 60 * 1000);
  const lockRes = await Coupon.updateMany(
    { status: 'locked', lockedAt: { $ne: null, $lt: lockDeadline } },
    { $set: { status: 'unused', lockedOrderId: '', lockedAt: null } }
  );

  return { cancelled, released: lockRes.modifiedCount || 0 };
}

// ============ 3.5) 顾客积分过期清零 ============
// 仅对 pointExpiryMode='fixed' 的商家生效：
// 遍历已过 expireAt 且 remaining>0 的批次，清零 remaining，
// 从 cp.points 扣减（余额不为负），写 history(type='expired')
async function clearExpiredCustomerPoints() {
  const now = new Date();
  // 找出所有 fixed 模式的商家
  const fixedShops = await Setting.find({ pointExpiryMode: 'fixed' }).select('shopId').lean();
  const shopIds = fixedShops.map(s => s.shopId);
  if (!shopIds.length) return 0;

  let totalExpired = 0;
  for (const shopId of shopIds) {
    // 找该店下有已过期且仍有剩余的批次的顾客积分账户
    const cps = await CustomerPoint.find({
      shopId,
      batches: {
        $elemMatch: {
          expireAt: { $type: 'date', $lt: now },
          remaining: { $gt: 0 }
        }
      }
    });
    for (const cp of cps) {
      let expiredSum = 0;
      for (const batch of cp.batches) {
        if (batch.expireAt && new Date(batch.expireAt) < now && batch.remaining > 0) {
          expiredSum += batch.remaining;
          batch.remaining = 0;
        }
      }
      if (expiredSum > 0) {
        cp.points = Math.max(0, cp.points - expiredSum);
        cp.markModified('batches');
        cp.history.push({
          type: 'expired',
          amount: -expiredSum,
          balance: cp.points,
          note: '积分过期清零'
        });
        await cp.save();
        totalExpired++;
      }
    }
  }
  return totalExpired;
}

// ============ 4) 会员购卡待支付订单超时自动取消 ============
//   - 微信单：payExpireAt 已过仍 unpaid → 关闭微信订单并置 cancelled/closed
//   - 现金单：creationtime 超过 CASH_PENDING_HOURS 仍 pending → 置 cancelled
// 幂等：仅处理仍处于 pending 的订单，重复执行不会影响已支付/已取消订单
async function cancelExpiredMembershipOrders() {
  const now = new Date();
  let wechatClosed = 0;

  const wxOrders = await MembershipOrder.find({
    payChannel: 'wechat',
    status: 'pending',
    payStatus: 'unpaid',
    payExpireAt: { $ne: null, $lt: now }
  });
  for (const o of wxOrders) {
    // 先尝试关闭微信侧订单（未配置/失败不阻断本地取消）
    if (o.outTradeNo && wechatPay.isConfigured()) {
      try { await wechatPay.closeOrder(o.outTradeNo); } catch (e) { /* 忽略 */ }
    }
    o.status = 'cancelled';
    o.payStatus = 'closed';
    await o.save();
    wechatClosed++;
  }

  const cashBefore = new Date(now.getTime() - CASH_PENDING_HOURS * 3600 * 1000);
  const cashRes = await MembershipOrder.updateMany(
    { payChannel: 'cash', status: 'pending', createdAt: { $lt: cashBefore } },
    { $set: { status: 'cancelled' } }
  );

  return { wechatClosed, cashClosed: cashRes.modifiedCount || 0 };
}

// ============ 5) 会员购卡分账重试 —— 已停用 ============
// 口径调整：会员费（点餐会员卡/采购省钱卡）全额归平台，不再发起微信云分账，
// 故无「分账失败」需要重试。云分账仅用于采购货款（见 retryPurchaseSplits）。

// ============ 6) 月度返点结算 —— 已停用 ============
// 返点体系已随「加价分销 + 云分账」改造下线；平台收入改由订单分账字段直接统计，
// 不再生成月度返点结算单，也不再回写订单 actualRebateAmount / Supplier.balance。

// 合并执行一次每日任务（可手动触发用于验证）
async function runDailyJob() {
  console.log('[DH Cron] 开始每日清理任务', new Date().toISOString());
  const shops = await clearExpiredCoins();
  const members = await downgradeExpiredMembers();
  const coupons = await expireCoupons();
  // 顾客积分过期清零（fixed 模式商家）
  let expiredPoints = 0;
  try {
    expiredPoints = await clearExpiredCustomerPoints();
  } catch (e) {
    console.error('[DH Cron] 顾客积分过期清理出错:', e.message);
  }
  // 保鲜期保护：超期提醒 → 冻结 → 3 倍自动下架
  let freshness = { alertedCount: 0, frozenCount: 0, autoOffCount: 0 };
  try {
    freshness = await freshnessCheck.runFreshnessCheck();
  } catch (e) {
    console.error('[DH Cron] 保鲜期检查出错:', e.message);
  }
  console.log(`[DH Cron] 完成：清理店铺=${shops}，降级会员=${members}，过期券=${coupons}，积分过期=${expiredPoints}，保鲜期(提醒/冻结/下架)=${freshness.alertedCount}/${freshness.frozenCount}/${freshness.autoOffCount}`);
}

// 注册定时任务
function startDhCron() {
  // 每日 02:00：币过期 / 会员降级 / 券过期 / 保鲜期保护
  cron.schedule('0 2 * * *', async () => {
    try {
      await runDailyJob();
    } catch (err) {
      console.error('[DH Cron] 清理任务出错:', err.message);
    }
  });
  // 每 10 分钟：会员购卡待支付订单超时自动取消（会员费不分账，无分账重试）
  cron.schedule('*/10 * * * *', async () => {
    try {
      const r = await cancelExpiredMembershipOrders();
      if (r.wechatClosed || r.cashClosed) {
        console.log(`[DH Cron] 会员购卡超时取消：微信单=${r.wechatClosed}，现金单=${r.cashClosed}`);
      }
    } catch (err) {
      console.error('[DH Cron] 会员购卡超时取消出错:', err.message);
    }
  });
  // 每 5 分钟：采购草稿 24h 软删（待支付→已取消）+ 券锁 30 分钟释放
  cron.schedule('*/5 * * * *', async () => {
    try {
      const r = await cleanupUnpaidDrafts();
      if (r.cancelled || r.released) {
        console.log(`[DH Cron] 采购草稿清理：超时取消=${r.cancelled}，券锁释放=${r.released}`);
      }
    } catch (err) {
      console.error('[DH Cron] 采购草稿清理出错:', err.message);
    }
  });
  // 每 10 分钟：采购订单分账失败自动重试（带重试次数上限，超过留人工介入）
  cron.schedule('*/10 * * * *', async () => {
    try {
      const r = await retryPurchaseSplits();
      if (r.retried) {
        console.log(`[DH Cron] 采购分账重试：处理=${r.retried}，成功=${r.done}`);
      }
    } catch (err) {
      console.error('[DH Cron] 采购分账重试出错:', err.message);
    }
  });
  console.log('[DH Cron] 已注册每日 02:00 清理任务、每 10 分钟会员购卡超时取消、采购分账失败重试');
}

// ============ 7) 采购订单分账失败自动重试 ============
// 下单分账失败的订单（splitStatus=分账失败）自动重试，单订单最多 SPLIT_MAX_RETRY 次
const SPLIT_MAX_RETRY = 5;
async function retryPurchaseSplits() {
  const PurchaseOrder = require('../models/PurchaseOrder');
  const Supplier = require('../models/Supplier');
  const { initiateOrderSplit } = require('../routes/purchaseOrders');
  const orders = await PurchaseOrder.find({
    splitStatus: '分账失败',
    splitRetryCount: { $lt: SPLIT_MAX_RETRY }
  }).limit(50);
  let done = 0;
  for (const o of orders) {
    try {
      const supplier = await Supplier.findById(o.supplierId);
      await initiateOrderSplit(o, supplier);
      await o.save();
      if (o.splitStatus === '分账成功') done++;
    } catch (e) {
      console.error('[DH Cron] 采购分账重试异常', o.orderNo, e.message);
    }
  }
  return { retried: orders.length, done };
}

module.exports = {
  startDhCron,
  runDailyJob,
  retryPurchaseSplits,
  cancelExpiredMembershipOrders,
  cleanupUnpaidDrafts,
  clearExpiredCustomerPoints,
  runFreshnessCheck: () => freshnessCheck.runFreshnessCheck()
};
