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
