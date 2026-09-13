const express = require('express');
const router = express.Router();

const Marketing = require('../models/Marketing');
const Member = require('../models/Member');
const ShopAccount = require('../models/ShopAccount');
const dhConfig = require('../utils/dhConfig');
const entitlements = require('../utils/entitlements');
const { requireMerchant, requirePublicShopId } = require('../middlewares/auth');

// 各活动类型所需功能权限（点餐线）
const TYPE_FEATURE = {
  fullReduction: 'marketingDiscount',        // 满减：进阶版+
  discount: 'marketingCategoryDiscount',     // 折扣：尊享版
  rechargeBonus: 'marketingRecharge'         // 充值送：尊享版
};

// 获取或创建商家会员档案
async function getMember(shopId) {
  let member = await Member.findOne({ shopId });
  if (!member) {
    try { member = await Member.create({ shopId }); }
    catch (e) {
      if (e.code === 11000) member = await Member.findOne({ shopId });
      else throw e;
    }
  }
  return member;
}

// 校验当前商家是否有权创建/编辑该类型活动（点餐线等级达标）
// 2026-09 双产品线：营销工具属点餐线权益，统一走 entitlements 判定
function hasFeature(feature, member) {
  return entitlements.hasPosFeature(feature, member);
}

// 活动标题自动生成（未填 title 时用规则拼出）
function buildTitle(a) {
  if (a.title && a.title.trim()) return a.title.trim();
  if (a.type === 'fullReduction') return `满${a.threshold}元减${a.reduce}元`;
  if (a.type === 'discount') {
    const zhe = Math.round(a.rate * 10);
    return a.category ? `${a.category}${zhe}折` : `全场${zhe}折`;
  }
  if (a.type === 'rechargeBonus') return `充${a.recharge}送${a.bonus}`;
  return '营销活动';
}

// 规范化活动数据并校验规则合法性
function normalizeActivity(body, shopId, member) {
  const type = body.type;
  if (!['fullReduction', 'discount', 'rechargeBonus'].includes(type)) {
    return { error: '活动类型无效' };
  }
  // 权限校验：按类型检查对应功能权限（等级达标且会员在有效期内）
  const feature = TYPE_FEATURE[type];
  if (!hasFeature(feature, member)) {
    const need = feature === 'marketingDiscount' ? '进阶版' : '尊享版';
    const reason = entitlements.posState(member).active
      ? `该活动需${need}及以上会员，请先升级`
      : `会员已过期，开通/续费会员后即可使用（该活动需${need}）`;
    return { error: reason, needUpgrade: true };
  }

  const data = { shopId, type };

  // 共通字段
  data.title = String(body.title || '').trim().slice(0, 40);
  data.enabled = body.enabled === true; // 默认停用，需商家手动启用
  if (body.startTime) data.startTime = new Date(body.startTime);
  if (body.endTime) data.endTime = new Date(body.endTime);
  else if (body.endTime === null) data.endTime = null;

  if (type === 'fullReduction') {
    const threshold = Number(body.threshold);
    const reduce = Number(body.reduce);
    if (!threshold || threshold <= 0) return { error: '满减门槛需大于 0' };
    if (!(reduce > 0) || reduce >= threshold) return { error: '减免金额需大于 0 且小于门槛' };
    data.threshold = +threshold.toFixed(2);
    data.reduce = +reduce.toFixed(2);
  } else if (type === 'discount') {
    const rate = Number(body.rate);
    if (isNaN(rate) || rate <= 0 || rate >= 1) return { error: '折扣率需在 0~1 之间（如 0.8 表示 8 折）' };
    data.rate = +rate.toFixed(2);
    data.category = String(body.category || '').trim();
    if (!data.category) return { error: '折扣活动需选择适用分类' }; // 折扣只能指定分类，不支持全场
  } else if (type === 'rechargeBonus') {
    const recharge = Number(body.recharge);
    const bonus = Number(body.bonus);
    if (!recharge || recharge <= 0) return { error: '充值金额需大于 0' };
    if (!(bonus > 0)) return { error: '赠送金额需大于 0' };
    data.recharge = +recharge.toFixed(2);
    data.bonus = +bonus.toFixed(2);
  }

  data.title = data.title || buildTitle(data);
  return { data };
}

// ============ 商家：活动列表 ============
router.get('/', requireMerchant, async (req, res) => {
  try {
    const list = await Marketing.find({ shopId: req.shopId }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 商家：新建活动 ============
router.post('/', requireMerchant, async (req, res) => {
  try {
    const member = await getMember(req.shopId);
    const r = normalizeActivity(req.body, req.shopId, member);
    if (r.error) {
      return res.status(400).json({ success: false, message: r.error, needUpgrade: !!r.needUpgrade });
    }
    const created = await Marketing.create(r.data);
    res.status(201).json({ success: true, data: created, message: '活动已创建' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 商家：编辑活动 ============
router.put('/:id', requireMerchant, async (req, res) => {
  try {
    const existing = await Marketing.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: '活动不存在' });
    if (existing.shopId !== req.shopId) {
      return res.status(403).json({ success: false, message: '无权操作其他商家的活动' });
    }
    const member = await getMember(req.shopId);
    const body = { ...req.body, type: req.body.type || existing.type };
    const r = normalizeActivity(body, req.shopId, member);
    if (r.error) {
      return res.status(400).json({ success: false, message: r.error, needUpgrade: !!r.needUpgrade });
    }
    Object.assign(existing, r.data);
    await existing.save();
    res.json({ success: true, data: existing, message: '活动已更新' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 商家：启用/停用活动 ============
router.patch('/:id/toggle', requireMerchant, async (req, res) => {
  try {
    const a = await Marketing.findById(req.params.id);
    if (!a) return res.status(404).json({ success: false, message: '活动不存在' });
    if (a.shopId !== req.shopId) {
      return res.status(403).json({ success: false, message: '无权操作其他商家的活动' });
    }
    // 充值送/折扣尊享版、满减进阶版——切换启用同样按类型校验权限（含有效期）
    const member = await getMember(req.shopId);
    if (!hasFeature(TYPE_FEATURE[a.type], member)) {
      return res.status(403).json({ success: false, message: '会员等级不足或已过期，无法操作该活动', needUpgrade: true });
    }
    a.enabled = !a.enabled;
    await a.save();
    res.json({ success: true, data: a, message: a.enabled ? '已启用' : '已停用' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 商家：删除活动 ============
router.delete('/:id', requireMerchant, async (req, res) => {
  try {
    const a = await Marketing.findById(req.params.id);
    if (!a) return res.status(404).json({ success: false, message: '活动不存在' });
    if (a.shopId !== req.shopId) {
      return res.status(403).json({ success: false, message: '无权操作其他商家的活动' });
    }
    await Marketing.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: '活动已删除' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 顾客：获取当前生效的满减/折扣活动（公开，按 shopId）============
// 返回 enabled=true 且在时间窗口内的 fullReduction / discount / rechargeBonus
// （充值送仅用于点餐页优惠条展示；下单优惠计算仍只用满减/折扣，computeDiscount 自动忽略其他类型）
router.get('/active', requirePublicShopId, async (req, res) => {
  try {
    const now = new Date();
    const list = await Marketing.find({
      shopId: req.publicShopId,
      type: { $in: ['fullReduction', 'discount', 'rechargeBonus'] },
      enabled: true,
      $or: [{ endTime: null }, { endTime: { $gte: now } }],
      startTime: { $lte: now }
    }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.buildTitle = buildTitle;
