const mongoose = require('mongoose');

// 顾客储值账户（线下充值记账）
// 以 shopId + phone 定位一位顾客；商家在后台按手机号登记线下充值，按「充值送」活动赠送，
// 顾客点餐结算时可选用储值抵扣，下单后扣减余额。
const historyItemSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['recharge', 'bonus', 'consume'],
    required: true
  },
  // 正数为增加，负数为消耗
  amount: {
    type: Number,
    required: true
  },
  // 该笔变动后的余额
  balance: {
    type: Number,
    default: 0
  },
  orderId: {
    type: String,
    default: ''
  },
  note: {
    type: String,
    default: '',
    maxlength: 100
  },
  time: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const storedValueSchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  customerName: {
    type: String,
    default: '',
    trim: true,
    maxlength: 30
  },
  // 当前可用余额（实充 + 赠送 - 已消费）
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  // 累计实充金额（不含赠送）
  totalRecharged: {
    type: Number,
    default: 0,
    min: 0
  },
  // 累计赠送金额
  totalBonus: {
    type: Number,
    default: 0,
    min: 0
  },
  history: [historyItemSchema]
}, { timestamps: true });

// 同店同手机号唯一
storedValueSchema.index({ shopId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('StoredValue', storedValueSchema);
