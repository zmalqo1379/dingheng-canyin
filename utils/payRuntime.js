/**
 * 支付运行时配置（pay mode + 资金流模式）
 *
 * 目的：让「支付模式（mock 演示 / wechat 真实）」与「资金流模式（supplier_first / platform_first）」
 *      可以在开发者后台实时切换，改完立即生效，不用重启服务。
 *
 * 事实源约定（与 minMarkupRate 同一套模式）：
 *   - 缺省默认值：utils/dhConfig.js（唯一事实源）
 *   - 运行时覆盖：PlatformConfig 单例文档（payMode / paymentFlowMode 字段）
 *   - 读取入口：本模块（进程内缓存 + 写穿更新），所有支付/分账代码一律通过本模块读取，不写死
 *
 * 演示模式（payMode='mock'）下 utils/paymentProvider 的真实微信适配器会直接拒绝调用，
 * 防止误触真实资金接口。
 */
const dhConfig = require('./dhConfig');

// 进程内缓存（单进程部署；写入时写穿 DB + 同步刷新缓存）
let _state = {
  payMode: 'mock',
  paymentFlowMode: dhConfig.PAYMENT_FLOW_MODE,
  loaded: false
};

const PAY_MODES = ['mock', 'wechat'];

function normalizePayMode(v) {
  return PAY_MODES.includes(v) ? v : 'mock';
}

/**
 * 启动时（或首次调用时）从 PlatformConfig 加载覆盖值。
 * DB 不可用/未初始化时不阻断：保持 dhConfig 默认值。
 */
async function init() {
  if (_state.loaded) return _state;
  try {
    const PlatformConfig = require('../models/PlatformConfig');
    const cfg = await PlatformConfig.getSingleton();
    _state.payMode = normalizePayMode(cfg && cfg.payMode);
    _state.paymentFlowMode = dhConfig.resolvePaymentFlowMode(cfg && cfg.paymentFlowMode);
  } catch (e) {
    // 数据库未就绪等场景：静默使用默认值，不阻断支付链路
  }
  _state.loaded = true;
  return _state;
}

// 同步读取（未加载完成时返回默认值，加载后返回覆盖值）
function getPayMode() {
  return _state.payMode;
}

function getPaymentFlowMode() {
  return _state.paymentFlowMode;
}

// 演示模式：mock = 所有交易均为模拟数据，禁止调用真实支付接口
function isDemoMode() {
  return _state.payMode === 'mock';
}

/**
 * 切换支付模式（mock / wechat）：写库 + 刷新进程内缓存，立即生效。
 * 调用方（dev 路由）负责校验 wechat 凭证是否已配置。
 */
async function setPayMode(mode) {
  const v = normalizePayMode(mode);
  const PlatformConfig = require('../models/PlatformConfig');
  await PlatformConfig.findOneAndUpdate(
    { key: 'platform' },
    { $set: { payMode: v } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  _state.payMode = v;
  _state.loaded = true;
  return v;
}

/**
 * 切换资金流模式（supplier_first / platform_first）：写库 + 刷新缓存，立即生效。
 * platform_first 需先取得微信「高比例分账」白名单（由调用方/操作人保证）。
 */
async function setPaymentFlowMode(mode) {
  const v = dhConfig.resolvePaymentFlowMode(mode);
  const PlatformConfig = require('../models/PlatformConfig');
  await PlatformConfig.findOneAndUpdate(
    { key: 'platform' },
    { $set: { paymentFlowMode: v } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  _state.paymentFlowMode = v;
  _state.loaded = true;
  return v;
}

module.exports = {
  PAY_MODES,
  init,
  getPayMode,
  getPaymentFlowMode,
  isDemoMode,
  setPayMode,
  setPaymentFlowMode
};
