const express = require('express');
const router = express.Router();

const SupplyProduct = require('../models/SupplyProduct');
const priceRuleUtil = require('../utils/priceRule');
const freshnessCheck = require('../utils/freshnessCheck');
const { requireSupplier } = require('../middlewares/auth');

// 全部接口需供应商登录
router.use(requireSupplier);

// 工具：判断某商品今日是否已改价（priceUpdatedAt 当天更新过）
function isUpdatedToday(priceUpdatedAt) {
  if (!priceUpdatedAt) return false;
  const d = new Date(priceUpdatedAt);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}

// ============ GET /api/supplier/price/workbench ============
// 供应商改价工作台：按 8 大分类分组返回当前供应商的所有商品 + 各品类保鲜期。
// 加价分销口径：供应商只维护「供货价」costPrice；平台卖价/加价额属平台商业机密，一律不下发。
// 每个商品返回：_id、name、category、grade、unit、costPrice（供货价）、
//   priceUpdatedAt、updatedToday、freshDays（保鲜期天数）、priceFrozen
router.get('/workbench', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const products = await SupplyProduct.find({ supplierId })
      .sort({ category: 1, name: 1, grade: 1 })
      .lean();

    // 一次性拉取保鲜期规则 Map（平台预置 + 该供应商专属）
    const ruleMap = await priceRuleUtil.getRuleMap(supplierId);

    // 按 8 大工作台分类标签分组
    const groups = {};
    for (const tab of priceRuleUtil.WORKBENCH_TABS) {
      groups[tab.key] = { tab: tab.key, products: [] };
    }

    let updatedCount = 0;
    for (const p of products) {
      const tab = priceRuleUtil.workbenchTabFor(p.category);
      const catRule = priceRuleUtil.ruleForCategory(ruleMap, p.category);
      const updatedToday = isUpdatedToday(p.priceUpdatedAt);
      if (updatedToday) updatedCount++;
      const supplyPrice = Number(p.costPrice) || 0;
      groups[tab].products.push({
        _id: String(p._id),
        name: p.name,
        category: p.category,
        grade: p.grade || null,
        unit: p.unit,
        costPrice: supplyPrice,          // 供货价（供应商可改）
        priceUpdatedAt: p.priceUpdatedAt,
        updatedToday,
        freshDays: catRule.freshDays,
        priceFrozen: !!p.priceFrozen
      });
    }

    res.json({
      success: true,
      data: {
        summary: {
          total: products.length,
          updated: updatedCount,
          pending: products.length - updatedCount
        },
        tabs: priceRuleUtil.WORKBENCH_TABS.map(t => t.key),
        groups: Object.values(groups)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/supplier/price/product/:id/update ============
// 单品改供货价：更新「供货价」costPrice，刷新 priceUpdatedAt，解除保鲜期冻结
// body: { costPrice }
// 注意：卖价 salePrice 由平台在定价工作台手动维护，供应商无权修改。
router.post('/product/:id/update', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const product = await SupplyProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: '商品不存在' });
    }
    if (String(product.supplierId) !== String(supplierId)) {
      return res.status(403).json({ success: false, message: '无权操作：只能改自己的商品' });
    }
    const { costPrice } = req.body || {};
    if (costPrice == null) {
      return res.status(400).json({ success: false, message: '请传 costPrice（供货价）' });
    }
    const c = Number(costPrice);
    if (!isFinite(c) || c < 0) {
      return res.status(400).json({ success: false, message: '供货价须为非负数字' });
    }
    product.costPrice = c;
    product.marketPrice = c; // 已废弃字段同步，仅为兼容历史
    // 改价即刷新 priceUpdatedAt，解除冻结与提醒标记
    product.priceUpdatedAt = new Date();
    product.priceFrozen = false;
    product.priceFrozenAt = null;
    product.freshnessAlertedAt = null;
    await product.save();
    res.json({
      success: true,
      data: {
        _id: String(product._id),
        costPrice: product.costPrice,
        priceUpdatedAt: product.priceUpdatedAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/supplier/price/product/:id/carry-over ============
// 单品"沿用供货价"：今天不改供货价，仅刷新 priceUpdatedAt，解除保鲜期冻结
router.post('/product/:id/carry-over', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const product = await SupplyProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: '商品不存在' });
    }
    if (String(product.supplierId) !== String(supplierId)) {
      return res.status(403).json({ success: false, message: '无权操作' });
    }
    product.priceUpdatedAt = new Date();
    product.priceFrozen = false;
    product.priceFrozenAt = null;
    product.freshnessAlertedAt = null;
    await product.save();
    res.json({ success: true, data: { _id: String(product._id), priceUpdatedAt: product.priceUpdatedAt } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/supplier/price/category/:category/carry-over ============
// 分类一键沿用：将该分类下所有"今日未改价"的商品沿用供货价，刷新 priceUpdatedAt
router.post('/category/:category/carry-over', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const tabKey = decodeURIComponent(req.params.category);
    const tab = priceRuleUtil.WORKBENCH_TABS.find(t => t.key === tabKey);
    if (!tab) {
      return res.status(400).json({ success: false, message: '非法分类标签' });
    }
    const all = await SupplyProduct.find({ supplierId }).lean();
    const now = new Date();
    const toUpdate = all.filter(p => {
      const belongs = (priceRuleUtil.workbenchTabFor(p.category) === tabKey);
      if (!belongs) return false;
      return !isUpdatedToday(p.priceUpdatedAt);
    });
    const ids = toUpdate.map(p => p._id);
    if (ids.length === 0) {
      return res.json({ success: true, data: { updated: 0, message: '该分类下已无待沿用商品' } });
    }
    const result = await SupplyProduct.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          priceUpdatedAt: now,
          priceFrozen: false,
          priceFrozenAt: null,
          freshnessAlertedAt: null
        }
      }
    );
    res.json({
      success: true,
      data: { updated: result.modifiedCount, total: ids.length }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/supplier/price/all/carry-over ============
// 全部一键沿用：把该供应商名下所有「今日未改价」的商品沿用供货价（跨分类，一次请求搞定）。
// 为什么需要它：供应商天天改价、蔬菜尤其每天必改，而价格真正变动的往往只有少数几个。
// 原本只有 /category/:category/carry-over，8 大分类就要点 8 次 + 确认 8 次 —— 天天如此是纯折磨。
// 语义与单品沿用一致：只刷新 priceUpdatedAt，不动价格，解除保鲜期冻结。
router.post('/all/carry-over', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const all = await SupplyProduct.find({ supplierId }).lean();
    const now = new Date();
    const ids = all.filter(p => !isUpdatedToday(p.priceUpdatedAt)).map(p => p._id);
    if (ids.length === 0) {
      return res.json({ success: true, data: { updated: 0, message: '今日已全部更新，无需沿用' } });
    }
    const result = await SupplyProduct.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          priceUpdatedAt: now,
          priceFrozen: false,
          priceFrozenAt: null,
          freshnessAlertedAt: null
        }
      }
    );
    res.json({
      success: true,
      data: { updated: result.modifiedCount, total: ids.length }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/supplier/price/freshness-alerts ============
// 保鲜期保护提醒：返回当前供应商触发保鲜期保护的商品（提醒阶段 + 冻结阶段）
router.get('/freshness-alerts', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const data = await freshnessCheck.getFreshnessAlerts(supplierId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
