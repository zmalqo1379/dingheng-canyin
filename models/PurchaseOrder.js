const mongoose = require('mongoose');

const purchaseItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SupplyProduct',
    required: true
  },
  name: {
    type: String,
    required: true
  },
  // 品类快照（下单时取自 SupplyProduct.category，用于分品类返点统计；老订单为空时按 productId 回查商品库）
  category: {
    type: String,
    default: ''
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  unitPrice: {
    type: Number,
    required: true,
    min: 0
  },
  totalPrice: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false });

const purchaseOrderSchema = new mongoose.Schema({
  orderNo: {
    type: String,
    required: true,
    unique: true
  },
  shopId: {
    type: String,
    required: true
  },
  shopName: {
    type: String,
    default: ''
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  items: [purchaseItemSchema],
  totalAmount: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['待确认', '已确认', '已发货', '已收货', '已完成'],
    default: '待确认'
  },
  confirmAt: {
    type: Date,
    default: null
  },
  deliverAt: {
    type: Date,
    default: null
  },
  receiveAt: {
    type: Date,
    default: null
  },
  // 返点金额（兼容字段：新流程下等于完成时的预估返点 preRebate）
  rebateAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 预估返点：订单完成时按「当月该供应商分品类累计额」实时定档计算的本单返点（预估口径，月度结算前可变）
  preRebate: {
    type: Number,
    default: 0,
    min: 0
  },
  // 预估返点综合费率快照（preRebate/订单原价，仅用于展示，不参与计算）
  preRebateRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 1
  },
  // 实际返点：月度结算后按结算口径回写（结算前为 null）
  actualRebateAmount: {
    type: Number,
    default: null,
    min: 0
  },
  // 返点归属月份 YYYY-MM（按确认收货完成时间）
  rebateMonth: {
    type: String,
    default: ''
  },
  // 该单返点是否已随月度结算入账
  rebateSettled: {
    type: Boolean,
    default: false
  },
  pointsGenerated: {
    type: Number,
    default: 0,
    min: 0
  },
  // 本单发放的鼎恒币（用于退款扣回）
  rewardCoin: {
    type: Number,
    default: 0,
    min: 0
  },
  // 已使用的抵用券（每单限用一张，不可叠加）
  appliedCouponId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Coupon',
    default: null
  },
  // 用券抵扣金额
  discountAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 实际应付 = totalAmount - discountAmount
  actualPayAmount: {
    type: Number,
    default: 0,
    min: 0
  }
}, { timestamps: true });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
