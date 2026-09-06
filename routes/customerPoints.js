const express = require('express');
const router = express.Router();

const CustomerPoint = require('../models/CustomerPoint');
const Setting = require('../models/Setting');
const Dish = require('../models/Dish');
const Order = require('../models/Order');
const Member = require('../models/Member');
const dhConfig = require('../utils/dhConfig');
const { requirePublicShopId } = require('../middlewares/auth');

// 手机号格式（大陆 11 位，1 开头）
function isValidPhone(phone) {
  return /^1\d{10}$/.test(String(phone || '').trim());
}

// 读取商家积分配置（Setting 存储）+ 按会员状态判定功能开关
// 顾客积分为基础版起权益：basic/advanced/premium 在会员有效期内均可用；
// 无有效会员（未开通/体验过期/月卡过期）一律关闭（顾客端隐藏、不累计）
// 总开关 pointEnabled=false 时整体关闭（顾客端隐藏、不累计）
async function getPointConfig(shopId) {
  const s = await Setting.findOne({ shopId }).lean();
  const member = await Member.findOne({ shopId }).lean();
  const level = member ? member.memberLevel : 'basic';
  const memberActive = dhConfig.isMembershipActive(member);
  const enabled = (s ? s.pointEnabled !== false : true) &&
    dhConfig.features.customerPoints.includes(level) &&
    memberActive &&
    Number(s ? s.pointSpendPerPoint : 1) > 0;
  return {
    enabled,
    memberActive,
    spendPerPoint: Number(s ? s.pointSpendPerPoint : 1) || 0,
    deductEnabled: s ? s.pointDeductEnabled !== false : true,
    deductPoints: Number(s ? s.pointDeductPoints : 100) || 100,   // X 积分 = 1 元
    maxPercent: Number(s ? s.pointDeductMaxPercent : 20) || 0,    // 单笔最多抵百分比
    exchangeDishes: (s && Array.isArray(s.pointExchangeDishes)) ? s.pointExchangeDishes : []
  };
}

// 按订单实付金额累计积分并扣减抵现积分（下单成功后调用）
// 返回 { pointsEarned, pointsBalance }
async function settlePointsForOrder({ shopId, phone, payAmount, pointsUsed, orderId }) {
  const cfg = await getPointConfig(shopId);
  const pointsEarned = cfg.enabled && cfg.spendPerPoint > 0
    ? Math.floor(Number(payAmount) * cfg.spendPerPoint)
    : 0;
  if (!cfg.enabled || (pointsEarned <= 0 && !(pointsUsed > 0))) {
    return { pointsEarned: 0, pointsBalance: null };
  }
  // 确保账户存在
  let cp = await CustomerPoint.findOne({ shopId, phone });
  if (!cp) {
    try { cp = await CustomerPoint.create({ shopId, phone, points: 0, totalEarned: 0, history: [] }); }
    catch (e) {
      if (e.code === 11000) cp = await CustomerPoint.findOne({ shopId, phone });
      else throw e;
    }
  }
  // 先扣抵现积分
  if (pointsUsed > 0) {
    cp.points = Math.max(0, cp.points - pointsUsed);
    cp.history.push({ type: 'deduct', amount: -pointsUsed, balance: cp.points, orderId, note: '下单抵现' });
  }
  // 再累计获得积分
  if (pointsEarned > 0) {
    cp.points += pointsEarned;
    cp.totalEarned += pointsEarned;
    cp.history.push({ type: 'earn', amount: pointsEarned, balance: cp.points, orderId, note: '消费获得' });
  }
  await cp.save();
  return { pointsEarned, pointsBalance: cp.points };
}

// ============ 顾客：积分配置（公开，按 shopId） ============
router.get('/config', requirePublicShopId, async (req, res) => {
  try {
    const cfg = await getPointConfig(req.publicShopId);
    res.json({ success: true, data: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 顾客：按手机号查积分余额 ============
router.post('/query', requirePublicShopId, async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!isValidPhone(phone)) {
      return res.status(400).json({ success: false, message: '请输入正确的 11 位手机号' });
    }
    const cp = await CustomerPoint.findOne({ shopId: req.publicShopId, phone }).lean();
    res.json({
      success: true,
      data: { points: cp ? cp.points : 0, totalEarned: cp ? cp.totalEarned : 0 }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 顾客：积分换菜（生成 0 元订单进后厨） ============
router.post('/redeem-dish', requirePublicShopId, async (req, res) => {
  try {
    const shopId = req.publicShopId;
    const phone = String(req.body.phone || '').trim();
    const dishId = String(req.body.dishId || '').trim();
    if (!isValidPhone(phone)) {
      return res.status(400).json({ success: false, message: '请输入正确的 11 位手机号' });
    }
    const cfg = await getPointConfig(shopId);
    if (!cfg.enabled) {
      return res.status(403).json({ success: false, message: '本店未开通积分换菜' });
    }
    const ex = cfg.exchangeDishes.find(d => String(d.dishId) === dishId);
    if (!ex) {
      return res.status(400).json({ success: false, message: '该菜品不支持积分兑换' });
    }
    // 菜品需存在且在售
    const dish = await Dish.findOne({ _id: dishId, shopId }).lean();
    if (!dish || dish.isAvailable === false) {
      return res.status(400).json({ success: false, message: '该菜品暂不可兑换' });
    }
    // 校验并扣减积分（findOneAndUpdate 原子扣减，防并发超扣）
    const cp = await CustomerPoint.findOneAndUpdate(
      { shopId, phone, points: { $gte: ex.points } },
      {
        $inc: { points: -ex.points },
        $push: { history: { type: 'redeem', amount: -ex.points, note: `兑换菜品：${dish.name}` } }
      },
      { new: true }
    );
    if (!cp) {
      return res.status(400).json({ success: false, message: '积分不足，无法兑换' });
    }
    // 生成 0 元订单进后厨（tableNumber 用固定标识，后厨可见备注）
    const order = await Order.create({
      tableNumber: '积分兑换',
      items: [{ dishName: dish.name, price: 0, quantity: 1, category: dish.category || '' }],
      totalPrice: 0,
      originalTotal: 0,
      discountAmount: 0,
      discountDetail: { pointsRedeem: ex.points },
      remark: `积分兑换菜品，凭本单出餐（${ex.points} 积分）`,
      orderType: 'pointsRedeem',
      customerPhone: phone,
      pointsUsed: ex.points,
      status: 'pending',
      shopId
    });
    res.status(201).json({
      success: true,
      data: { orderId: order._id, dishName: dish.name, usedPoints: ex.points, pointsBalance: cp.points },
      message: '兑换成功，后厨已接单'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.getPointConfig = getPointConfig;
module.exports.settlePointsForOrder = settlePointsForOrder;
module.exports.isValidPhone = isValidPhone;
