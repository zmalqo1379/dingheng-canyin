const mongoose = require('mongoose');

// 零成本币兑小产品授权（2026-09 双产品线重构 · 阶段3）
// 商家用鼎恒币兑换限时小产品（如营销工具 7 天包、高级主题 30 天、智能预测 7 天包），
// 授权期内对应功能对该店铺开放；到期后由定时任务/惰性判定回收，不影响等级会员。
// 与会员线解耦：addon 只是"临时解锁某个 feature"，不改 purchaseLevel / memberLevel。
const addonEntitlementSchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    index: true
  },
  // 小产品标识（dhConfig.ADDONS[].key）
  addonKey: {
    type: String,
    required: true
  },
  // 该 addon 解锁的功能键列表（点餐线 posFeatures 或采购线 purchaseFeatures 中的 key，可多个）
  features: {
    type: [String],
    default: []
  },
  // 归属产品线：pos / purchase（决定用哪条线的权益表判定）
  productLine: {
    type: String,
    enum: ['pos', 'purchase'],
    default: 'pos'
  },
  startAt: {
    type: Date,
    default: Date.now
  },
  // 授权到期时间：判定 hasPosFeature/hasPurchaseFeature 时要求 expireAt > now
  expireAt: {
    type: Date,
    required: true,
    index: true
  },
  // 兑换所耗鼎恒币（用于流水对账）
  payCoin: {
    type: Number,
    default: 0,
    min: 0
  },
  // 关联的币流水记录 ID（可追溯）
  sourceCoinHistoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CoinHistory',
    default: null
  }
}, { timestamps: true });

// 按 shopId + addonKey 查询生效授权
addonEntitlementSchema.index({ shopId: 1, addonKey: 1 });

module.exports = mongoose.model('AddonEntitlement', addonEntitlementSchema);
