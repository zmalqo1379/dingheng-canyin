const mongoose = require('mongoose');

// ============ PriceRule 品类定价规则 ============
// 按「供应商 + 品类」存储该供应商某品类的保鲜期天数。
// - supplierId=null 为平台全局预置规则（保鲜期默认值，预置品类见 utils/priceRule.js FRESH_PRESETS）
// - supplierId=<某供应商> 为该供应商对某品类的自定义规则（覆盖平台预置）
// 注：加价率（markupRate）已随智能定价停用，不再参与"建议售价"计算，仅保留字段兼容历史。
const priceRuleSchema = new mongoose.Schema({
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    default: null,
    index: true
  },
  // 品类名称（与 SupplyProduct.category 对应；预置品类如：叶菜/根茎茄果/鲜肉/冻品/米面粮油/干调/蛋/一次性用品/其他）
  category: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  // 【已废弃】品类默认加价率（百分比，0~500）：智能定价已停用，不再参与任何计算。
  markupRate: {
    type: Number,
    default: 20,
    min: 0
  },
  // 保鲜期天数：超过此天数未更新 priceUpdatedAt 即触发保鲜期保护（提醒→冻结→3 倍自动下架）
  freshDays: {
    type: Number,
    default: 7,
    min: 1
  }
}, { timestamps: true });

// 同供应商 + 同品类唯一（supplierId=null 代表平台预置，允许多品类各一条）
priceRuleSchema.index({ supplierId: 1, category: 1 }, { unique: true });

module.exports = mongoose.model('PriceRule', priceRuleSchema);
