const mongoose = require('mongoose');

// ============ 【已废弃】SplitRecord 分账记录 ============
// 加价分销改造后，分账状态/金额/流水号等权威字段统一落在 PurchaseOrder 上，
// 本集合不再写入、不再参与任何计算，仅保留结构避免旧数据写入报错。
// 开发者平台收入 / 供应商分账视图改为直接聚合 PurchaseOrder。
const splitRecordSchema = new mongoose.Schema({
  orderNo: {
    type: String,
    required: true
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PurchaseOrder',
    default: null
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true,
    index: true
  },
  supplierName: {
    type: String,
    default: ''
  },
  shopId: {
    type: String,
    required: true,
    index: true
  },
  shopName: {
    type: String,
    default: ''
  },
  // 零售总额（商家应付口径，按实称重量重算）
  retailAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 供货价总额（供应商应得分账部分）
  supplyAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 平台差价 = 零售总额 - 供货价总额
  platformAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 本单综合加价率快照（小数，0.06 = 6%；仅用于展示，不参与计算）
  platformRate: {
    type: Number,
    default: 0,
    min: 0
  },
  // 分账状态：待结算 / 已结算（本次仅账务标记，不代表真实资金到账）
  status: {
    type: String,
    enum: ['待结算', '已结算'],
    default: '待结算',
    index: true
  },
  // 归属月份 YYYY-MM（按订单完成时间）
  month: {
    type: String,
    default: '',
    index: true
  },
  orderCompletedAt: {
    type: Date,
    default: null
  },
  settledAt: {
    type: Date,
    default: null
  },
  // ============ 预留：未来接入微信支付分账 ============
  transactionId: {
    type: String,
    default: ''
  },
  channelStatus: {
    type: String,
    default: ''
  },
  channelRemark: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// 每笔订单仅一条分账记录（幂等）
splitRecordSchema.index({ orderNo: 1 }, { unique: true });
// 按供应商 + 月份统计「我的分账」
splitRecordSchema.index({ supplierId: 1, month: 1 });

module.exports = mongoose.model('SplitRecord', splitRecordSchema);
