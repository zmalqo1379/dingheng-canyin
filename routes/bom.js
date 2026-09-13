const express = require('express');
const router = express.Router();

const DishBom = require('../models/DishBom');
const { requireMerchant } = require('../middlewares/auth');

// ============ 菜品→食材配方（BOM）管理 ============
// 同一商家下每道菜一条配方（shopId + dishName 唯一）。
// items 中的 quantity 单位与采购商品（SupplyProduct.unit）一致，由商家录入时自行保证。

// 1) GET /api/admin/bom 列出当前商家全部配方（含食材名/单位）
router.get('/', requireMerchant, async (req, res) => {
  try {
    const list = await DishBom.find({ shopId: req.shopId })
      .populate('items.productId', 'name unit')
      .sort({ dishName: 1 })
      .lean();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2) POST /api/admin/bom 创建/更新配方（upsert）
// body: { dishName, items: [{ productId, quantity }] }
router.post('/', requireMerchant, async (req, res) => {
  try {
    const { dishName, items } = req.body;
    if (!dishName || !String(dishName).trim()) {
      return res.status(400).json({ success: false, message: 'dishName 不能为空' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: '配方至少包含一个食材' });
    }
    for (const it of items) {
      if (!it.productId || !(Number(it.quantity) >= 0)) {
        return res.status(400).json({ success: false, message: '每个配方项需包含 productId 和 quantity' });
      }
    }
    const cleanItems = items.map((it) => ({
      productId: it.productId,
      quantity: Number(it.quantity)
    }));
    const bom = await DishBom.findOneAndUpdate(
      { shopId: req.shopId, dishName: String(dishName).trim() },
      { $set: { items: cleanItems } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, data: bom });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3) DELETE /api/admin/bom/:dishName 删除配方
router.delete('/:dishName', requireMerchant, async (req, res) => {
  try {
    const dishName = decodeURIComponent(req.params.dishName);
    const bom = await DishBom.findOneAndDelete({ shopId: req.shopId, dishName });
    if (!bom) return res.status(404).json({ success: false, message: '配方不存在' });
    res.json({ success: true, message: '已删除' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
