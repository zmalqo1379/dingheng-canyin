const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Member = require('../models/Member');
const CoinHistory = require('../models/CoinHistory');
const Coupon = require('../models/Coupon');
const dhConfig = require('../utils/dhConfig');
const coinRule = require('../utils/coinRule');

// 等级权重，用于比较 needLevel
const LEVEL_RANK = { basic: 0, advanced: 1, premium: 2 };
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

// ============ POST /api/coin/exchange-membership 兑换会员 ============

router.post('/coin/exchange-membership', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { shopId, targetLevel } = req.body;
    if (!shopId || !targetLevel) {
      return res.status(400).json({ success: false, message: 'shopId、targetLevel 不能为空' });
    }
    const cfg = dhConfig.membership[targetLevel];
    if (!cfg) {
      return res.status(400).json({ success: false, message: '目标等级无效，仅支持 advanced / premium' });
    }
    const coinCost = cfg.coinCost;

    // 预校验余额（事务外快速失败）
    const pre = await getOrCreateMember(shopId);
    if (pre.dinghengCoin < coinCost) {
      return res.status(400).json({ success: false, message: `鼎恒币不足，需 ${coinCost}，当前 ${pre.dinghengCoin}` });
    }

    const result = await session.withTransaction(async () => {
      // 事务内重新读取并加锁写
      let member = await Member.findOne({ shopId }).session(session);
      if (!member) {
        const [m] = await Member.create([{ shopId }], { session });
        member = m;
      }
      if (member.dinghengCoin < coinCost) {
        const e = new Error('鼎恒币不足');
        e.code = 'INSUFFICIENT_COIN';
        throw e;
      }

      // FIFO 扣减
      await deductCoinsFifo(shopId, coinCost, session);
      member.dinghengCoin = member.dinghengCoin - coinCost;

      // 等级与到期：当前未过期则顺延 30 天，否则从今天起 +30 天
      const today = new Date();
      let base;
      if (member.memberExpire && member.memberExpire > today) {
        base = new Date(member.memberExpire);
      } else {
        base = new Date();
      }
      base.setDate(base.getDate() + 30);
      member.memberExpire = base;
      member.memberLevel = targetLevel;
      member.memberIsTrial = false; // 鼎恒币兑换开通后不再是赠送体验期
      if (targetLevel === 'advanced' || targetLevel === 'premium') {
        member.customerPointsEnabled = true;
      }
      await member.save({ session });

      // 流水
      await CoinHistory.create([{
        shopId,
        amount: -coinCost,
        type: 'redeem_membership',
        balanceAfter: member.dinghengCoin,
        expireAt: null,
        remaining: null,
        description: `兑换${cfg.name}月卡`
      }], { session });

      return { member };
    });

    res.json({
      success: true,
      data: {
        memberLevel: result.member.memberLevel,
        memberExpire: result.member.memberExpire,
        dinghengCoin: result.member.dinghengCoin,
        customerPointsEnabled: result.member.customerPointsEnabled
      }
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_COIN') {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
});

// ============ POST /api/coin/exchange-coupon 兑换抵用券 ============

router.post('/coin/exchange-coupon', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { shopId, couponType } = req.body;
    if (!shopId || !couponType) {
      return res.status(400).json({ success: false, message: 'shopId、couponType 不能为空' });
    }
    const item = dhConfig.coupons.find(c => c.type === couponType);
    if (!item) {
      return res.status(400).json({ success: false, message: '抵用券类型无效' });
    }

    // 预校验：等级 + 余额（事务外快速失败）
    const pre = await getOrCreateMember(shopId);
    if (LEVEL_RANK[pre.memberLevel] < LEVEL_RANK[item.needLevel]) {
      return res.status(403).json({ success: false, message: `会员等级不足，需 ${item.needLevel} 及以上` });
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

    res.json({
      success: true,
      data: {
        shopId,
        dinghengCoin: member.dinghengCoin,
        memberLevel: member.memberLevel,
        memberExpire: member.memberExpire,
        // 赠送体验期标记；老数据无该字段时按"进阶版且剩余不足31天"兜底识别
        memberIsTrial: member.memberIsTrial === true ||
          (member.memberIsTrial == null && member.memberLevel === 'advanced' &&
            member.memberExpire && (member.memberExpire - now) <= 31 * DAY_MS),
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
    const level = member.memberLevel;
    const has = (feat) => Array.isArray(dhConfig.features[feat]) && dhConfig.features[feat].includes(level);

    // 该等级可兑换的最大面额券类型
    let maxCouponType = null;
    for (const c of dhConfig.coupons) {
      if (LEVEL_RANK[level] >= LEVEL_RANK[c.needLevel]) maxCouponType = c.type;
    }

    res.json({
      success: true,
      data: {
        customerPoints: has('customerPoints'),
        marketingFull: has('marketingFull'),
        reportBasic: has('reportBasic'),
        reportAdvanced: has('reportAdvanced'),
        maxCouponType,
        memberLevel: level,
        memberExpire: member.memberExpire
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
