const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  dishName: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  // 菜品分类（可选，用于按品类应用折扣）
  category: {
    type: String,
    default: ''
  }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  tableNumber: {
    type: String,
    required: true
  },
  items: [orderItemSchema],
  // 实付金额（已应用满减/折扣后的最终金额）
  totalPrice: {
    type: Number,
    required: true,
    default: 0
  },
  // 优惠前原价合计
  originalTotal: {
    type: Number,
    default: 0
  },
  // 优惠总金额（折扣让利 + 满减）
  discountAmount: {
    type: Number,
    default: 0
  },
  // 优惠明细：{ itemDiscount, fullReduction, appliedRules: [...] }
  discountDetail: {
    type: Object,
    default: null
  },
  remark: {
    type: String,
    default: '',
    maxlength: 200
  },
  // 订单类型：normal 正常点单 / pointsRedeem 积分换菜（0 元单进后厨）
  orderType: {
    type: String,
    enum: ['normal', 'pointsRedeem'],
    default: 'normal'
  },
  // 顾客手机号（选填，用于积分累计；未填为空）
  customerPhone: {
    type: String,
    default: '',
    trim: true
  },
  // 本单使用的抵现积分数量
  pointsUsed: {
    type: Number,
    default: 0,
    min: 0
  },
  // 积分抵现金额（元）
  pointsDiscount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 本单累计获得的积分（成功页播报用）
  pointsEarned: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'completed'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
