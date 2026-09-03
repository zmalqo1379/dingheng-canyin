const express = require('express');
const router = express.Router();

const SupplyProduct = require('../models/SupplyProduct');
const Supplier = require('../models/Supplier');
const coinRule = require('../utils/coinRule');
const { requireSupplier } = require('../middlewares/auth');

// 将商品文档转为商家可见视图：
//   - 附加 coinMultiplier（该品类得币倍率，用于商城「X 倍得币」激励展示）
//   - 剔除 rebateRate（供应商返点率属平台/供应商内部数据，商家不可见，更不能与倍率同屏出现）
function toMerchantView(product, multMap) {
  const obj = product.toObject ? product.toObject() : product;
  delete obj.rebateRate;
  obj.coinMultiplier = coinRule.multiplierFor(multMap, obj.category);
  return obj;
}

// ============ GET /api/supply-products ============
// 公开接口：商家浏览商品时可查看（保持公开，确保商家能看到商品）
// 可选 query: supplierId、status、category
// 同时 populate supplierId 取供应商名，保证前端 supplierId.name 可用
router.get('/', async (req, res) => {
  try {
    const { supplierId, status, category } = req.query;
    const filter = {};
    if (supplierId) filter.supplierId = supplierId;
    if (status) filter.status = status;
    if (category) filter.category = category;
    const products = await SupplyProduct.find(filter)
      .populate('supplierId', 'name')
      .sort({ createdAt: -1 });
    const multMap = await coinRule.getMultiplierMap();
    const data = products.map(p => toMerchantView(p, multMap));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/supply-products/:id ============
// 公开接口：查看单个商品详情，populate 供应商名，避免前端显示 undefined
router.get('/:id', async (req, res) => {
  try {
    const product = await SupplyProduct.findById(req.params.id).populate('supplierId', 'name');
    if (!product) {
      return res.status(404).json({ success: false, message: '商品不存在' });
    }
    const multMap = await coinRule.getMultiplierMap();
    res.json({ success: true, data: toMerchantView(product, multMap) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/supply-products ============
// 供应商新增商品：supplierId 必须取自 JWT，supplierName 自动回填
router.post('/', requireSupplier, async (req, res) => {
  try {
    const { name, category, unit, costPrice, marketPrice, rebateRate, stock, status, image, description } = req.body;
    if (!name || costPrice == null) {
      return res.status(400).json({ success: false, message: 'name、costPrice 不能为空' });
    }

    // 从 JWT 取当前供应商，杜绝前端伪造 supplierId
    const supplierId = req.user.supplierId;
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }

    const product = await SupplyProduct.create({
      name,
      category: category || '未分类',
      unit: unit || '个',
      costPrice: Number(costPrice),
      marketPrice: Number(marketPrice != null ? marketPrice : costPrice),
      rebateRate: rebateRate != null ? Number(rebateRate) : supplier.rebateRate,
      supplierId,
      supplierName: supplier.name,
      stock: stock != null ? Number(stock) : 0,
      status: status || '上架',
      image: image || '',
      description: description || ''
    });
    res.status(201).json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ PUT /api/supply-products/:id ============
// 供应商修改商品：只能改自己的商品
router.put('/:id', requireSupplier, async (req, res) => {
  try {
    const product = await SupplyProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: '商品不存在' });
    }
    // 归属校验：商品 supplierId 必须等于当前登录供应商
    if (String(product.supplierId) !== String(req.user.supplierId)) {
      return res.status(403).json({ success: false, message: '无权操作：只能管理自己的商品' });
    }

    // 允许更新的字段（supplierId/supplierName 不可改，防止转移商品归属）
    const allowed = ['name', 'category', 'unit', 'costPrice', 'marketPrice', 'rebateRate', 'stock', 'status', 'image', 'description'];
    const update = {};
    allowed.forEach(k => {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    });

    const updated = await SupplyProduct.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ DELETE /api/supply-products/:id ============
// 供应商删除商品：只能删自己的商品
router.delete('/:id', requireSupplier, async (req, res) => {
  try {
    const product = await SupplyProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: '商品不存在' });
    }
    if (String(product.supplierId) !== String(req.user.supplierId)) {
      return res.status(403).json({ success: false, message: '无权操作：只能管理自己的商品' });
    }
    await SupplyProduct.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
