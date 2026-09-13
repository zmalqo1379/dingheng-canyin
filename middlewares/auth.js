const jwt = require('jsonwebtoken');

// JWT 密钥：强制由 .env 的 JWT_SECRET 提供，缺失时直接报错退出（不再使用硬编码默认值）
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] 缺少环境变量 JWT_SECRET：请在项目根目录 .env 中配置 JWT_SECRET 后重启服务');
  process.exit(1);
}
// Token 有效期
const JWT_EXPIRES_IN = '7d';

/**
 * 签发 JWT
 * payload 至少包含 { id, role }
 */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * 通用 Token 校验中间件
 * 从 Authorization Header 读取 Bearer Token，验证通过后将 decoded 挂到 req.user
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const parts = authHeader.split(' ');
  let token = '';
  if (parts.length === 2 && parts[0] === 'Bearer') {
    token = parts[1];
  } else if (req.query && req.query.token) {
    // 兼容部分场景通过 query 传递
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ success: false, message: '未提供登录凭证，请先登录' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: '登录凭证无效或已过期，请重新登录' });
  }
}

/**
 * 从请求中提取 shopId（公开接口用，无需 JWT）
 * 优先级：x-shop-id 请求头 > query.shopId > body.shopId
 * 挂载到 req.publicShopId
 */
function extractPublicShopId(req, res, next) {
  const shopId =
    (req.headers && req.headers['x-shop-id']) ||
    (req.query && req.query.shopId) ||
    (req.body && req.body.shopId) ||
    '';
  req.publicShopId = String(shopId || '').trim();
  next();
}

/**
 * 公开接口强制要求 shopId 的中间件（extractPublicShopId 之后调用）
 * 缺少 shopId 直接返回 400
 */
function requirePublicShopId(req, res, next) {
  if (!req.publicShopId) {
    return res.status(400).json({ success: false, message: '缺少店铺标识 shopId，请通过 x-shop-id 请求头或 query 参数传入' });
  }
  next();
}

/**
 * 要求商家身份 + 校验请求携带的 shopId 与 JWT 中的 shopId 一致
 *   - 防止商家 A 伪造商家 B 的 shopId 去操作他人数据
 *   - 请求 shopId 来源：x-shop-id 头 或 query.shopId（若不传则直接用 JWT 中的）
 *   - 校验规则：如果请求显式传了 shopId，必须与 token.shopId 一致
 *   - 最终将确认的 shopId 挂到 req.shopId（统一取用字段）
 */
function requireMerchant(req, res, next) {
  verifyToken(req, res, () => {
    if (!req.user || req.user.role !== 'merchant') {
      return res.status(403).json({ success: false, message: '无访问权限，需要商家身份' });
    }
    const tokenShopId = String(req.user.shopId || '').trim();
    const requestShopId = String(
      (req.headers && req.headers['x-shop-id']) ||
      (req.query && req.query.shopId) ||
      ''
    ).trim();

    if (!tokenShopId) {
      return res.status(403).json({ success: false, message: '登录凭证缺少 shopId，请重新登录' });
    }
    // 请求端显式传了 shopId 时，必须与 JWT 内的一致
    if (requestShopId && requestShopId !== tokenShopId) {
      return res.status(403).json({ success: false, message: '无权操作其他商家的数据' });
    }
    req.shopId = tokenShopId;
    next();
  });
}

/**
 * 要求供应商身份
 */
function requireSupplier(req, res, next) {
  verifyToken(req, res, () => {
    if (!req.user || req.user.role !== 'supplier') {
      return res.status(403).json({ success: false, message: '无访问权限，需要供应商身份' });
    }
    next();
  });
}

/**
 * 要求开发者身份
 */
function requireDev(req, res, next) {
  verifyToken(req, res, () => {
    if (!req.user || req.user.role !== 'dev') {
      return res.status(403).json({ success: false, message: '无访问权限，需要开发者身份' });
    }
    next();
  });
}

module.exports = {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  signToken,
  verifyToken,
  extractPublicShopId,
  requirePublicShopId,
  requireMerchant,
  requireSupplier,
  requireDev
};
