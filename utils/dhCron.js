const cron = require('node-cron');
const Member = require('../models/Member');
const CoinHistory = require('../models/CoinHistory');
const Coupon = require('../models/Coupon');
const rebate = require('./rebate');

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

// ============ 2) 会员到期失活 ============
// memberExpire < now 的会员统一失活：memberExpire=null、memberIsTrial=false、customerPointsEnabled=false；
// 进阶/尊享同时降级为 basic（基础版体验/月卡过期后保持 basic 等级但失去会员权益，续费/重新兑换即恢复）
async function downgradeExpiredMembers() {
  const now = new Date();
  const res = await Member.updateMany(
    { memberExpire: { $ne: null, $lt: now } },
    { $set: { memberLevel: 'basic', memberExpire: null, memberIsTrial: false, customerPointsEnabled: false } }
  );
  return res.modifiedCount;
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

// ============ 4) 月度返点结算 ============
// 每月 1 号结算上月：按 RebateRule 规则计算各供应商实际返点，
// 生成 RebateSettlement 记录、回写订单 actualRebateAmount、实际返点计入供应商余额（幂等）
async function settleMonthlyRebates(month) {
  let targetMonth = month;
  if (!targetMonth) {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    targetMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  }
  const result = await rebate.settleMonth(targetMonth);
  console.log(`[DH Cron] 月度返点结算完成（${targetMonth}）：新结算 ${result.settled.length} 家，跳过已结算 ${result.skipped.length} 家`);
  return result;
}

// 合并执行一次每日任务（可手动触发用于验证）
async function runDailyJob() {
  console.log('[DH Cron] 开始每日清理任务', new Date().toISOString());
  const shops = await clearExpiredCoins();
  const members = await downgradeExpiredMembers();
  const coupons = await expireCoupons();
  console.log(`[DH Cron] 完成：清理店铺=${shops}，降级会员=${members}，过期券=${coupons}`);
}

// 注册定时任务
function startDhCron() {
  // 每日 02:00：币过期 / 会员降级 / 券过期
  cron.schedule('0 2 * * *', async () => {
    try {
      await runDailyJob();
    } catch (err) {
      console.error('[DH Cron] 清理任务出错:', err.message);
    }
  });
  // 每月 1 号 03:00：结算上月供应商返点
  cron.schedule('0 3 1 * *', async () => {
    try {
      await settleMonthlyRebates();
    } catch (err) {
      console.error('[DH Cron] 月度返点结算出错:', err.message);
    }
  });
  console.log('[DH Cron] 已注册每日 02:00 清理任务与每月 1 号 03:00 返点结算任务');
}

module.exports = { startDhCron, runDailyJob, settleMonthlyRebates };
