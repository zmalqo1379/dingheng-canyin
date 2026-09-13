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
  // 商家视角单价 = 平台卖价（salePrice），顾客/商家按此计价，保留 unitPrice 字段名兼容旧前端
  unitPrice: {
    type: Number,
    required: true,
    min: 0
  },
  // 商家应付的卖价小计 = salePrice × quantity
  totalPrice: {
    type: Number,
    required: true,
    min: 0
  },
  // ============ 分账：供货价单价 / 卖价单价（两笔拆账的数据基础） ============
  // 供货单价（供应商实收单价，下单时取自 SupplyProduct.costPrice）
  supplyPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  // 卖价单价（平台手动定价，下单时取自 SupplyProduct.salePrice；未填则等于供货价）
  salePrice: {
    type: Number,
    default: 0,
    min: 0
  },
  // 【已废弃】retailPrice 旧名，等价于 salePrice，仅为兼容历史数据保留
  retailPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  // 供货价小计（供应商应得分账部分）= supplyPrice × quantity
  supplyLineTotal: {
    type: Number,
    default: 0,
    min: 0
  },
  // 卖价小计（顾客应付部分）= salePrice × quantity
  saleLineTotal: {
    type: Number,
    default: 0,
    min: 0
  },
  // 【已废弃】下单时的平台加价率快照，手动定价后不再计算，仅为兼容历史数据保留
  platformRate: {
    type: Number,
    default: 0,
    min: 0
  },
  // ============ 分拣过秤：按实称结算 ============
  // 实称重量（kg），分拣过秤时由供应商逐行写入；未过秤默认 0
  actualWeight: {
    type: Number,
    default: 0,
    min: 0
  },
  // 是否已过秤（逐行标记；全行 weighed=true 时订单标记 sorted）
  weighed: {
    type: Boolean,
    default: false
  },
  // 实称后该行卖价小计（=actualWeight×salePrice；未称重沿用 totalPrice），用于重算订单总额
  actualLineTotal: {
    type: Number,
    default: 0,
    min: 0
  },
  // 实称后该行供货价小计（=actualWeight×supplyPrice；未称重沿用 supplyLineTotal），用于分账
  actualSupplyLineTotal: {
    type: Number,
    default: 0,
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
  // 卖价总额（顾客应付口径）= Σ saleLineTotal（过秤后按实称重算）
  totalAmount: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  // ============ 分账快照：卖价总额 / 供货价总额 / 平台差价 ============
  // 供货价总额（供应商应得分账部分，= Σ supplyLineTotal/actualSupplyLineTotal）
  supplyAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 平台差价 = 卖价总额 - 供货价总额（未扣券；券成本由平台实得承担，见 platformShare）
  platformAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 【已废弃】本单综合平台加价率快照；手动定价后不再计算
  platformRate: {
    type: Number,
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
  // ============ 云分账：金额口径（单位：元，计算按分整数） ============
  // 恒等式：supplierShare + platformShare ≡ splitAmount（= 顾客实付）
  //   顾客实付 splitAmount = 卖价总额 - 券抵扣（过秤后按实称重算）
  //   供应商实得 supplierShare = Σ 供货价 × 数量（券成本不由供应商承担）
  //   平台实得 platformShare = splitAmount - supplierShare
  splitAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  supplierShare: {
    type: Number,
    default: 0,
    min: 0
  },
  platformShare: {
    type: Number,
    default: 0,
    min: 0
  },
  // ============ 云分账：状态机 ============
  // 待分账 →（发起）已发起分账 →（成功）分账成功
  //                        ↘（失败）分账失败 → 重试（splitRetryCount ++）
  // 过秤差额 ≠ 0 → 补差中 → 已补差
  splitStatus: {
    type: String,
    enum: ['待分账', '已发起分账', '分账成功', '分账失败', '补差中', '已补差'],
    default: '待分账',
    index: true
  },
  // 分账流水号（渠道分账单号，发起分账时生成）
  splitNo: {
    type: String,
    default: ''
  },
  // 渠道分账订单号（微信支付分账 order_id）
  channelSplitOrderId: {
    type: String,
    default: ''
  },
  splitAt: {
    type: Date,
    default: null
  },
  // 分账失败重试次数
  splitRetryCount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 最近一次分账失败原因
  splitError: {
    type: String,
    default: ''
  },
  // 分账操作日志（发起/回调/重试/补差，便于排障）
  splitLogs: {
    type: Array,
    default: []
  },
  // ============ 过秤补差 ============
  // 补差金额（元，正=实际多于下单需补收，负=实际少于下单需退款）；只与数量差异相关，与价格无关
  compensateAmount: {
    type: Number,
    default: 0
  },
  // 补差中分给供应商的部分（= 供货价单价 × 数量差）
  compensateSupplierShare: {
    type: Number,
    default: 0
  },
  // 补差中分给平台的部分（= (卖价-供货价) × 数量差；退款时为负）
  compensatePlatformShare: {
    type: Number,
    default: 0
  },
  // 补差流水号
  compensateNo: {
    type: String,
    default: ''
  },
  compensateAt: {
    type: Date,
    default: null
  },
  // ============ 支付（走支付抽象层，下单收款） ============
  // 支付单号（本地生成，传给支付渠道）
  payNo: {
    type: String,
    default: ''
  },
  // 支付状态：unpaid=待支付 / paid=已支付 / refunded=已退款
  payStatus: {
    type: String,
    enum: ['unpaid', 'paid', 'refunded'],
    default: 'unpaid'
  },
  // 渠道支付流水号（微信 transaction_id）
  transactionId: {
    type: String,
    default: ''
  },
  paidAt: {
    type: Date,
    default: null
  },
  // ============ 【已废弃】返点体系字段（返点已停用，不再写入/计算，仅保留结构） ============
  rebateAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  preRebate: {
    type: Number,
    default: 0,
    min: 0
  },
  preRebateRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 1
  },
  actualRebateAmount: {
    type: Number,
    default: null,
    min: 0
  },
  rebateMonth: {
    type: String,
    default: ''
  },
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
  },
  // ============ 囤货保护：量异常标记 ============
  // anomalyFlag=true 时供应商后台订单列表标红并加"量异常"标签
  anomalyFlag: {
    type: Boolean,
    default: false,
    index: true
  },
  // 触发量异常的商品明细（productId/name/quantity/七天总量/兜底常量倍数）
  anomalyItems: {
    type: Array,
    default: []
  },
  // ============ 跌价预警标记 ============
  // 本单存在"最终售价比近 7 日均价低超 15%"的商品时为 true（保存时需二次确认）
  priceDropWarning: {
    type: Boolean,
    default: false
  },
  // 跌价预警商品明细（productId/name/unitPrice/近7日均价/跌幅比例）
  priceDropItems: {
    type: Array,
    default: []
  },
  // ============ 分拣过秤标记 ============
  // 全部行 weighed=true 时自动置 true（不影响 status，仍处"已确认"待发货）
  sorted: {
    type: Boolean,
    default: false,
    index: true
  },
  // 分拣完成时间
  sortedAt: {
    type: Date,
    default: null
  },
  // ============ 配送送达 ============
  // 送达照片 URL（从 /api/supplier/upload 返回的相对路径），供应商拍照送达后写入
  deliveryPhotoUrl: {
    type: String,
    default: ''
  },
  // 送达时间（拍照送达时写入，商家可在订单详情看到）
  deliveredAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
