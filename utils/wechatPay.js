/**
 * 微信支付 API v3 服务端封装（服务商模式）
 *
 * 依赖：Node 内置 crypto + 全局 fetch（Node 18+），无需额外 npm 依赖。
 * 全部凭证从环境变量读取，未配置时 isConfigured() === false，相关接口应返回「未配置」。
 *
 * 相关环境变量：
 *   WXPAY_SP_MCHID       服务商商户号（必填）
 *   WXPAY_APPID          服务商 AppID（必填）
 *   WXPAY_API_V3_KEY     APIv3 密钥（必填，用于回调解密/平台证书解密）
 *   WXPAY_SERIAL_NO      服务商 API 证书序列号（必填）
 *   WXPAY_PRIVATE_KEY    服务商 API 私钥（PKCS#8 PEM；支持字面量 \n 或 base64，必填）
 *   WXPAY_SUB_MCHID      收款特约商户号（服务商分账必填：会员费由该特约商户收取后再分账）
 *   WXPAY_SUB_APPID      特约商户 AppID（可选，默认用服务商 AppID）
 *   WXPAY_NOTIFY_URL     支付结果回调地址（公网可访问，必填）
 *   WXPAY_PLATFORM_CERT  微信支付平台证书 PEM（可选；用于回调验签，未配置则自动下载缓存）
 *   WXPAY_SPLIT_RATE     平台抽佣比例（百分比，默认 6）
 */
const crypto = require('crypto');

const BASE = 'https://api.mch.weixin.qq.com';

function normalizePem(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (s.includes('BEGIN')) return s.replace(/\\n/g, '\n');
  // 兼容 base64 编码的 PEM
  try {
    const dec = Buffer.from(s, 'base64').toString('utf8');
    if (dec.includes('BEGIN')) return dec;
  } catch (e) { /* 忽略 */ }
  return s;
}

const CFG = {
  spMchId: process.env.WXPAY_SP_MCHID || '',
  appId: process.env.WXPAY_APPID || '',
  apiV3Key: process.env.WXPAY_API_V3_KEY || '',
  serialNo: process.env.WXPAY_SERIAL_NO || '',
  privateKey: normalizePem(process.env.WXPAY_PRIVATE_KEY || ''),
  subMchId: process.env.WXPAY_SUB_MCHID || '',
  subAppId: process.env.WXPAY_SUB_APPID || '',
  notifyUrl: process.env.WXPAY_NOTIFY_URL || '',
  platformCert: normalizePem(process.env.WXPAY_PLATFORM_CERT || ''),
  splitRate: Number(process.env.WXPAY_SPLIT_RATE) >= 0 ? Number(process.env.WXPAY_SPLIT_RATE) : 6
};

function isConfigured() {
  return !!(CFG.spMchId && CFG.appId && CFG.apiV3Key && CFG.serialNo && CFG.privateKey && CFG.notifyUrl);
}
// 服务商分账要求有收款特约商户号
function isSplitConfigured() {
  return isConfigured() && !!CFG.subMchId;
}

// ============ 请求签名（WECHATPAY2-SHA256-RSA2048） ============
function buildAuthorization(method, urlPath, bodyStr) {
  const nonce = crypto.randomBytes(16).toString('hex').toUpperCase();
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${bodyStr || ''}\n`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(message)
    .sign({ key: CFG.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${CFG.spMchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${CFG.serialNo}",signature="${signature}"`;
}

async function request(method, urlPath, body) {
  if (!isConfigured()) {
    const e = new Error('微信支付未配置（缺少 WXPAY_* 环境变量）');
    e.code = 'WXPAY_NOT_CONFIGURED';
    throw e;
  }
  const bodyStr = body ? JSON.stringify(body) : '';
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': buildAuthorization(method, urlPath, bodyStr),
      'User-Agent': 'dingheng-canyin/1.0'
    },
    body: bodyStr || undefined
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((json && json.message) || `微信支付接口错误 HTTP ${res.status}`);
    err.code = (json && json.code) || 'WXPAY_HTTP_ERROR';
    err.status = res.status;
    err.detail = json || text;
    throw err;
  }
  return json;
}

// ============ 平台证书（回调验签用） ============
let _platformCerts = null; // [{ serialNo, publicKey }]

function decryptAesGcm(resource) {
  const key = Buffer.from(CFG.apiV3Key, 'utf8');
  const buf = Buffer.from(resource.ciphertext, 'base64');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  const dec = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(dec);
}

// 加载平台证书公钥：优先环境变量，其次调用 /v3/certificates 下载并缓存
async function loadPlatformCerts() {
  if (_platformCerts) return _platformCerts;
  const certs = [];
  if (CFG.platformCert) {
    certs.push({ serialNo: '', publicKey: crypto.createPublicKey(CFG.platformCert) });
  } else {
    const resp = await request('GET', '/v3/certificates');
    for (const item of (resp && resp.data) || []) {
      try {
        const certPem = decryptAesGcm(item.encrypt_certificate).certificate;
        certs.push({ serialNo: item.serial_no, publicKey: crypto.createPublicKey(certPem) });
      } catch (e) { /* 单张解密失败跳过 */ }
    }
  }
  _platformCerts = certs;
  return certs;
}

/**
 * 校验并解密支付/退款回调
 * @param {object} headers 请求头（需含 wechatpay-signature/timestamp/nonce/serial）
 * @param {string} rawBody 原始请求体字符串
 * @returns {Promise<object>} 解密后的 resource 明文对象
 */
async function verifyAndDecryptNotify(headers, rawBody) {
  const h = headers || {};
  const signature = h['wechatpay-signature'];
  const timestamp = h['wechatpay-timestamp'];
  const nonce = h['wechatpay-nonce'];
  const serial = h['wechatpay-serial'];
  if (!signature || !timestamp || !nonce || !rawBody) {
    const e = new Error('回调缺少验签头'); e.code = 'WXPAY_NOTIFY_INVALID'; throw e;
  }
  const certs = await loadPlatformCerts();
  if (!certs.length) {
    const e = new Error('无可用微信支付平台证书，无法验签'); e.code = 'WXPAY_CERT_UNAVAILABLE'; throw e;
  }
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const ok = certs.some(c => {
    if (serial && c.serialNo && c.serialNo !== serial) return false;
    try {
      return crypto.createVerify('RSA-SHA256').update(message).verify(c.publicKey, signature, 'base64');
    } catch (e) { return false; }
  });
  if (!ok) {
    const e = new Error('回调验签失败'); e.code = 'WXPAY_NOTIFY_VERIFY_FAILED'; throw e;
  }
  const body = JSON.parse(rawBody);
  if (!body.resource) {
    const e = new Error('回调报文缺少 resource'); e.code = 'WXPAY_NOTIFY_INVALID'; throw e;
  }
  return decryptAesGcm(body.resource);
}

// ============ 下单（Native 扫码支付） ============
// 服务商模式：收款方为特约商户（sub_mchid）；未配置 sub_mchid 时退回普通直连商户下单
// opts.subMchId       按订单指定收款特约商户号（供应商进件 supplier_first 模式：货款直接进供应商账户）
// opts.profitSharing  true 时下单携带 profit_sharing=true 分账标识（该订单资金进入冻结态，可发起分账）
async function nativePrepay({ outTradeNo, description, amountFen, attach, timeExpire }, opts = {}) {
  const orderSubMchId = (opts && opts.subMchId) || CFG.subMchId;
  if (orderSubMchId) {
    return request('POST', '/v3/pay/partner/transactions/native', {
      sp_appid: CFG.appId,
      sp_mchid: CFG.spMchId,
      sub_appid: CFG.subAppId || undefined,
      sub_mchid: orderSubMchId,
      description,
      out_trade_no: outTradeNo,
      time_expire: timeExpire,
      notify_url: CFG.notifyUrl,
      amount: { total: amountFen, currency: 'CNY' },
      attach,
      // 分账标识：下单时必须传 true，支付成功后该笔资金冻结（仅计入不可用余额），才能发起分账
      profit_sharing: opts.profitSharing ? true : undefined
    });
  }
  return request('POST', '/v3/pay/transactions/native', {
    appid: CFG.appId,
    mchid: CFG.spMchId,
    description,
    out_trade_no: outTradeNo,
    time_expire: timeExpire,
    notify_url: CFG.notifyUrl,
    amount: { total: amountFen, currency: 'CNY' },
    attach
  });
}

// 按商户订单号查单
async function queryOrder(outTradeNo) {
  if (CFG.subMchId) {
    const qs = `sp_mchid=${encodeURIComponent(CFG.spMchId)}&sub_mchid=${encodeURIComponent(CFG.subMchId)}`;
    return request('GET', `/v3/pay/partner/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?${qs}`);
  }
  return request('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(CFG.spMchId)}`);
}

// 关闭订单
async function closeOrder(outTradeNo) {
  if (CFG.subMchId) {
    return request('POST', `/v3/pay/partner/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, {
      sp_mchid: CFG.spMchId,
      sub_mchid: CFG.subMchId
    });
  }
  return request('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, {
    mchid: CFG.spMchId
  });
}

// ============ 服务商分账 ============
// 添加分账接收方（已存在 DUPLICATE 视为成功）
// opts.subMchId：分账出资方（收款）特约商户号；缺省用全局 CFG.subMchId。
// 注意：接收方按「出资方子商户号」分别绑定（供应商 A 收款的订单，要先把平台加为 A 的接收方）
async function addSplitReceiver({ account, name, relationType }, opts = {}) {
  const body = {
    sub_mchid: (opts && opts.subMchId) || CFG.subMchId,
    appid: CFG.subAppId || CFG.appId,
    type: 'MERCHANT_ID',
    account,
    relation_type: relationType || 'SUPPLIER'
  };
  if (name) body.name = name;
  try {
    return await request('POST', '/v3/profitsharing/receivers/add', body);
  } catch (e) {
    if (e.code === 'SYSTEM_ERROR' || e.status >= 500) throw e;
    // 接收方已存在等业务错误：不阻断后续分账请求
    return { _ignored: true, code: e.code, message: e.message };
  }
}

// 请求分账
// opts.subMchId：分账出资方（收款）特约商户号；缺省用全局 CFG.subMchId
async function requestProfitSharing({ transactionId, outOrderNo, receivers, unfreezeUnsplit = true }, opts = {}) {
  return request('POST', '/v3/profitsharing/orders', {
    sub_mchid: (opts && opts.subMchId) || CFG.subMchId,
    appid: CFG.subAppId || CFG.appId,
    transaction_id: transactionId,
    out_order_no: outOrderNo,
    receivers,
    unfreeze_unsplit: !!unfreezeUnsplit
  });
}

// 查询分账结果（opts.subMchId 同上）
async function queryProfitSharing({ outOrderNo, transactionId }, opts = {}) {
  const sub = (opts && opts.subMchId) || CFG.subMchId;
  const qs = `sub_mchid=${encodeURIComponent(sub)}&transaction_id=${encodeURIComponent(transactionId)}`;
  return request('GET', `/v3/profitsharing/orders/${encodeURIComponent(outOrderNo)}?${qs}`);
}

// 解冻剩余资金（分账完成后把未分部分解冻给出资方，准实时、无 T+1 限制）
// opts.subMchId：分账出资方特约商户号；缺省用全局 CFG.subMchId
async function unfreezeRemaining({ transactionId, outOrderNo, description }, opts = {}) {
  return request('POST', '/v3/profitsharing/orders/unfreeze', {
    sub_mchid: (opts && opts.subMchId) || CFG.subMchId,
    appid: CFG.subAppId || CFG.appId,
    transaction_id: transactionId,
    out_order_no: outOrderNo,
    description: description || '分账完成，解冻剩余资金'
  });
}

// 分账回退（退款前回收已分出的资金）
async function returnProfitSharing({ orderId, outOrderNo, outReturnNo, returnMchid, amountFen, description }) {
  return request('POST', '/v3/profitsharing/return-orders', {
    sub_mchid: CFG.subMchId,
    order_id: orderId,
    out_order_no: outOrderNo,
    out_return_no: outReturnNo,
    return_mchid: returnMchid,
    amount: amountFen,
    description: description || '会员购卡退款回退分账'
  });
}

// ============ 退款（服务商模式） ============
async function refund({ transactionId, outRefundNo, refundFen, totalFen, reason, notifyUrl }) {
  const body = {
    transaction_id: transactionId,
    out_refund_no: outRefundNo,
    reason: reason || '会员购卡退款',
    notify_url: notifyUrl || undefined,
    amount: { refund: refundFen, total: totalFen, currency: 'CNY' }
  };
  if (CFG.subMchId) {
    body.sub_mchid = CFG.subMchId;
    body.sp_appid = CFG.appId;
    body.sp_mchid = CFG.spMchId;
  }
  return request('POST', '/v3/refund/domestic/refunds', body);
}

module.exports = {
  isConfigured,
  isSplitConfigured,
  splitRate: () => CFG.splitRate,
  spMchId: () => CFG.spMchId,
  subMchId: () => CFG.subMchId,
  nativePrepay,
  queryOrder,
  closeOrder,
  addSplitReceiver,
  requestProfitSharing,
  queryProfitSharing,
  unfreezeRemaining,
  returnProfitSharing,
  refund,
  verifyAndDecryptNotify
};
