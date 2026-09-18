/**
 * 敏感字段加密存储（AES-256-GCM）
 *
 * 用途：供应商微信进件资料中的银行账号等敏感字段加密落库，不存明文；日志输出一律走 mask* 脱敏。
 *
 * 密钥来源（优先级）：
 *   1. 环境变量 SENSITIVE_ENC_KEY（推荐：32+ 位随机串）
 *   2. 回退派生：JWT_SECRET 的 SHA-256（避免无 JWT_SECRET 环境下随机密钥导致重启后无法解密）
 * 密文格式：enc:v1:<iv_base64>:<tag_base64>:<cipher_base64>
 *   - 带 enc:v1: 前缀的按密文解密；不带前缀的视为历史明文原样返回（平滑迁移，不炸老数据）。
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function getKey() {
  const raw = process.env.SENSITIVE_ENC_KEY || process.env.JWT_SECRET || 'dingheng-canyin-sensitive-fallback';
  return crypto.createHash('sha256').update(String(raw)).digest(); // 32 bytes
}

/**
 * 加密明文 → enc:v1:... 密文；空值原样返回
 */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * 解密密文 → 明文；非 enc:v1: 前缀（历史明文）原样返回；解密失败返回空串（不抛错，避免接口 500）
 */
function decrypt(payload) {
  const s = String(payload || '');
  if (!s) return '';
  if (!s.startsWith(PREFIX)) return s; // 历史明文兼容
  try {
    const parts = s.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return '';
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ct = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

// ============ 日志脱敏 ============

// 银行账号：只露最后 4 位，如 ****6789
function maskBankAccount(no) {
  const s = String(no || '');
  if (!s) return '';
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}

// 身份证号：前 3 后 2，如 370***********1X（当前不存身份证号明文，仅备用）
function maskIdCard(no) {
  const s = String(no || '');
  if (!s) return '';
  if (s.length <= 5) return '*****';
  return s.slice(0, 3) + '***********' + s.slice(-2);
}

// 手机号：前 3 后 4，如 138****5678
function maskPhone(no) {
  const s = String(no || '');
  if (!s) return '';
  if (s.length <= 7) return '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

module.exports = {
  encrypt,
  decrypt,
  maskBankAccount,
  maskIdCard,
  maskPhone
};
