const mongoose = require('mongoose');

// 商家持有的采购抵用券
const couponSchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    index: true
  },
  type: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  faceValue: {
    type: Number,
    required: true,
    min: 0
  },
  // 满多少可用
  minOrder: {
    type: Number,
    default: 0,
    min: 0
  },
  // 券状态：unused=未使用 / locked=已锁定（下单草稿占用，30 分钟未支付自动释放回 unused）
  //          / used=已核销（支付成功后真正使用）/ expired=已过期
  status: {
    type: String,
    enum: ['unused', 'locked', 'used', 'expired'],
    default: 'unused'
  },
  // 锁定该券的订单 id（status=locked 时记录，支付成功后随核销写入 usedOrderId）
  lockedOrderId: {
    type: String,
    default: ''
  },
  // 锁定时间（用于 30 分钟超时释放判定）
  lockedAt: {
    type: Date,
    default: null
  },
  usedOrderId: {
    type: String,
    default: ''
  },
  // 使用时间（券被核销时记录）
  usedAt: {
    type: Date,
    default: null
  },
  // 创建时间 + 30 天
  expireDate: {
    type: Date,
    required: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Coupon', couponSchema);
