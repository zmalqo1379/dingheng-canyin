/**
 * 商家认证状态聚合 + 采购下单认证门控（上线加固 · 第一批）
 *
 * 唯一事实源：utils/dhConfig.js（FIRST_ORDER_NO_AUTH_LIMIT / REQUIRE_PHONE_VERIFIED / CERT_GATING）
 * 认证数据内嵌：Setting.certification（写法参照 Supplier.qualification）
 *
 * 供两处共用（禁止各自实现，防止口径漂移）：
 *   1) GET /api/admin/certification/status —— 前端引导（缺什么补什么）
 *   2) POST /api/purchase-orders 与 POST /:id/pay —— 下单/支付判定
 *
 * 认证项（缺失清单 missing 的来源）：
 *   - 门店地址 shopAddress（已有字段）
 *   - 门头照 storeFrontPhoto（已有字段）
 *   - 门店定位 经纬度（已有字段；可由后端按地址自动换算，商家只填文字地址即可）
 *   - 营业执照 businessLicense（第二批接入 OCR，本轮预留）
 *   - 手机号验证 phoneVerified（受 dhConfig.REQUIRE_PHONE_VERIFIED 控制，默认 false 即视为已验证）
 *
 * 分级（dhConfig.CERT_GATING）：
 *   - fulfillment（履约必需）：缺则一律不放行（含首单直通）
 *       shopAddress / phoneVerified
 *   - compliance（合规可缓）：首单直通时跳过，认证时要求
 *       businessLicense / storeFrontPhoto
 *   - optional（选填可补）：不阻断任何链路，仅作「待补全」提示
 *       location
 *
 * 【2026-09 上线加固调整】经纬度（location）由 fulfillment 降级为 optional：
 *   商家在认证页只填文字地址，后端用高德 Web 服务地理编码自动换算经纬度（utils/geocode.js）；
 *   换算失败属技术原因，不应阻断商家下单（供应商看文字地址即可配送），失败会记录在
 *   Setting.certification.geoStatus / geoMessage 供后续补全。
 *
 * 判定规则（服务端权威）：
 *   已认证（certification.status === 'approved'） → 任意金额放行
 *   未认证 + 首单直通：从未有成功订单（存在 payStatus='paid' 的采购单）且 订单金额 ≤ FIRST_ORDER_NO_AUTH_LIMIT（0=关闭直通）
 *     → 只跳过 compliance 项；fulfillment 缺则仍拦截
 *   其它情况：409 CERT_REQUIRED，data.missing 拆为 blocking + skippable 两组（optional 单列，不参与拦截）
 */
const Setting = require('../models/Setting');
const ShopAccount = require('../models/ShopAccount');
const PurchaseOrder = require('../models/PurchaseOrder');
const dhConfig = require('./dhConfig');

// 认证项定义：key / 展示文案 / 取值函数 / gating（履约必需 fulfillment / 合规可缓 compliance / 选填可补 optional）
// reserved=true：该功能位尚未完全开放（地图选点/OCR/短信验证）但保留字段位，
//               实际取值由 get() 决定（手机号验证受 REQUIRE_PHONE_VERIFIED 开关控制）
const CERT_ITEMS = [
  { key: 'shopAddress',      label: '门店详细地址', gating: 'fulfillment',
    get: (s) => s && s.shopAddress && String(s.shopAddress).trim() },
  { key: 'storeFrontPhoto',  label: '门店门头照',   gating: 'compliance',
    get: (s) => s && s.storeFrontPhoto },
  // 门店定位：选填。缺失不阻断（可由后端按文字地址自动换算，见 utils/geocode.js）
  { key: 'location',         label: '门店定位',     gating: 'optional',
    get: (s) => s && s.shopLongitude != null && s.shopLatitude != null, reserved: true },
  { key: 'businessLicense',  label: '营业执照',     gating: 'compliance',
    get: (s) => s && s.certification && s.certification.businessLicense, reserved: true },
  // 手机号验证：开关关时（默认）即视为已通过；开关开时才查 Setting.certification.phoneVerified
  { key: 'phoneVerified',    label: '手机号验证',   gating: 'fulfillment',
    reserved: true,
    get: (s) => {
      if (!dhConfig.REQUIRE_PHONE_VERIFIED) return true; // 默认放行（已注册手机号即视为已验证）
      return !!(s && s.certification && s.certification.phoneVerified === true);
    } }
];

/**
 * 该店是否已有成功订单（历史上任一支付成功的采购单，含老数据——老订单下单即 mock 置 paid）
 * @returns {Promise<boolean>}
 */
async function hasSuccessfulOrder(shopId) {
  if (!shopId) return false;
  // exists 在部分 mongoose 版本返回文档而非布尔，统一归一化
  return !!(await PurchaseOrder.exists({ shopId, payStatus: 'paid' }));
}

/**
 * 计算缺失项分级：
 *   blocking: 现在必须补齐才能继续下单（含首单直通都不可跳）
 *   skippable: 首单直通时可暂缓（合规项）
 *   optional: 选填项，不阻断任何链路，仅作「待补全」提示
 * @param {object} setting
 * @returns {{blocking:string[], skippable:string[], optional:string[], all:string[], byKey:object}}
 *   all = blocking + skippable（保持历史语义：只含「会影响放行」的缺失项）
 */
function classifyMissing(setting) {
  const byKey = {};
  const blocking = [];
  const skippable = [];
  const optional = [];
  for (const it of CERT_ITEMS) {
    const ok = !!it.get(setting);
    byKey[it.key] = { ok, label: it.label, reserved: !!it.reserved, gating: it.gating };
    if (ok) continue;
    if (it.gating === 'fulfillment') blocking.push(it.label);
    else if (it.gating === 'optional') optional.push(it.label);
    else skippable.push(it.label);
  }
  return { blocking, skippable, optional, all: [...blocking, ...skippable], byKey };
}

/**
 * 认证状态聚合视图（GET /api/admin/certification/status 与前端引导共用）
 * @param {string} shopId
 * @param {number} [orderAmount] 若传入订单金额，一并返回该金额下的下单判定结果
 */
async function getCertificationStatus(shopId, orderAmount) {
  const setting = await Setting.findOne({ shopId }).lean();
  const cert = (setting && setting.certification) || {};
  const certified = cert.status === 'approved';

  const cls = classifyMissing(setting);
  const items = CERT_ITEMS.map(it => ({
    key: it.key,
    label: it.label,
    gating: it.gating,            // fulfillment / compliance
    ok: cls.byKey[it.key].ok,
    reserved: cls.byKey[it.key].reserved
  }));

  const result = {
    certified,
    status: cert.status || 'none',
    phoneVerified: cert.phoneVerified === true,
    requirePhoneVerified: !!dhConfig.REQUIRE_PHONE_VERIFIED,
    rejectReason: cert.rejectReason || '',
    submittedAt: cert.submittedAt || null,
    reviewedAt: cert.reviewedAt || null,
    businessLicense: cert.businessLicense || '',
    // 门店定位自动换算结果（供前端提示「位置已自动识别」/「位置待补全」）
    //   status: none=未尝试 / provided=商家地图选点自带 / ok=后端按地址自动换算成功 / failed=换算失败（不阻断）
    geo: {
      status: cert.geoStatus || 'none',
      message: cert.geoMessage || '',
      from: cert.geoFrom || '',
      attemptedAt: cert.geoAttemptedAt || null,
      longitude: (setting && setting.shopLongitude != null) ? setting.shopLongitude : null,
      latitude: (setting && setting.shopLatitude != null) ? setting.shopLatitude : null
    },
    items,
    missing: cls.all,                   // 兼容历史字段名（会影响放行的缺失项合并 = blocking + skippable）
    missingBlocking: cls.blocking,      // 履约必需项（缺则一律拦截）
    missingSkippable: cls.skippable,    // 首单可暂缓项（合规）
    missingOptional: cls.optional,      // 选填待补全项（不拦截）
    firstOrder: {
      limit: dhConfig.FIRST_ORDER_NO_AUTH_LIMIT,
      enabled: dhConfig.FIRST_ORDER_NO_AUTH_LIMIT > 0,
      used: await hasSuccessfulOrder(shopId)
    },
    gating: {
      fulfillment: dhConfig.CERT_GATING.fulfillment,
      compliance:  dhConfig.CERT_GATING.compliance,
      optional:    dhConfig.CERT_GATING.optional || []
    }
  };

  if (orderAmount != null) {
    result.gate = await checkOrderCertGate(shopId, orderAmount, { hasSuccess: result.firstOrder.used, certified });
  }
  return result;
}

/**
 * 下单/支付认证门控判定（服务端权威，POST / 与 POST /:id/pay 共用，两处口径必须一致）
 * @param {string} shopId
 * @param {number} orderAmount 订单总额（totalAmount，元）
 * @param {object} [pre] 预取结果缓存 { hasSuccess, certified }，避免重复查库
 * @returns {Promise<{pass:boolean, via:string|null, missing:{blocking:string[], skippable:string[], optional:string[], all:string[]}, message:string}>}
 */
async function checkOrderCertGate(shopId, orderAmount, pre) {
  const certified = pre && pre.certified != null
    ? pre.certified
    : await Setting.exists({ shopId, 'certification.status': 'approved' });
  if (certified) {
    return {
      pass: true,
      via: 'certified',
      missing: { blocking: [], skippable: [], optional: [], all: [] },
      message: '已认证商家'
    };
  }

  const hasSuccess = pre && pre.hasSuccess != null
    ? pre.hasSuccess
    : await hasSuccessfulOrder(shopId);

  const setting = await Setting.findOne({ shopId }).lean();
  const cls = classifyMissing(setting);

  // 首单直通：从未有成功订单 且 阈值开启 且 金额不超限
  // 首单直通只跳过 compliance 项；fulfillment 缺失仍不放行
  const limit = dhConfig.FIRST_ORDER_NO_AUTH_LIMIT;
  if (!hasSuccess && limit > 0 && Number(orderAmount) <= limit) {
    if (cls.blocking.length === 0) {
      return {
        pass: true,
        via: 'first_order',
        missing: { blocking: [], skippable: cls.skippable, optional: cls.optional, all: cls.skippable },
        message: '首单直通（无成功订单且金额未超限）'
      };
    }
    // 履约必需项缺失：即使首单直通也不放行
    const reason = `首单直通需先补齐履约资料：${cls.blocking.join('、')}`;
    return {
      pass: false,
      via: null,
      missing: { blocking: cls.blocking, skippable: cls.skippable, optional: cls.optional, all: cls.all },
      message: reason
    };
  }

  // 未通过：列出缺失项引导商家补全认证
  const reason = hasSuccess
    ? '该店已有成功订单，需完成商家认证后继续下单'
    : (limit <= 0
        ? '首单直通未开启，需完成商家认证后下单'
        : `订单金额超过首单直通上限 ¥${limit}，需完成商家认证后继续下单`);
  return {
    pass: false,
    via: null,
    missing: { blocking: cls.blocking, skippable: cls.skippable, optional: cls.optional, all: cls.all },
    message: reason
  };
}

/**
 * 校验商家是否已注册（已注册的 phone 视为已通过手机号验证的载体）
 * （预留接口：本轮 REQUIRE_PHONE_VERIFIED=false 不调用，留作开关打开后使用）
 */
async function hasRegisteredPhone(shopId) {
  if (!shopId) return false;
  return !!(await ShopAccount.exists({ shopId }));
}

module.exports = {
  CERT_ITEMS,
  hasSuccessfulOrder,
  hasRegisteredPhone,
  classifyMissing,
  getCertificationStatus,
  checkOrderCertGate
};