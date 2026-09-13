const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Member = require('../models/Member');
const CoinHistory = require('../models/CoinHistory');
const Coupon = require('../models/Coupon');
const PurchaseOrder = require('../models/PurchaseOrder');
const dhConfig = require('../utils/dhConfig');
const entitlements = require('../utils/entitlements');
const coinRule = require('../utils/coinRule');
const { requireMerchant } = require('../middlewares/auth');

// 等级判定统一走 utils/entitlements（双产品线），此文件不再保留 LEVEL_RANK
const DAY_MS = 24 * 60 * 60 * 1000;

// ============ 工具函数 ============

// 获取或创建商家会员（用于接口前的预校验，不在事务内）
async function getOrCreateMember(shopId) {
  let member = await Member.findOne({ shopId });
  if (!member) {
    try {
      member = await Member.create({ shopId });
    } catch (err) {
      // 并发竞态：另一个请求刚好已创建，直接再查一次
      if (err.code === 11000) {
        member = await Member.findOne({ shopId });
      } else {
        throw err;
      }
    }
  }
  return member;
}

// FIFO 扣减鼎恒币：按 createdAt 升序逐笔扣减收入记录的 remaining，直到扣够
// 调用方需保证进入前 member.dinghengCoin >= amount（已在接口层预校验）
async function deductCoinsFifo(shopId, amount, session) {
  const now = new Date();
  const lots = await CoinHistory.find({
    shopId,
    amount: { $gt: 0 },
    remaining: { $gt: 0 },
    expireAt: { $gt: now },
    isExpired: false
  })
    .sort({ createdAt: 1 })
    .session(session);

  let need = amount;
  for (const lot of lots) {
    if (need <= 0) break;
    const take = Math.min(lot.remaining, need);
    lot.remaining = lot.remaining - take; // 均为整数，无浮点漂移
    need = need - take;
    await lot.save({ session });
  }
  if (need > 0) {
    const err = new Error('鼎恒币不足（FIFO 可用余额不够）');
    err.code = 'INSUFFICIENT_COIN';
    throw err;
  }
}

// ============ 会员价值基准（币/天，升级折算剩余天数价值用） ============
// 点餐线：advanced 1500/30=50，premium 2400/30=80（basic 永久免费，基准 0）
// 采购线：plus 3000/30=100，pro 5000/30=167（free 永久免费，基准 0）
const DAILY_COIN_POS = dhConfig.DAILY_COIN_POS || { basic: 0, advanced: 50, premium: 80 };
const DAILY_COIN_PURCHASE = dhConfig.DAILY_COIN_PURCHASE || { free: 0, plus: 100, pro: 167 };

// ============ POST /api/coin/exchange-membership 兑换/升级会员 ============
// 2026-09 双产品线：body.productLine = 'pos' | 'purchase'（默认 pos），两条线独立兑换。
//   pos      → 可兑等级 advanced / premium（basic 永久免费，无需兑换）
//   purchase → 可兑等级 plus / pro（free 永久免费，无需兑换）
// 分支（两条线同规则）：
//  1) 同等级续费（currentLevel == targetLevel）→ 到期时间 +30 天（未过期顺延，已过期从今天起）
//  2) 低等级 → 高等级且当前有效：剩余天数 × 当前档币/天 折算抵扣差价，新效期 = 30天 + 零头天数
//  3) 低等级 → 高等级但当前已失活：按全价开通 30 天
//  4) 高等级 → 低等级：拒绝（不可降兑）
router.post('/coin/exchange-membership', requireMerchant, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const shopId = req.shopId;
    const { targetLevel } = req.body;
    const productLine = req.body.productLine === 'purchase' ? 'purchase' : 'pos';
    if (!targetLevel) {
      return res.status(400).json({ success: false, message: 'targetLevel 不能为空' });
    }

    const isPurchase = productLine === 'purchase';
    const pricing = isPurchase ? dhConfig.PURCHASE_PRICING : dhConfig.POS_PRICING;
    const ranks = isPurchase ? dhConfig.PURCHASE_LEVELS : dhConfig.POS_LEVELS;
    const daily = isPurchase ? DAILY_COIN_PURCHASE : DAILY_COIN_POS;
    const freeLevel = isPurchase ? 'free' : 'basic';
    const lineName = isPurchase ? '采购' : '点餐';

    const p = pricing[targetLevel];
    if (!p) {
      return res.status(400).json({
        success: false,
        message: isPurchase
          ? '采购线目标等级无效（可兑 plus / pro；free 永久免费无需兑换）'
          : '点餐线目标等级无效（可兑 advanced / premium；basic 永久免费无需兑换）'
      });
    }
    const cfg = { name: p.name, coinCost: p.monthlyCoin };

    // 产品线对应的成员字段
    const levelField = isPurchase ? 'purchaseLevel' : 'memberLevel';
    const expireField = isPurchase ? 'purchaseExpire' : 'memberExpire';
    const trialField = isPurchase ? 'purchaseIsTrial' : 'memberIsTrial';
    const sourceField = isPurchase ? 'purchaseSource' : 'memberSource';

    const result = await session.withTransaction(async () => {
      let member = await Member.findOne({ shopId }).session(session);
      if (!member) {
        const [m] = await Member.create([{ shopId }], { session });
        member = m;
      }

      const today = new Date();
      const currentLevel = member[levelField] || freeLevel;
      const currentExpire = member[expireField];
      const isActive = !!currentExpire && currentExpire > today;
      const curRank = ranks[currentLevel] ?? 0;
      const targetRank = ranks[targetLevel] ?? 0;

      // === 分支 4：高等级 → 低等级 拒绝 ===
      if (targetRank < curRank) {
        const e = new Error(`${lineName}线高等级无法降兑为低等级`);
        e.code = 'DOWNGRADE_NOT_ALLOWED';
        throw e;
      }

      // === 分支 2：低等级 → 高等级升级折算（当前有效时） ===
      if (targetRank > curRank && isActive) {
        const daysLeft = Math.max(0, Math.ceil((currentExpire - today) / DAY_MS));
        const dailyCurrent = daily[currentLevel] || 0;
        const dailyTarget = daily[targetLevel] || 0;
        const proratedValue = daysLeft * dailyCurrent;
        const targetCoinCost = cfg.coinCost;
        let payCoin = targetCoinCost - proratedValue;
        if (payCoin < 0) payCoin = 0;

        if (member.dinghengCoin < payCoin) {
          const e = new Error(`鼎恒币不足，需 ${payCoin}（已折算抵扣 ${proratedValue}），当前 ${member.dinghengCoin}`);
          e.code = 'INSUFFICIENT_COIN';
          throw e;
        }

        if (payCoin > 0) {
          await deductCoinsFifo(shopId, payCoin, session);
          member.dinghengCoin = member.dinghengCoin - payCoin;
        }

        const extraDays = dailyTarget > 0 ? Math.floor(proratedValue / dailyTarget) : 0;
        const newExpire = new Date();
        newExpire.setDate(newExpire.getDate() + 30 + extraDays);
        member[expireField] = newExpire;
        member[levelField] = targetLevel;
        member[trialField] = false;
        member[sourceField] = 'coin';
        if (!isPurchase) member.customerPointsEnabled = true;
        await member.save({ session });

        await CoinHistory.create([{
          shopId,
          amount: -payCoin,
          type: 'redeem_membership',
          balanceAfter: member.dinghengCoin,
          expireAt: null,
          remaining: null,
          description: `[${lineName}线] 升级${cfg.name}：剩余 ${daysLeft} 天折算抵扣 ${proratedValue} 币（${dailyCurrent}币/天），实付 ${payCoin} 币，额外获 ${extraDays} 天${cfg.name}`
        }], { session });

        return {
          member,
          scenario: 'upgrade_prorated',
          daysLeft,
          proratedValue,
          payCoin,
          extraDays,
          message: daysLeft > 0
            ? `您剩余的 ${daysLeft} 天${lineName}会员已折算抵扣 ${proratedValue} 币，一天都不浪费！`
            : `当前会员已过期，按全价 ${targetCoinCost} 币开通${cfg.name}`
        };
      }

      // === 分支 1 & 3：同等级续费 / 失活后新开通 / 无折算升级 ===
      const coinCost = cfg.coinCost;

      if (member.dinghengCoin < coinCost) {
        const e = new Error(`鼎恒币不足，需 ${coinCost}，当前 ${member.dinghengCoin}`);
        e.code = 'INSUFFICIENT_COIN';
        throw e;
      }

      await deductCoinsFifo(shopId, coinCost, session);
      member.dinghengCoin = member.dinghengCoin - coinCost;

      let base;
      if (currentLevel === targetLevel && isActive) {
        base = new Date(currentExpire);
      } else {
        base = new Date();
      }
      base.setDate(base.getDate() + 30);
      member[expireField] = base;
      member[levelField] = targetLevel;
      member[trialField] = false;
      member[sourceField] = 'coin';
      if (!isPurchase) member.customerPointsEnabled = true;
      await member.save({ session });

      const scenario = (currentLevel === targetLevel) ? 'renewal' : 'upgrade';
      const scenarioText = (currentLevel === targetLevel)
        ? `[${lineName}线] ${cfg.name}续费（+30天）`
        : `[${lineName}线] ${cfg.name}开通`;

      await CoinHistory.create([{
        shopId,
        amount: -coinCost,
        type: 'redeem_membership',
        balanceAfter: member.dinghengCoin,
        expireAt: null,
        remaining: null,
        description: scenarioText
      }], { session });

      return {
        member,
        scenario,
        coinCost,
        message: (currentLevel === targetLevel)
          ? `${cfg.name}续费成功，有效期至 ${fmtDate(base)}`
          : `${cfg.name}开通成功，有效期 30 天`
      };
    });

    res.json({
      success: true,
      data: {
        productLine,
        memberLevel: result.member.memberLevel,
        memberExpire: result.member.memberExpire,
        purchaseLevel: result.member.purchaseLevel,
        purchaseExpire: result.member.purchaseExpire,
        dinghengCoin: result.member.dinghengCoin,
        customerPointsEnabled: result.member.customerPointsEnabled,
        scenario: result.scenario,
        daysLeft: result.daysLeft,
        proratedValue: result.proratedValue,
        payCoin: result.payCoin,
        extraDays: result.extraDays,
        message: result.message
      }
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_COIN') {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (err.code === 'DOWNGRADE_NOT_ALLOWED') {
      return res.status(403).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
});

// 辅助：两个日期之间的整天数（用于流水描述）
function daysBetween(a, b) {
  return Math.max(0, Math.round((b - a) / DAY_MS));
}
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ============ POST /api/coin/exchange-coupon 兑换抵用券 ============

router.post('/coin/exchange-coupon', requireMerchant, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    // shopId 只信任 JWT（requireMerchant 已校验），不再从 body 读取
    const shopId = req.shopId;
    const { couponType } = req.body;
    if (!couponType) {
      return res.status(400).json({ success: false, message: 'couponType 不能为空' });
    }
    const item = dhConfig.coupons.find(c => c.type === couponType);
    if (!item) {
      return res.status(400).json({ success: false, message: '抵用券类型无效' });
    }
    if (item.locked) {
      return res.status(403).json({ success: false, message: `${item.faceValue} 元大额抵用券暂未开放，敬请期待` });
    }

    // 预校验：采购线等级（券属采购线权益）+ 余额（事务外快速失败）
    const pre = await getOrCreateMember(shopId);
    if (!entitlements.canRedeemCoupon(item, pre)) {
      const needPurchase = dhConfig.COUPON_NEED_PURCHASE_LEVEL[item.needLevel] || 'free';
      return res.status(403).json({ success: false, message: `采购会员等级不足，需 ${needPurchase} 及以上` });
    }
    if (pre.dinghengCoin < item.coinCost) {
      return res.status(400).json({ success: false, message: `鼎恒币不足，需 ${item.coinCost}，当前 ${pre.dinghengCoin}` });
    }

    const result = await session.withTransaction(async () => {
      let member = await Member.findOne({ shopId }).session(session);
      if (!member) {
        const [m] = await Member.create([{ shopId }], { session });
        member = m;
      }
      if (member.dinghengCoin < item.coinCost) {
        const e = new Error('鼎恒币不足');
        e.code = 'INSUFFICIENT_COIN';
        throw e;
      }

      // FIFO 扣减
      await deductCoinsFifo(shopId, item.coinCost, session);
      member.dinghengCoin = member.dinghengCoin - item.coinCost;
      await member.save({ session });

      // 创建抵用券（有效期 30 天）
      const expire = new Date();
      expire.setDate(expire.getDate() + dhConfig.couponExpireDays);
      const [coupon] = await Coupon.create([{
        shopId,
        type: item.type,
        name: `采购抵用券-${item.faceValue}元`,
        faceValue: item.faceValue,
        minOrder: item.minOrder,
        status: 'unused',
        expireDate: expire
      }], { session });

      // 流水
      await CoinHistory.create([{
        shopId,
        amount: -item.coinCost,
        type: 'redeem_coupon',
        balanceAfter: member.dinghengCoin,
        expireAt: null,
        remaining: null,
        description: `兑换${item.faceValue}元抵用券`
      }], { session });

      return { member, coupon };
    });

    res.status(201).json({ success: true, data: result.coupon });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_COIN') {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
});

// ============ GET /api/coin/category-multipliers 品类得币倍率（公开） ============
// 商家采购商城展示「该品类 X 倍得币」用；只返回倍率本身，不含任何返点率信息
router.get('/coin/category-multipliers', async (req, res) => {
  try {
    const map = await coinRule.getMultiplierMap();
    const data = {};
    for (const [category, multiplier] of map.entries()) {
      data[category] = multiplier;
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/coin/month-progress/:shopId ============
// 本月采购得币进度条：本月采购已得币数 + "跳一跳够得着"的最近兑换目标
// 目标按币价升序，仅保留当前会员等级可兑换的券与月卡；
// 最近目标 = 币价高于本月已得币数的第一个目标（进度百分比可视化）。
// 注意：本接口只讲鼎恒币，不出现任何返点 / 档位字样。
router.get('/coin/month-progress/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const member = await getOrCreateMember(shopId);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // 本月采购返币合计（仅 purchase_reward 收入流水；开张礼等赠送不计入"采购已得"）
    const agg = await CoinHistory.aggregate([
      {
        $match: {
          shopId,
          type: 'purchase_reward',
          amount: { $gt: 0 },
          createdAt: { $gte: monthStart }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const monthEarned = (agg[0] && agg[0].total) || 0;

    // 是否曾经采购过（空状态引导卡用，任意状态采购订单计 1 笔即算）
    const purchaseCount = await PurchaseOrder.countDocuments({ shopId });
    const hasPurchased = purchaseCount > 0;

    // 组装当前采购档可达的兑换目标，按币价升序（locked 暂未开放的券不纳入）
    const pRank = entitlements.purchaseRank(member);
    const pRanks = dhConfig.PURCHASE_LEVELS;
    const targets = [];
    for (const c of dhConfig.coupons) {
      if (entitlements.canRedeemCoupon(c, member)) {
        targets.push({ kind: 'coupon', cost: c.coinCost, label: `¥${c.faceValue} 采购抵用券` });
      }
    }
    // 采购省钱卡月卡：free 可兑 plus；plus 可续费 plus 或升 pro；pro 无需再兑
    if (pRank <= pRanks.plus) {
      targets.push({ kind: 'membership', cost: dhConfig.PURCHASE_PRICING.plus.monthlyCoin, label: '采购省钱卡月卡' });
    }
    if (pRank < pRanks.pro) {
      targets.push({ kind: 'membership', cost: dhConfig.PURCHASE_PRICING.pro.monthlyCoin, label: '采购省钱卡Pro月卡' });
    }
    targets.sort((a, b) => a.cost - b.cost);

    // 最近目标：币价 > 本月已得的第一个；全部达标则返回最高目标（100%）
    let target = targets.find(t => t.cost > monthEarned) || null;
    let allReached = false;
    if (!target && targets.length) {
      target = targets[targets.length - 1];
      allReached = true;
    }

    res.json({
      success: true,
      data: {
        monthEarned,
        balance: member.dinghengCoin,
        memberLevel: member.memberLevel,
        hasPurchased,
        allReached,
        target: target ? {
          kind: target.kind,
          label: target.label,
          cost: target.cost,
          needMore: Math.max(0, target.cost - monthEarned),
          percent: Math.min(100, Math.floor(monthEarned / target.cost * 100))
        } : null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/coin/status/:shopId 鼎恒币与券状态 ============

router.get('/coin/status/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const member = await getOrCreateMember(shopId);
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * DAY_MS);

    // 未过期且未使用的券
    const coupons = await Coupon.find({
      shopId,
      status: 'unused',
      expireDate: { $gt: now }
    }).sort({ expireDate: 1 });

    // 7 天内将过期的券
    const expireWarning = await Coupon.find({
      shopId,
      status: 'unused',
      expireDate: { $gt: now, $lte: in7 }
    }).sort({ expireDate: 1 });

    const pos = entitlements.posState(member);
    const purchase = entitlements.purchaseState(member);

    res.json({
      success: true,
      data: {
        shopId,
        dinghengCoin: member.dinghengCoin,
        // ---- 点餐线（历史字段名保留，前端兼容） ----
        memberLevel: member.memberLevel,
        memberExpire: member.memberExpire,
        // 首月体验期标记（30 天进阶体验）；老数据无该字段时按"剩余不足31天"兜底识别
        memberIsTrial: member.memberIsTrial === true ||
          (member.memberIsTrial == null &&
            member.memberExpire && (member.memberExpire - now) <= 31 * DAY_MS && (member.memberExpire - now) > 0),
        membershipActive: pos.active,
        // ---- 采购线 ----
        purchaseLevel: member.purchaseLevel || 'free',
        purchaseExpire: member.purchaseExpire,
        purchaseIsTrial: member.purchaseIsTrial === true,
        purchaseActive: purchase.active,
        coinRate: entitlements.coinRateOf(member),
        // ---- 两线状态汇总（供前端渲染两张卡） ----
        pos,
        purchase,
        totalEarnedCoin: member.totalEarnedCoin,
        customerPointsEnabled: member.customerPointsEnabled,
        coupons,
        expireWarning
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/member/permissions/:shopId 功能权限清单 ============

router.get('/member/permissions/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const member = await getOrCreateMember(shopId);
    const addonFeatures = await entitlements.getActiveAddonFeatures(shopId);
    const pos = entitlements.posState(member);
    const purchase = entitlements.purchaseState(member);
    const hasPos = (feat) => entitlements.hasPosFeature(feat, member, addonFeatures);
    const hasPurchase = (feat) => entitlements.hasPurchaseFeature(feat, member, addonFeatures);

    // 该采购档可兑换的最大面额券类型（locked 暂未开放的券不计入）
    let maxCouponType = null;
    for (const c of dhConfig.coupons) {
      if (entitlements.canRedeemCoupon(c, member)) maxCouponType = c.type;
    }

    res.json({
      success: true,
      data: {
        // ---- 点餐线功能（历史键名保留，前端兼容） ----
        customerPoints: hasPos('customerPoints'),
        marketingDiscount: hasPos('marketingDiscount'),
        marketingCategoryDiscount: hasPos('marketingCategoryDiscount'),
        marketingRecharge: hasPos('marketingRecharge'),
        marketingFull: hasPos('marketingRecharge') || hasPos('marketingCategoryDiscount'),
        reportBasic: hasPos('reportBasic'),
        reportAdvanced: hasPos('reportAdvanced'),
        premiumTheme: hasPos('premiumTheme'),
        storedValue: hasPos('storedValue'),
        // ---- 采购线功能 ----
        smartForecast: hasPurchase('smartForecast'),
        priceMonitor: hasPurchase('priceMonitor'),
        priceCompare: hasPurchase('priceCompare'),
        largeCoupon: hasPurchase('largeCoupon'),
        priorityDelivery: hasPurchase('priorityDelivery'),
        // ---- 券与两线状态 ----
        maxCouponType,
        memberLevel: member.memberLevel,
        memberExpire: member.memberExpire,
        membershipActive: pos.active,
        purchaseLevel: purchase.paidLevel,
        purchaseExpire: member.purchaseExpire,
        purchaseActive: purchase.active,
        coinRate: entitlements.coinRateOf(member),
        pos,
        purchase,
        addonFeatures
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/coin/history/:shopId 鼎恒币流水 ============

router.get('/coin/history/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const list = await CoinHistory.find({ shopId })
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
