const mongoose = require('mongoose');

// 月度结算的分品类明细
const settlementDetailSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true
  },
  // 该品类当月已完成采购总额（订单原价口径）
  purchaseAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 该品类实际返点金额
  rebateAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 结算适用综合费率（返点/采购额；全额累进=命中档费率，超额累进=加权综合费率，无规则=默认兜底率）
  rate: {
    type: Number,
    default: 0,
    min: 0,
    max: 1
  },
  // 命中档位门槛（未达第一档或无规则时为 null）
  tierMinAmount: {
    type: Number,
    default: null
  },
  // 计费方式（mode）：full=全额累进 / marginal=超额累进 / default=无规则默认兜底
  mode: {
    type: String,
    enum: ['full', 'marginal', 'default'],
    default: 'default'
  },
  // 毛利分档（仅 byCategory 模式有意义）：
  //   unified=统一模式整单汇总；lowMargin=低毛利；midMargin=中毛利；highMargin=高毛利
  // 历史数据无该字段时按 'unified' 兜底读取
  marginType: {
    type: String,
    enum: ['unified', 'lowMargin', 'midMargin', 'highMargin'],
    default: 'unified'
  }
}, { _id: false });

// 供应商月度返点结算记录（每月每供应商一条）
const rebateSettlementSchema = new mongoose.Schema({
  // 结算月份 YYYY-MM
  month: {
    type: String,
    required: true,
    index: true
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
  // 结算时供应商采用的返点模式：unified=统一全品类阶梯 / byCategory=按品类分类阶梯
  // 历史数据无该字段时按 'unified' 兜底读取
  rebateMode: {
    type: String,
    enum: ['unified', 'byCategory'],
    default: 'unified'
  },
  // 当月已完成采购总额（全品类合计）
  totalPurchaseAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 当月实际返点合计（结算后计入供应商应付余额）
  totalRebateAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  details: {
    type: [settlementDetailSchema],
    default: []
  },
  // 结算单状态流：待结算（生成即此态）→ 已确认（开发者确认）→ 已收款（开发者标记已收款）
  // 兼容历史数据：旧记录可能为 '已结算'，读取时按 '已确认' 兜底展示
  status: {
    type: String,
    enum: ['待结算', '已确认', '已收款', '已结算'],
    default: '待结算',
    index: true
  },
  settledAt: {
    type: Date,
    default: Date.now
  },
  // 开发者确认时间（status → 已确认）
  confirmedAt: {
    type: Date,
    default: null
  },
  // 开发者标记已收款时间（status → 已收款）
  paidAt: {
    type: Date,
    default: null
  },
  // 是否逾期（超过 15 天未"已收款"），由接口实时计算，不入库
  remark: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// 同一供应商同一月份仅允许一条结算记录（幂等）
rebateSettlementSchema.index({ month: 1, supplierId: 1 }, { unique: true });

module.exports = mongoose.model('RebateSettlement', rebateSettlementSchema);
