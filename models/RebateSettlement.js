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
  status: {
    type: String,
    enum: ['已结算'],
    default: '已结算'
  },
  settledAt: {
    type: Date,
    default: Date.now
  },
  remark: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// 同一供应商同一月份仅允许一条结算记录（幂等）
rebateSettlementSchema.index({ month: 1, supplierId: 1 }, { unique: true });

module.exports = mongoose.model('RebateSettlement', rebateSettlementSchema);
