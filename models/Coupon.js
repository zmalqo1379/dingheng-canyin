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
  status: {
    type: String,
    enum: ['unused', 'used', 'expired'],
    default: 'unused'
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
