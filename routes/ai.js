const express = require('express');
const router = express.Router();

const { requireMerchant, requireSupplier } = require('../middlewares/auth');
const Category = require('../models/Category');
const {
  parseImage,
  parseText,
  isConfigured,
  getConfig,
  VisionError,
  DEFAULT_PRODUCT_CATEGORIES
} = require('../utils/vision');

// 前端已把图片压到长边 1280 再传，这里再兜一道：base64 字符串不超过 6MB
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;

/**
 * GET /api/ai/status
 * 前端靠它决定要不要显示「拍照上传」入口：没配置就别露出来，省得点了报错。
 * 只返回"能不能用"，绝不返回密钥。
 */
router.get('/status', async (req, res) => {
  const cfg = getConfig();
  res.json({
    success: true,
    data: {
      enabled: isConfigured(),
      provider: cfg.provider,
      providerLabel: cfg.label,
      hasVision: !!cfg.visionModel,     // 纯文字模型（如 DeepSeek）不支持拍照
      hasText: !!cfg.textModel,
      maxImageChars: MAX_IMAGE_CHARS
    }
  });
});

// 统一的识别入口：图片和文字走同一条管道，只是喂给模型的东西不同
async function doParse(req, res, kind) {
  try {
    const { image, text, categories } = req.body || {};

    let opts = { categories: null };
    if (kind === 'dish') {
      // 菜品分类必须用商家自己建的那套，不能凭空造 —— 造出来菜单里会多一个空分类
      const docs = await Category.find({ shopId: req.shopId }).sort({ createdAt: 1 });
      const names = docs.map(d => String(d.name || '').trim()).filter(Boolean);
      opts.categories = (Array.isArray(categories) && categories.length ? categories : names);
      if (!opts.categories.length) opts.categories = null;   // 没建分类就用默认中式菜单分类
    } else {
      opts.categories = (Array.isArray(categories) && categories.length) ? categories : DEFAULT_PRODUCT_CATEGORIES;
    }

    let result;
    if (image && typeof image === 'string' && image.startsWith('data:image/')) {
      if (image.length > MAX_IMAGE_CHARS) {
        return res.status(413).json({ success: false, message: '图片太大了，请重新拍一张（或把镜头拉远一点）' });
      }
      result = await parseImage(image, kind, opts);
    } else if (text && String(text).trim()) {
      // 粘贴文字这条路：微信里收到的报价单/菜单直接粘进来，比拍照还准，也几乎不花钱
      result = await parseText(String(text), kind, opts);
    } else {
      return res.status(400).json({ success: false, message: '请先拍照、选图，或者把报价单文字粘贴进来' });
    }

    if (!result.items || !result.items.length) {
      return res.json({
        success: true,
        data: { items: [], provider: result.provider, providerLabel: result.providerLabel, via: result.via },
        message: '没从这张图里认出条目来 —— 可以试试把镜头拉近拍清楚一点，或者直接粘贴文字'
      });
    }

    res.json({
      success: true,
      data: { items: result.items, provider: result.provider, providerLabel: result.providerLabel, via: result.via }
    });
  } catch (err) {
    if (err instanceof VisionError) {
      const status = (err.code === 'NOT_CONFIGURED' || err.code === 'AUTH_FAILED' || err.code === 'NO_MODEL') ? 503
        : (err.code === 'TIMEOUT' || err.code === 'NETWORK' || err.code === 'UPSTREAM' || err.code === 'BAD_RESPONSE') ? 502
          : 400;
      return res.status(status).json({ success: false, message: err.message, code: err.code });
    }
    res.status(500).json({ success: false, message: err.message });
  }
}

// ============ 商家：拍照上传菜单 ============
// 纸质菜单拍照 → 菜名 / 价格 / 分类
router.post('/parse-dishes', requireMerchant, (req, res) => doParse(req, res, 'dish'));

// ============ 供应商：拍照上传商品 ============
// 品类表格 / 报价单拍照 → 商品名 / 品类 / 单位 / 价格
router.post('/parse-products', requireSupplier, (req, res) => doParse(req, res, 'product'));

module.exports = router;
