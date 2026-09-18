/**
 * 文字地址 → 经纬度（正向地理编码）· 服务端封装
 *
 * 唯一事实源：utils/dhConfig.js → GEOCODE（限速/超时/重试/缓存参数）
 *
 * 供应商选择：高德（amap）Web 服务「地理编码 API」
 *   - 理由：项目 .env 里已有可用的 Web 服务 Key（AMAP_KEY），无需新增平台账号、无需域名白名单；
 *     腾讯位置服务需要重新注册、申请 Key、配置 referer 白名单，对「上线前加固」是净增量成本。
 *   - 注意：必须用 Web 服务 Key，**不能**用 JS API Key（实测 JS Key 直连返回 USERKEY_PLAT_NOMATCH）；
 *     安全密钥（securityJsCode）只服务 JS API，REST 直连不需要。
 *
 * 关键设计（都为了「不要因为技术原因卡住商家」）：
 *   1. 本模块 **永不抛异常**：任何失败都返回 { ok:false, reason }，由调用方决定是否阻断（当前一律不阻断）。
 *   2. 串行队列 + 最小间隔：免费 Key 的 QPS 很低（实测超过约 3 QPS 直接返 CUQPS_HAS_EXCEEDED_THE_LIMIT），
 *      所有请求排队串行执行，天然不会打爆配额。
 *   3. 内存 TTL 缓存：同一地址不重复请求（含失败结果短时缓存，避免商家反复提交时打爆配额）。
 *   4. 有限重试 + 退避：只对「限流 / 网络 / 超时」这类瞬时错误重试，对「无结果 / Key 无效」不重试。
 *
 * 用法：
 *   const geo = require('./geocode');
 *   const r = await geo.geocodeAddress('山东省泰安市泰山区东岳大街1号');
 *   if (r.ok) { ... r.longitude, r.latitude ... }
 */

const https = require('https');
const dhConfig = require('./dhConfig');

const GEO = (dhConfig && dhConfig.GEOCODE) || {};
const PROVIDER = GEO.provider || 'amap';
const MIN_INTERVAL_MS = GEO.minIntervalMs != null ? GEO.minIntervalMs : 350;
const TIMEOUT_MS = GEO.timeoutMs != null ? GEO.timeoutMs : 5000;
const MAX_RETRY = GEO.maxRetry != null ? GEO.maxRetry : 2;
const RETRY_BACKOFF_MS = GEO.retryBackoffMs != null ? GEO.retryBackoffMs : 600;
const CACHE_TTL_MS = GEO.cacheTtlMs != null ? GEO.cacheTtlMs : 24 * 60 * 60 * 1000;
const FAIL_CACHE_TTL_MS = GEO.failCacheTtlMs != null ? GEO.failCacheTtlMs : 5 * 60 * 1000;
const CACHE_MAX = GEO.cacheMax != null ? GEO.cacheMax : 500;

// 可重试的高德错误码（配额/服务瞬时不可用）；命中才退避重试。
// 注意：ENGINE_RESPONSE_DATA_ERROR 表示「引擎没有可用结果」（地址不够精确/无匹配），
//       属永久性失败，重试只会白耗配额，故不列入。
const RETRYABLE_INFO = new Set([
  'CUQPS_HAS_EXCEEDED_THE_LIMIT',
  'SERVICE_NOT_AVAILABLE',
  'SERVICE_RESPONSE_ERROR',
  'UNKNOWN_ERROR'
]);

/* ---------------- 队列 / 限速 ---------------- */
let _queue = Promise.resolve();
let _lastCallAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 串行排队执行：保证任意两次外部调用间隔 >= MIN_INTERVAL_MS
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function enqueue(fn) {
  const run = _queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - _lastCallAt);
    if (wait > 0) await sleep(wait);
    _lastCallAt = Date.now();
    return fn();
  });
  // 队列自身消化异常，避免一次失败卡死后续请求
  _queue = run.then(() => undefined, () => undefined);
  return run;
}

/* ---------------- 缓存 ---------------- */
const _cache = new Map(); // key -> { expireAt, value }

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expireAt <= Date.now()) { _cache.delete(key); return null; }
  // 简易 LRU：命中后刷新到队尾
  _cache.delete(key);
  _cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (_cache.size >= CACHE_MAX) {
    // 先清过期，再丢最旧
    const now = Date.now();
    for (const [k, v] of _cache) { if (v.expireAt <= now) _cache.delete(k); }
    while (_cache.size >= CACHE_MAX) {
      const oldest = _cache.keys().next();
      if (oldest.done) break;
      _cache.delete(oldest.value);
    }
  }
  const ttl = value && value.ok ? CACHE_TTL_MS : FAIL_CACHE_TTL_MS;
  _cache.set(key, { expireAt: Date.now() + ttl, value });
}

/* ---------------- 配置 ---------------- */
/** 地理编码用 Key（Web 服务 Key；优先专用变量，回退 AMAP_KEY。绝不使用 JS API Key） */
function getWebKey() {
  const keys = Array.isArray(GEO.envKeys) && GEO.envKeys.length
    ? GEO.envKeys
    : ['AMAP_WEB_KEY', 'AMAP_KEY'];
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** 是否已具备调用条件（未配置时调用方应直接跳过，不阻断业务） */
function isConfigured() {
  return PROVIDER === 'amap' ? !!getWebKey() : false;
}

/* ---------------- 地址预处理 ---------------- */
/** 归一化：去所有空白（含全角空格/换行），高德对空格不敏感，归一化后缓存命中率更高 */
function normalizeAddress(address) {
  return String(address == null ? '' : address)
    .replace(/[\s\u3000]+/g, '')
    .trim();
}

/** 从「XX市...」中提取城市，作为 city 参数限定范围，提升命中准确率（可选） */
function guessCity(address) {
  const m = String(address || '').match(/^(.{2,10}?市)/);
  return m ? m[1] : '';
}

/* ---------------- HTTP ---------------- */
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const req = https.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (done) return; done = true;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('响应非 JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时')); });
    req.on('error', (e) => { if (done) return; done = true; reject(e); });
  });
}

/* ---------------- 单次请求 ---------------- */
async function requestAmapOnce(normalizedAddress, city) {
  const key = getWebKey();
  if (!key) return { ok: false, reason: '未配置地理编码 Key（.env 的 AMAP_KEY / AMAP_WEB_KEY）' };

  let url = 'https://restapi.amap.com/v3/geocode/geo'
    + '?output=JSON'
    + '&key=' + encodeURIComponent(key)
    + '&address=' + encodeURIComponent(normalizedAddress);
  if (city) url += '&city=' + encodeURIComponent(city);

  let json;
  try {
    json = await httpGetJson(url, TIMEOUT_MS);
  } catch (e) {
    return { ok: false, retryable: true, reason: '网络异常：' + (e && e.message ? e.message : '未知错误') };
  }

  const info = (json && json.info) || 'UNKNOWN';
  if (json && json.status === '1') {
    const g = (json.geocodes || [])[0];
    if (!g || !g.location) return { ok: false, reason: '未匹配到坐标（' + info + '）' };
    const parts = String(g.location).split(',');
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!isFinite(lng) || !isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      return { ok: false, reason: '返回坐标非法（' + g.location + '）' };
    }
    return {
      ok: true,
      longitude: lng,
      latitude: lat,
      formattedAddress: g.formatted_address || '',
      level: g.level || '',
      city: g.city || '',
      district: g.district || '',
      provider: PROVIDER
    };
  }

  // status = '0'：按错误码分类
  if (info === 'CUQPS_HAS_EXCEEDED_THE_LIMIT') {
    return { ok: false, retryable: true, reason: '调用超频（QPS 限流）' };
  }
  if (info === 'INVALID_USER_KEY' || info === 'USERKEY_PLAT_NOMATCH' || info === 'SERVICE_NOT_EXIST') {
    return { ok: false, reason: 'Key 无效或非 Web 服务 Key（' + info + '）' };
  }
  if (info === 'INVALID_USER_SCODE' || info === 'INVALID_USER_SIGNATURE') {
    return { ok: false, reason: 'Key 鉴权失败（' + info + '）' };
  }
  if (info === 'ENGINE_RESPONSE_DATA_ERROR') {
    return { ok: false, reason: '地址不够精确，未匹配到坐标' };
  }
  return { ok: false, retryable: RETRYABLE_INFO.has(info), reason: '换算失败（' + info + '）' };
}

/* ---------------- 对外主函数 ---------------- */
/**
 * 文字地址 → 经纬度。永不抛异常。
 *
 * @param {string} address 详细地址（如「山东省泰安市泰山区东岳大街1号」）
 * @param {object} [opts] { city?: string, skipCache?: boolean }
 * @returns {Promise<{
 *   ok: boolean, provider: string, reason?: string,
 *   longitude?: number, latitude?: number, formattedAddress?: string, level?: string,
 *   cached?: boolean, attempts?: number
 * }>}
 */
async function geocodeAddress(address, opts) {
  const options = opts || {};
  const normalized = normalizeAddress(address);

  if (!normalized) return { ok: false, provider: PROVIDER, reason: '地址为空' };
  if (normalized.length < 4) return { ok: false, provider: PROVIDER, reason: '地址过短，无法换算' };
  if (!isConfigured()) {
    return { ok: false, provider: PROVIDER, reason: '未配置地理编码 Key（.env 的 AMAP_KEY / AMAP_WEB_KEY）' };
  }

  const city = options.city != null ? String(options.city) : guessCity(normalized);
  const cacheKey = PROVIDER + '|' + normalized + '|' + city;

  if (!options.skipCache) {
    const hit = cacheGet(cacheKey);
    if (hit) return Object.assign({}, hit, { cached: true });
  }

  let last = { ok: false, provider: PROVIDER, reason: '未知错误' };
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await enqueue(() => requestAmapOnce(normalized, city));
    last = r;
    if (r.ok) {
      const value = Object.assign({}, r, { attempts: attempt + 1 });
      cacheSet(cacheKey, value);
      return value;
    }
    if (!r.retryable || attempt === MAX_RETRY) break;
    // 退避重试（限流时给配额留恢复时间）
    // eslint-disable-next-line no-await-in-loop
    await sleep(RETRY_BACKOFF_MS * (attempt + 1));
  }

  const value = {
    ok: false,
    provider: PROVIDER,
    reason: last.reason || '换算失败',
    attempts: MAX_RETRY + 1
  };
  cacheSet(cacheKey, value);
  return value;
}

/**
 * 批量换算（保持串行限速语义；仅用于脚本/后台补全，不在下单链路里调用）
 * @param {string[]} addresses
 * @returns {Promise<Array>} 与入参等长
 */
async function geocodeMany(addresses) {
  const out = [];
  for (const a of (addresses || [])) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await geocodeAddress(a));
  }
  return out;
}

module.exports = {
  PROVIDER,
  isConfigured,
  normalizeAddress,
  guessCity,
  geocodeAddress,
  geocodeMany
};
