/**
 * 双产品线权益判定统一入口（2026-09 采购为核心重构）
 *
 * 两条独立产品线：
 *   A 扫码点餐（POS）：basic 永久免费；advanced/premium 付费有效期内可用高级功能
 *   B 采购管家（PURCHASE）：free 永久免费；plus/pro 付费有效期内可用高级功能
 *
 * 设计原则：
 *   1. 后端判定唯一入口，禁止各路由自行比较等级（旧 LEVEL_RANK 硬编码逐步下线）。
 *   2. 付费档过期即回落免费档（不信任是否已被定时任务降级）。
 *   3. 免费档永久 active，保证"点餐/采购任一单线用户系统完整可用"。
 *   4. addon（零成本币兑小产品）只临时解锁单个 feature，不改等级。
 */
const dhConfig = require('./dhConfig');
const AddonEntitlement = require('../models/AddonEntitlement');

const POS_PAID = ['advanced', 'premium'];
const PURCHASE_PAID = ['plus', 'pro'];

function isFuture(d) {
  return !!d && new Date(d).getTime() > Date.now();
}

/**
 * 点餐线状态
 * @returns {{level:string, paidLevel:string, isFree:boolean, active:boolean, expireAt:Date|null, isTrial:boolean}}
 *   level    生效档位（付费档过期时回落 'basic'）
 *   paidLevel 账户记录的原始档位
 *   isFree   是否免费档（basic）
 *   active   该线是否可用（basic 恒 true；付费档看有效期）
 */
function posState(member) {
  const paidLevel = (member && member.memberLevel) || 'basic';
  const expireAt = (member && member.memberExpire) || null;
  const isFree = paidLevel === 'basic';
  const active = isFree ? true : isFuture(expireAt);
  return {
    level: active ? paidLevel : 'basic',
    paidLevel,
    isFree,
    active,
    expireAt,
    isTrial: !!(member && member.memberIsTrial)
  };
}

/**
 * 采购线状态（语义同 posState）
 */
function purchaseState(member) {
  const paidLevel = (member && member.purchaseLevel) || 'free';
  const expireAt = (member && member.purchaseExpire) || null;
  const isFree = paidLevel === 'free';
  const active = isFree ? true : isFuture(expireAt);
  return {
    level: active ? paidLevel : 'free',
    paidLevel,
    isFree,
    active,
    expireAt,
    isTrial: !!(member && member.purchaseIsTrial)
  };
}

// 等级秩（两线各自独立）
function posRank(member) {
  return dhConfig.POS_LEVELS[posState(member).level] || 0;
}
function purchaseRank(member) {
  return dhConfig.PURCHASE_LEVELS[purchaseState(member).level] || 0;
}

/**
 * 点餐线功能是否开放
 * @param {string} key posFeatures 的键
 * @param {object} member
 * @param {string[]} [addonFeatures] 当前生效 addon 解锁的 feature 列表
 */
function hasPosFeature(key, member, addonFeatures) {
  if (Array.isArray(addonFeatures) && addonFeatures.includes(key)) return true;
  const allow = dhConfig.posFeatures[key];
  if (!Array.isArray(allow)) return false;
  return allow.includes(posState(member).level);
}

/**
 * 采购线功能是否开放
 */
function hasPurchaseFeature(key, member, addonFeatures) {
  if (Array.isArray(addonFeatures) && addonFeatures.includes(key)) return true;
  const allow = dhConfig.purchaseFeatures[key];
  if (!Array.isArray(allow)) return false;
  return allow.includes(purchaseState(member).level);
}

/**
 * 采购返币率（币/元）：按采购线生效档位
 */
function coinRateOf(member) {
  return dhConfig.PURCHASE_COIN_RATE[purchaseState(member).level] ?? 0;
}

/**
 * 券所需采购等级是否达标
 * @param {object} coupon dhConfig.coupons 中的一项（含 needLevel）
 */
function canRedeemCoupon(coupon, member) {
  if (!coupon || coupon.locked) return false;
  const need = dhConfig.COUPON_NEED_PURCHASE_LEVEL[coupon.needLevel] || 'free';
  return purchaseRank(member) >= (dhConfig.PURCHASE_LEVELS[need] || 0);
}

/**
 * 取店铺当前生效的 addon feature 列表（仅未过期授权）
 * @returns {Promise<string[]>}
 */
async function getActiveAddonFeatures(shopId) {
  if (!shopId) return [];
  try {
    const list = await AddonEntitlement.find({
      shopId,
      expireAt: { $gt: new Date() }
    }).select('feature').lean();
    return [...new Set(list.map(a => a.feature).filter(Boolean))];
  } catch (e) {
    return [];
  }
}

/**
 * 一次取回两线状态 + 生效 addon，供状态接口下发前端
 */
async function describe(shopId, member) {
  const addonFeatures = await getActiveAddonFeatures(shopId);
  return {
    pos: posState(member),
    purchase: purchaseState(member),
    coinRate: coinRateOf(member),
    addonFeatures
  };
}

module.exports = {
  POS_PAID,
  PURCHASE_PAID,
  posState,
  purchaseState,
  posRank,
  purchaseRank,
  hasPosFeature,
  hasPurchaseFeature,
  coinRateOf,
  canRedeemCoupon,
  getActiveAddonFeatures,
  describe
};
