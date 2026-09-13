const mongoose = require('mongoose');

// 比价工作台：记录某个在售商品的外部参考价（如美菜价），供开发者后台与平台售价对比
// 每个商品保留一条最新记录（productId 唯一），由开发者后台录入/更新
const priceCheckSchema = new mongoose.Schema({
  // 被比价的在售商品（SupplyProduct）
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SupplyProduct',
    required: true,
    unique: true,
    index: true
  },
  // 外部参考价（元/单位），如美菜同品价格
  refPrice: {
    type: Number,
    required: true,
    min: 0
  },
  // 参考来源（如"美菜"、"快驴"、手工调研等）
  source: {
    type: String,
    default: '',
    trim: true,
    maxlength: 100
  },
  // 参考价采集日期
  checkDate: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

module.exports = mongoose.model('PriceCheck', priceCheckSchema);
