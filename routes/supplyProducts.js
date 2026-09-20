const express = require('express');
const router = express.Router();

const SupplyProduct = require('../models/SupplyProduct');
const Supplier = require('../models/Supplier');
const PriceCheck = require('../models/PriceCheck');
const coinRule = require('../utils/coinRule');
const split = require('../utils/split');
const jwt = require('jsonwebtoken');
const { requireSupplier, JWT_SECRET } = require('../middlewares/auth');

// 将商品文档转为商家可见视图：
//   - 附加 coinMultiplier（该品类得币倍率，用于商城「X 倍得币」激励展示）
//   - 剔除内部定价数据（返点率/加价率/供货价/旧零售价），商家只看到「卖价」
//   - 暴露 priceFrozen（保鲜期冻结时商城显示"价格更新中"且不可下单）
//   - 附加 salePrice：平台手动定价的卖价（未填则等于供货价）；商家按卖价下单
//   - 附加 pricingStatus：'priced' 已定价 / 'pending' 待定价（商城过滤依据）
function toMerchantView(product, multMap, refMap) {
  const obj = product.toObject ? product.toObject() : product;
  delete obj.rebateRate;   // 返点体系已停用
  delete obj.markupRate;   // 智能定价已停用
  delete obj.marketPrice;  // 旧零售价字段已废弃
  delete obj.costPrice;    // 供货价属供应商/平台内部数据，不向商家暴露
  obj.coinMultiplier = coinRule.multiplierFor(multMap, obj.category);
  // 商城可见的冻结标记（true 时前端展示"价格更新中"并禁用加入采购车）
  obj.priceFrozen = !!obj.priceFrozen;
  // 【2026-09 上线加固】判断是否已由平台手动定价：salePrice 为有效正数即为已定价
  // 未定价商品不出现在采购商城（详见 GET 列表/详情的过滤逻辑）
  const hasSalePrice = obj.salePrice != null && Number(obj.salePrice) > 0;
  obj.pricingStatus = hasSalePrice ? 'priced' : 'pending';
  // 商家应付单价 = 平台卖价（未填则等于供货价，但供货价已剔除，故用内部值计算）
  const sale = split.resolveSalePrice(product.salePrice, product.costPrice);
  obj.salePrice = sale;
  obj.unitPrice = sale;    // 兼容：商城前端按 unitPrice 计价
  // 附加外部参考价（比价工作台 PriceCheck），仅参考价>0 时返回，供商城展示"比市场省多少"
  const ref = refMap ? refMap.get(String(obj._id)) : null;
  if (ref && ref.refPrice > 0) {
    obj.refPrice = ref.refPrice;
    if (ref.source) obj.refSource = ref.source;
  }
  return obj;
}

// 批量查询商品的外部参考价，返回 productId -> {refPrice, source}
async function getRefPriceMap(productIds) {
  const ids = (productIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  const checks = await PriceCheck.find({ productId: { $in: ids } })
    .select('productId refPrice source')
    .lean();
  const map = new Map();
  for (const c of checks) {
    map.set(String(c.productId), { refPrice: Number(c.refPrice) || 0, source: c.source || '' });
  }
  return map;
}

// 软校验：判断请求是否携带供应商 JWT（公开接口不强制登录，仅用于切换返回视图）
function isSupplierRequest(req) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const parts = authHeader.split(' ');
    let token = '';
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }
    if (!token) return false;
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded && decoded.role === 'supplier';
  } catch (err) {
    return false;
  }
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
    // 供应商登录时只返回供货视图（剔除平台卖价/旧零售价/返点率/加价率）；
    // 其余（公开商城/商家/顾客）保持商家视图，按平台卖价展示/计价，无自动加价
    const supplierView = isSupplierRequest(req);
    const data = (supplierView ? visible : visible.filter(p => {
      // 【2026-09 上线加固】商家/顾客商城过滤：未定价（salePrice ≤ 0/null）商品不出现在采购商城
      // 卖价 = 0 时显示给商家会误以为「白送」，更会让顾客下出真 0 元订单，平台倒贴货款给供应商
      const hasSalePrice = p.salePrice != null && Number(p.salePrice) > 0;
      return hasSalePrice;
    })).map(p => supplierView ? toSupplierProductView(p) : toMerchantView(p, multMap));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/supply-products/mine ============
// 供应商查看自己的全部商品（需供应商登录）：不做采购商城可见性过滤，
// 未开通接单（资质核验中/未上传）时供应商仍可在控制台管理自己的商品。
// 返回走供应商视图：剔除平台卖价/旧零售价/返点率/加价率（平台商业机密），只保留供货价等自有数据。
function toSupplierProductView(product) {
  const obj = product.toObject ? product.toObject() : Object.assign({}, product);
  delete obj.salePrice;    // 平台卖价
  delete obj.marketPrice;  // 旧零售价（已废弃）
  delete obj.rebateRate;   // 旧返点率（已停用）
  delete obj.markupRate;   // 旧加价率（已停用）
  return obj;
}

router.get('/mine', requireSupplier, async (req, res) => {
  try {
    const products = await SupplyProduct.find({ supplierId: req.user.supplierId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: products.map(toSupplierProductView) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/supply-products/:id ============
// 公开接口：查看单个商品详情，populate 供应商名与治理状态
// 治理过滤：若供应商未通过审核/未签协议/未开通接单，商品不对外展示
// 【2026-09 上线加固】未定价（salePrice ≤ 0/null）的商品对商家/顾客视为「不存在」
//   返回 404，避免直链访问拿到 0 元商品详情
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
    // 商家/顾客视角下，未定价商品不可见（与列表过滤口径一致）
    const supplierView = isSupplierRequest(req);
    if (!supplierView) {
      const hasSalePrice = product.salePrice != null && Number(product.salePrice) > 0;
      if (!hasSalePrice) {
        return res.status(404).json({ success: false, message: '商品暂未上架' });
      }
    }
    const multMap = await coinRule.getMultiplierMap();
    const refMap = await getRefPriceMap([product._id]);
    res.json({ success: true, data: supplierView ? toSupplierProductView(product) : toMerchantView(product, multMap, refMap) });
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
    res.status(201).json({ success: true, data: toSupplierProductView(product) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/supply-products/batch（拍照上传商品 / 粘贴文字后一键新增）============
// 一单一单手打太慢：识别出来的清单在这里一次性落库。
// 规矩跟单个新增完全一样（同一道治理闸门、supplierId 只认 JWT），只是批量化。
// 同名商品自动跳过而不是报错 —— 识别难免有重复，别为一条重复把整批拦下来。
router.post('/batch', requireSupplier, async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: '没有要新增的商品' });
    }
    if (items.length > 200) {
      return res.status(400).json({ success: false, message: '一次最多新增 200 个商品，请分批来' });
    }

    const supplierId = req.user.supplierId;
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    if (supplier.status !== 'active') {
      return res.status(403).json({ success: false, message: '账号未通过审核，暂不可上架商品' });
    }
    if (!supplier.agreementSigned) {
      return res.status(403).json({ success: false, message: '请先签署合作协议后再上架商品' });
    }

    // 查重底表：库里已有的名字（去空格、忽略大小写）
    const exist = await SupplyProduct.find({ supplierId }).select('name');
    const seen = new Set(exist.map(p => String(p.name || '').replace(/\s/g, '').toLowerCase()));

    const created = [], skipped = [], failed = [];
    for (const raw of items) {
      const name = String((raw && raw.name) || '').trim();
      if (!name) { failed.push({ name: '（空行）', reason: '商品名为空' }); continue; }
      const key = name.replace(/\s/g, '').toLowerCase();
      if (seen.has(key)) { skipped.push({ name, reason: '已经有同名商品了' }); continue; }
      const costPrice = Number(raw && raw.costPrice);
      if (!isFinite(costPrice) || costPrice <= 0) { failed.push({ name, reason: '还没填供货价' }); continue; }

      const product = await SupplyProduct.create({
        name,
        category: (raw && raw.category) || '未分类',
        unit: (raw && raw.unit) || '个',
        costPrice: Number(costPrice),
        marketPrice: Number(costPrice), // 已废弃字段，仅为满足历史 required
        supplierId,
        supplierName: supplier.name,
        stock: (raw && raw.stock != null && isFinite(Number(raw.stock))) ? Math.max(0, Number(raw.stock)) : 0,
        status: '上架',
        image: (raw && raw.image) || '',
        description: (raw && raw.description) || '',
        grade: ['standard', 'premium'].includes(raw && raw.grade) ? raw.grade : null,
        parentProductId: null,
        priceUpdatedAt: new Date()
      });
      seen.add(key);   // 本批里再出现同名也跳过
      created.push(toSupplierProductView(product));
    }

    res.status(201).json({
      success: true,
      data: { created, skipped, failed, count: created.length },
      message: `已新增 ${created.length} 个` + (skipped.length ? `，跳过 ${skipped.length} 个同名` : '') + (failed.length ? `，${failed.length} 个缺供货价` : '')
    });
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
    res.json({ success: true, data: toSupplierProductView(updated) });
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
