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
  // 基础版为 null；进阶/尊享为到期日
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
  // 是否开启顾客积分，进阶/尊享自动为 true
  customerPointsEnabled: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

// 首月赠送：商家注册（Member 创建）时自动升级为进阶版 30 天
memberSchema.pre('save', function (next) {
  if (this.isNew) {
    this.memberLevel = 'advanced';
    const expire = new Date();
    expire.setDate(expire.getDate() + 30);
    this.memberExpire = expire;
    this.customerPointsEnabled = true;
  }
  next();
});

module.exports = mongoose.model('Member', memberSchema);
