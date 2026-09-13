const mongoose = require('mongoose');

// 菜品→食材配方（BOM）：记录一道菜消耗哪些供应商品、各消耗多少。
// quantity 的单位与采购商品（SupplyProduct.unit）保持一致，由商家录入时自行保证。
const dishBomItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SupplyProduct',
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false });

const dishBomSchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true
  },
  dishName: {
    type: String,
    required: true,
    trim: true
  },
  items: [dishBomItemSchema]
}, { timestamps: true });

// 同一商家下每道菜一条配方
dishBomSchema.index({ shopId: 1, dishName: 1 }, { unique: true });

module.exports = mongoose.model('DishBom', dishBomSchema);
