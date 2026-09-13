const mongoose = require('mongoose');

// 商家库存：记录每个商家手里每个供应商品的当前库存余额。
// quantity 单位与采购商品（SupplyProduct.unit）一致；允许为负，负数表示欠料（急需补货）。
const shopInventorySchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true
  },
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SupplyProduct',
    required: true
  },
  quantity: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

// 同一商家 + 同一商品 唯一一条库存
shopInventorySchema.index({ shopId: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model('ShopInventory', shopInventorySchema);
