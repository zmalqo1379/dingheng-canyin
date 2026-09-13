const mongoose = require('mongoose');
const dhConfig = require('../utils/dhConfig');

// 商家会员与鼎恒币账户（每个店铺一条）
const memberSchema = new mongoose.Schema({
  // shopId 用 String，与现有 PurchaseOrder/ShopAccount 保持一致
  shopId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  shopName: {
    type: String,
    default: ''
  },
  memberLevel: {
    type: String,
    enum: ['basic', 'advanced', 'premium'],
    default: 'basic'
  },
  // 会员到期日：基础版（体验/月卡）/进阶/尊享有效内为到期日；失活（未开通/过期）为 null
  memberExpire: {
    type: Date,
    default: null
  },
  // 当前可用余额。普通扣减（兑换）不足则拒绝；退款扣回允许为负（下次发币优先补齐）
  // 故此处不加 min 约束，由业务层在兑换时校验 dinghengCoin >= coinCost
  dinghengCoin: {
    type: Number,
    default: 0
  },
  // 累计获得，只增不减，用于统计
  totalEarnedCoin: {
    type: Number,
    default: 0,
    min: 0
  },
  // 是否开启顾客积分：基础版起开放（新注册即 true）；会员过期失活后由定时任务置 false
  customerPointsEnabled: {
    type: Boolean,
    default: false
  },
  // 是否为注册赠送的首月体验期（基础版 30 天免费体验，前端据此显示倒计时提示条）
  memberIsTrial: {
    type: Boolean,
    default: false
  },
  // 会员开通/续费的支付方式，未来现金支付接口接入后扩展使用
  // coin = 鼎恒币兑换（默认），cash = 人民币购买
  memberSource: {
    type: String,
    enum: ['coin', 'cash'],
    default: 'coin'
  },

  // ============ 采购线（2026-09 双产品线重构） ============
  // 采购线独立于点餐线：free 永久免费；plus/pro 付费。
  // 两线互不锁定：只买点餐或只买采购，系统均完整可用。
  purchaseLevel: {
    type: String,
    enum: ['free', 'plus', 'pro'],
    default: 'free'
  },
  // 采购线到期日：付费档有效期内为到期日；free / 已过期均为 null
  purchaseExpire: {
    type: Date,
    default: null
  },
  // 采购线首月体验标记（赠 30 天 plus 体验时 true）
  purchaseIsTrial: {
    type: Boolean,
    default: false
  },
  // 采购线开通/续费支付方式：coin / cash / wechat
  purchaseSource: {
    type: String,
    default: 'coin'
  }
}, { timestamps: true });

// 首月策略（双产品线版）：商家注册（Member 创建）时同时赠送 30 天体验
//   点餐线：memberLevel='advanced' + memberExpire=30天后 + memberIsTrial=true
//   采购线：purchaseLevel='plus'   + purchaseExpire=30天后 + purchaseIsTrial=true
//   到期后由定时任务回落：点餐→basic（永久免费）、采购→free（永久免费）
//   顾客积分自基础版起开放（customerPointsEnabled=true）；币余额从 0 起，靠采购返币
memberSchema.pre('save', function (next) {
  if (this.isNew) {
    const expire = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    this.memberLevel = 'advanced';
    this.memberIsTrial = true;
    this.memberExpire = expire;
    this.purchaseLevel = 'plus';
    this.purchaseIsTrial = true;
    this.purchaseExpire = expire;
    this.customerPointsEnabled = true;
    this.totalEarnedCoin = 0;
    this.dinghengCoin = 0;
  }
  next();
});

module.exports = mongoose.model('Member', memberSchema);
