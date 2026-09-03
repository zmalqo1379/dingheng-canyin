const mongoose = require('mongoose');

// 鼎恒币「品类得币倍率」规则（开发者在控制台配置，倍率唯一权威数据源）
// 商家采购确认收货发币时：每行商品金额 × 会员返币率 × 该品类倍率，逐行汇总
const coinRuleSchema = new mongoose.Schema({
  // 品类名称（与 SupplyProduct.category 对应）；'其他' 作为未配置品类的兜底
  category: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  // 得币倍率：1 = 按基础返币率发币，2 = 该品类得币翻倍；默认 1
  multiplier: {
    type: Number,
    default: 1,
    min: 0,
    max: 10
  },
  // 是否启用（false 时该品类按 1 倍处理，并继续回退「其他」兜底）
  enabled: {
    type: Boolean,
    default: true
  },
  remark: {
    type: String,
    default: ''
  }
}, { timestamps: true });

module.exports = mongoose.model('CoinRule', coinRuleSchema);
