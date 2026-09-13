const mongoose = require('mongoose');

// ============ 【已废弃】SplitRule 分账规则（平台自动加价率） ============
// 加价分销改造后，平台改为「手动填写卖价」（SupplyProduct.salePrice），
// 不再使用任何自动加价率规则。本模型不再参与任何金额计算，仅保留结构避免旧数据写入报错。
// 历史用途：供货价 × (1 + platformRate/100) = 零售价。
const splitRuleSchema = new mongoose.Schema({
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    default: null,
    index: true
  },
  category: {
    type: String,
    required: true,
    trim: true,
    default: '全部'
  },
  // 平台加价率（百分比，6 表示加价 6%）
  platformRate: {
    type: Number,
    default: 6,
    min: 0,
    max: 500
  },
  // 是否启用（false 时该规则不参与计算）
  enabled: {
    type: Boolean,
    default: true
  },
  remark: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// 同供应商（含 null 平台默认）同品类仅保留一条规则
splitRuleSchema.index({ supplierId: 1, category: 1 }, { unique: true });

module.exports = mongoose.model('SplitRule', splitRuleSchema);
