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
  }
}, { timestamps: true });

// 首月策略：商家注册（Member 创建）时自动开通基础版，赠送 30 天免费体验
//   memberLevel='basic' + memberIsTrial=true + memberExpire=30天后
//   基础版起即开放顾客积分（customerPointsEnabled=true）；币余额从 0 起，采购返币
memberSchema.pre('save', function (next) {
  if (this.isNew) {
    this.memberLevel = 'basic';
    this.memberIsTrial = true;
    this.memberExpire = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    this.customerPointsEnabled = true;
    this.totalEarnedCoin = 0;
    this.dinghengCoin = 0;
  }
  next();
});

module.exports = mongoose.model('Member', memberSchema);
