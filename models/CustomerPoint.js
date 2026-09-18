const mongoose = require('mongoose');

// 顾客积分（食客积分，进阶版权益）
// 以 shopId + phone 定位一位顾客；下单填手机号即按实付金额自动累计
// history 记录流水：earn 消费获得 / deduct 下单抵现 / redeem 兑换菜品
const historyItemSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['earn', 'deduct', 'redeem', 'expired'],
    required: true
  },
  // 正数为增加，负数为消耗
  amount: {
    type: Number,
    required: true
  },
  // 该笔变动后的余额（便于顾客端回显）
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

// 积分批次：每笔获得积分单独记录，用于「先得先过期」FIFO 扣减与到期清零
const pointBatchSchema = new mongoose.Schema({
  // 该批次原始获得积分
  points: {
    type: Number,
    default: 0,
    min: 0
  },
  // 该批次剩余可用积分
  remaining: {
    type: Number,
    default: 0,
    min: 0
  },
  earnedAt: {
    type: Date,
    default: Date.now
  },
  // 过期时间（permanent 模式为 null）
  expireAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const customerPointSchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true
  },
  // 顾客手机号（下单时选填，填了才积积分）
  phone: {
    type: String,
    required: true,
    trim: true
  },
  // 当前可用积分
  points: {
    type: Number,
    default: 0,
    min: 0
  },
  // 累计获得积分（只增不减）
  totalEarned: {
    type: Number,
    default: 0
  },
  // 积分批次（FIFO 扣减与到期清零依据）；老数据无此字段视为永久有效
  batches: [pointBatchSchema],
  history: [historyItemSchema]
}, { timestamps: true });

// 同店同手机号唯一
customerPointSchema.index({ shopId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('CustomerPoint', customerPointSchema);
