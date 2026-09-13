const express = require('express');
const router = express.Router();

const SupplyProduct = require('../models/SupplyProduct');
const Supplier = require('../models/Supplier');
const coinRule = require('../utils/coinRule');
const split = require('../utils/split');
const { requireSupplier } = require('../middlewares/auth');

// 将商品文档转为商家可见视图：
//   - 附加 coinMultiplier（该品类得币倍率，用于商城「X 倍得币」激励展示）
//   - 剔除内部定价数据（返点率/加价率/供货价/旧零售价），商家只看到「卖价」
//   - 暴露 priceFrozen（保鲜期冻结时商城显示"价格更新中"且不可下单）
//   - 附加 salePrice：平台手动定价的卖价（未填则等于供货价）；商家按卖价下单
function toMerchantView(product, multMap) {
  const obj = product.toObject ? product.toObject() : product;
  delete obj.rebateRate;   // 返点体系已停用
  delete obj.markupRate;   // 智能定价已停用
  delete obj.marketPrice;  // 旧零售价字段已废弃
  delete obj.costPrice;    // 供货价属供应商/平台内部数据，不向商家暴露
  obj.coinMultiplier = coinRule.multiplierFor(multMap, obj.category);
  // 商城可见的冻结标记（true 时前端展示"价格更新中"并禁用加入采购车）
  obj.priceFrozen = !!obj.priceFrozen;
  // 商家应付单价 = 平台卖价（未填则等于供货价，但供货价已剔除，故用内部值计算）
  const sale = split.resolveSalePrice(product.salePrice, product.costPrice);
  obj.salePrice = sale;
  obj.unitPrice = sale;    // 兼容：商城前端按 unitPrice 计价
  return obj;
}

// ============ GET /api/supply-products ============
// 公开接口：商家浏览商品时可查看
// 治理过滤：仅展示 status=active && agreementSigned && orderEnabled 的供应商的商品
//   未通过审核/未签协议/未开通接单/冻结 的供应商商品不在采购商城出现
// 可选 query: supplierId、status、category
router.get('/', async (req, res) => {
  try {
    const { supplierId, status, category } = req.query;
    const filter = {};
    if (supplierId) filter.supplierId = supplierId;
    if (status) filter.status = status;
    if (category) filter.category = category;
    const products = await SupplyProduct.find(filter)
      .populate('supplierId', 'name status agreementSigned orderEnabled')
      .sort({ createdAt: -1 })
      .lean();
    // 治理过滤：仅保留已通过审核 + 已签协议 + 已开通接单的供应商的商品
    const visible = products.filter(p => {
      const s = p.supplierId;
      if (!s) return false;
      return s.status === 'active' && s.agreementSigned === true && s.orderEnabled === true;
    });
    const multMap = await coinRule.getMultiplierMap();
    // 商家视图：直接按平台卖价（未填=供货价）展示/计价，无自动加价
    const data = visible.map(p => toMerchantView(p, multMap));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/supply-products/mine ============
// 供应商查看自己的全部商品（需供应商登录）：不做采购商城可见性过滤，
// 未开通接单（资质核验中/未上传）时供应商仍可在控制台管理自己的商品。
router.get('/mine', requireSupplier, async (req, res) => {
  try {
    const products = await SupplyProduct.find({ supplierId: req.user.supplierId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/supply-products/:id ============
// 公开接口：查看单个商品详情，populate 供应商名与治理状态
// 治理过滤：若供应商未通过审核/未签协议/未开通接单，商品不对外展示
router.get('/:id', async (req, res) => {
  try {
    const product = await SupplyProduct.findById(req.params.id).populate('supplierId', 'name status agreementSigned orderEnabled');
    if (!product) {
      return res.status(404).json({ success: false, message: '商品不存在' });
    }
    const s = product.supplierId;
    if (!s || s.status !== 'active' || !s.agreementSigned || !s.orderEnabled) {
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
// 治理门槛（"一道闸门"流程）：status=active && agreementSigned 即可上架/管理商品；
// 商品仅在 orderEnabled=true（资质核验通过）后才出现在采购商城——接单上线由商城过滤与下单接口把关。
router.post('/', requireSupplier, async (req, res) => {
  try {
    const { name, category, unit, costPrice, stock, status, image, description, grade, parentProductId } = req.body;
    if (!name || costPrice == null) {
      return res.status(400).json({ success: false, message: 'name、costPrice 不能为空' });
    }

    // 从 JWT 取当前供应商，杜绝前端伪造 supplierId
    const supplierId = req.user.supplierId;
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    // 治理门槛校验：审核通过 + 签署协议即可管理商品；未开通接单时商品不对采购商城可见
    if (supplier.status !== 'active') {
      return res.status(403).json({ success: false, message: '账号未通过审核，暂不可上架商品' });
    }
    if (!supplier.agreementSigned) {
      return res.status(403).json({ success: false, message: '请先签署合作协议后再上架商品' });
    }
    // 双档次关联校验：parentProductId 必须存在且属于当前供应商
    let parentProd = null;
    if (parentProductId) {
      parentProd = await SupplyProduct.findById(parentProductId);
      if (!parentProd) {
        return res.status(400).json({ success: false, message: '关联主品不存在' });
      }
      if (String(parentProd.supplierId) !== String(supplierId)) {
        return res.status(403).json({ success: false, message: '关联主品不属于当前供应商' });
      }
    }
    // 商品上下架状态按供应商提交保存；未开通接单时商城侧按供应商 orderEnabled 整体过滤，
    // 开通接单后"上架"商品自动出现在采购商城，无需供应商重复操作。
    const product = await SupplyProduct.create({
      name,
      category: category || '未分类',
      unit: unit || '个',
      // 供货价由供应商维护；卖价 salePrice 由平台在定价工作台手动填写（默认 null=不加价）
      costPrice: Number(costPrice),
      marketPrice: Number(costPrice), // 已废弃字段，仅为满足历史 required
      supplierId,
      supplierName: supplier.name,
      stock: stock != null ? Number(stock) : 0,
      status: status || '上架',
      image: image || '',
      description: description || '',
      grade: ['standard', 'premium'].includes(grade) ? grade : null,
      parentProductId: parentProd ? parentProd._id : null,
      priceUpdatedAt: new Date()
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
    // 注意：卖价 salePrice 由平台手动维护，供应商不可改；返点率/加价率/旧零售价已停用
    const allowed = ['name', 'category', 'unit', 'costPrice', 'stock', 'status', 'image', 'description', 'grade', 'parentProductId'];
    const update = {};
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        if (k === 'grade') {
          update[k] = ['standard', 'premium'].includes(req.body[k]) ? req.body[k] : null;
        } else if (k === 'parentProductId') {
          update[k] = req.body[k] || null;
        } else {
          update[k] = req.body[k];
        }
      }
    });
    // 供应商更新供货价：刷新改价时间（供保鲜期保护与平台定价工作台提示）
    if (update.costPrice !== undefined) {
      update.costPrice = Number(update.costPrice);
      update.priceUpdatedAt = new Date();
      update.marketPrice = update.costPrice; // 已废弃字段同步，仅为兼容历史
    }

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
