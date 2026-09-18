// 鼎恒餐饮 SaaS 平台核心配置（唯一事实源）
// 2026-09 重构：基础版首月策略 + 双阶梯返点体系（统一+分类）+ 阶梯券定价 + 会员权限调整
// 极简、无概率、无倍率：鼎恒币为虚拟数字（零成本），抵用券面额为平台唯一硬成本

// ============ 等级元数据 ============
const LEVEL_NAMES = { basic: '基础版', advanced: '进阶版', premium: '尊享版' };
const LEVEL_RANK = { basic: 0, advanced: 1, premium: 2 };

// ============ 1) 抵用券定价表（COUPONS） ============
// 严格阶梯递减：面额越大越划算（coinPerYuan 每元所需币数递减）
// minLevel：兑换所需最低会员等级；locked=true：暂未开放（平台采购规模达标后开放，仅展示）
const COUPONS = [
  { faceValue: 10,  coinPrice: 800,   coinPerYuan: 80, minOrder: 300,   minLevel: 'basic' },
  { faceValue: 20,  coinPrice: 1500,  coinPerYuan: 75, minOrder: 500,   minLevel: 'basic' },
  { faceValue: 30,  coinPrice: 2100,  coinPerYuan: 70, minOrder: 800,   minLevel: 'basic' },
  { faceValue: 50,  coinPrice: 3200,  coinPerYuan: 64, minOrder: 1200,  minLevel: 'advanced' },
  { faceValue: 100, coinPrice: 6000,  coinPerYuan: 60, minOrder: 2500,  minLevel: 'advanced' },
  { faceValue: 200, coinPrice: 11000, coinPerYuan: 55, minOrder: 4000,  minLevel: 'premium' },
  { faceValue: 300, coinPrice: 15000, coinPerYuan: 50, minOrder: 6000,  minLevel: 'premium', locked: true },
  { faceValue: 500, coinPrice: 24000, coinPerYuan: 48, minOrder: 10000, minLevel: 'premium', locked: true }
];

// ============ 2) 会员鼎恒币汇率（币/元） ============
// 基础版 2元=1币；进阶/尊享 1元=1币
const COIN_RATE = {
  basic: 0.5,
  advanced: 1.0,
  premium: 1.0
};

// ============ 3) 会员月卡定价（人民币 / 鼎恒币） ============
const MEMBER_PRICING = {
  basic:    { name: '基础版', monthlyRmb: 59,  monthlyCoin: 2000 },
  advanced: { name: '进阶版', monthlyRmb: 99,  monthlyCoin: 3000 },
  premium:  { name: '尊享版', monthlyRmb: 199, monthlyCoin: 5000 }
};

// ============ 4) 统一全品类阶梯返点（DEFAULT_TIERS_UNIFIED，全额累进 full） ============
// 默认方案，供应商好理解：基于全品类混合平均利润设计，整单/整月累计额定档
const DEFAULT_TIERS_UNIFIED = [
  { minAmount: 0,       rate: 0.01,  mode: 'full' },
  { minAmount: 50000,   rate: 0.015, mode: 'full' },
  { minAmount: 150000,  rate: 0.02,  mode: 'full' },
  { minAmount: 500000,  rate: 0.025, mode: 'full' },
  { minAmount: 1000000, rate: 0.03,  mode: 'full' },
  { minAmount: 2000000, rate: 0.04,  mode: 'full' },
  { minAmount: 5000000, rate: 0.05,  mode: 'full' }
];

// ============ 5) 品类分类阶梯返点（DEFAULT_TIERS_BY_CATEGORY，全额累进 full） ============
// 供应商自选 byCategory 模式时按品类毛利分档执行；各档按月度同品类累计采购额定档
const DEFAULT_TIERS_BY_CATEGORY = {
  // 低毛利品类（蔬菜/肉类/冻品/粮油/海鲜等）——供应商净利润 1%-3%，返点极低
  lowMargin: [
    { minAmount: 0,       rate: 0.005, mode: 'full' },
    { minAmount: 50000,   rate: 0.01,  mode: 'full' },
    { minAmount: 150000,  rate: 0.015, mode: 'full' },
    { minAmount: 500000,  rate: 0.02,  mode: 'full' },
    { minAmount: 1000000, rate: 0.025, mode: 'full' },
    { minAmount: 2000000, rate: 0.03,  mode: 'full' },
    { minAmount: 5000000, rate: 0.035, mode: 'full' }
  ],
  // 中毛利品类（调料/一次性用品/餐厨用品/餐具/纸品等）——净利润 3%-5%
  midMargin: [
    { minAmount: 0,       rate: 0.01, mode: 'full' },
    { minAmount: 50000,   rate: 0.02, mode: 'full' },
    { minAmount: 150000,  rate: 0.03, mode: 'full' },
    { minAmount: 500000,  rate: 0.04, mode: 'full' },
    { minAmount: 1000000, rate: 0.05, mode: 'full' },
    { minAmount: 2000000, rate: 0.06, mode: 'full' },
    { minAmount: 5000000, rate: 0.07, mode: 'full' }
  ],
  // 高毛利品类（酒水/饮料/啤酒/白酒/特色干货/休闲食品/零食等）——净利润 10%-25%
  highMargin: [
    { minAmount: 0,       rate: 0.02,  mode: 'full' },
    { minAmount: 50000,   rate: 0.03,  mode: 'full' },
    { minAmount: 150000,  rate: 0.05,  mode: 'full' },
    { minAmount: 500000,  rate: 0.07,  mode: 'full' },
    { minAmount: 1000000, rate: 0.09,  mode: 'full' },
    { minAmount: 2000000, rate: 0.10,  mode: 'full' },
    { minAmount: 5000000, rate: 0.12,  mode: 'full' }
  ]
};

// ============ 6) 品类毛利分类映射（CATEGORY_CLASSIFICATION） ============
// 未命中映射的品类按低毛利（lowMargin）保守兜底
const CATEGORY_CLASSIFICATION = {
  lowMargin:  ['蔬菜', '肉类', '冻品', '粮油', '海鲜', '生鲜', '豆制品'],
  midMargin:  ['调料', '调味品', '一次性用品', '餐厨用品', '餐具', '纸品', '清洁用品'],
  highMargin: ['酒水', '饮料', '啤酒', '白酒', '红酒', '特色干货', '休闲食品', '零食', '罐头']
};

// ============ 7) 其他常量 ============
const coinExpireDays = 90;    // 鼎恒币有效期 90 天
const couponExpireDays = 30;  // 抵用券有效期 30 天

// ============ 商家认证 · 首单直通阈值（元） ============
// 未认证商家「首单直通」条件：该店从未有成功订单（payStatus=paid）且订单金额 ≤ 该阈值；
// 改为 0 即关闭首单直通（所有未认证商家下单一律要求先完成认证）。
const FIRST_ORDER_NO_AUTH_LIMIT = 500;

// ============ 商家认证 · 手机号验证开关 ============
// true: 已注册手机号必须通过短信通道二次验证（等 AppID/短信通道就绪后打开）；
// false: 已注册手机号即视为已验证，不阻断下单（默认；上线初期 AppID 未配置）。
const REQUIRE_PHONE_VERIFIED = false;

// ============ 商家认证 · 缺项分级（履约必需 / 合规可缓 / 选填可补）============
// 下单认证门控把缺失项分成三档：
//   fulfillment（履约必需）：缺这些无法配送，首单直通也不能跳过；
//                          下单 / 支付 / 资料齐后必须都已满足才能放行。
//   compliance（合规可缓）：首单直通时可跳过，仅认证审核时强制要求。
//   optional（选填可补）：不阻断任何链路（不影响首单直通、不影响正常下单），
//                       仅作为「待补全」提示；缺失时前端引导补全但不拦截。
// 规则与 CERT_ITEMS 的 key 对应（utils/certification.js）：
//   - shopAddress → fulfillment（详细地址是履约必需：供应商看文字地址就能送货）
//   - phoneVerified → fulfillment（受 REQUIRE_PHONE_VERIFIED 开关控制）
//   - businessLicense / storeFrontPhoto → compliance
//   - location（门店经纬度）→ optional
//       【2026-09 上线加固调整】原为 fulfillment，现降级为 optional：
//       经纬度可由后端按文字地址自动地理编码换算（utils/geocode.js）得到，
//       换算失败属于技术原因，不应阻断商家下单（地址已能支撑配送）。
//       前端仍保留「在地图上标注位置」，但属选填。
// 调整时务必同步 utils/certification.js 的 CERT_ITEMS 列表。
const CERT_GATING = {
  fulfillment: ['shopAddress', 'phoneVerified'],
  compliance:  ['businessLicense', 'storeFrontPhoto'],
  optional:    ['location']
};

// ============ 商家认证 · 门店定位自动换算（地理编码）============
// 商家在认证页只填文字地址，后端用高德 Web 服务「地理编码 API」把地址换算成经纬度，
// 商家无需理解经纬度；换算失败不阻断认证/下单（经纬度降级为 optional）。
// 供应商选择：高德（已有可用 Web 服务 Key，无需新增平台账号/域名白名单）；
//            腾讯位置服务需重新注册+申请 Key+配置 referer，故不采用。
// 实现：utils/geocode.js（本区块是限速/超时/重试/缓存的唯一事实源）
//   - envKeys：只用 Web 服务 Key。**不可**使用 JS API Key（AMAP_JS_KEY 直连 Web 服务会返 USERKEY_PLAT_NOMATCH）
//   - minIntervalMs：免费 Key QPS 很低（实测 >3 QPS 返 CUQPS_HAS_EXCEEDED_THE_LIMIT），
//                    故所有请求串行排队并间隔至少该毫秒数
//   - maxRetry/retryBackoffMs：仅对「限流/网络/超时」这类瞬时错误退避重试
//   - cacheTtlMs/failCacheTtlMs：成功结果缓存 24h；失败结果短缓存 5min，避免商家反复提交打爆配额
const GEOCODE = {
  provider: 'amap',
  envKeys: ['AMAP_WEB_KEY', 'AMAP_KEY'],
  minIntervalMs: 350,
  timeoutMs: 5000,
  maxRetry: 2,
  retryBackoffMs: 600,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  failCacheTtlMs: 5 * 60 * 1000,
  cacheMax: 500
};

// ============ 采购下单 · 草稿与锁券时效 ============
// 未支付草稿保留时长：超过后软删（status → 已取消，不物理删除）
const DRAFT_ORDER_TTL_HOURS = 24;
// 抵用券锁定时长：超过未支付自动释放回未使用（订单本身保留）
const COUPON_LOCK_MINUTES = 30;
// 会员价值基准（币/天）：升级折算剩余天数价值用
//   basic 2000/30≈67，advanced 3000/30=100，premium 5000/30≈167
const DAILY_COIN = { basic: 67, advanced: 100, premium: 167 };

// ============ 功能权限映射（接口鉴权 + 前端展示，按会员等级开放） ============
// 注意：顾客积分已下放至基础版（basic/advanced/premium 均可用）；
//       无有效会员（未开通/体验或月卡过期）一律不可用，由业务层校验 memberExpire。
const features = {
  customerPoints: ['basic', 'advanced', 'premium'],    // 顾客积分（食客积分）——基础版起开放
  marketingDiscount: ['advanced', 'premium'],          // 满减活动（进阶版+）
  marketingCategoryDiscount: ['premium'],              // 折扣活动（指定分类，尊享版专属）
  marketingRecharge: ['premium'],                      // 充值送活动（尊享版专属）
  marketingFull: ['premium'],                          // 兼容旧字段（满减+充值送等高级营销合集）
  reportBasic: ['advanced', 'premium'],                // 经营报表
  reportAdvanced: ['premium']                          // 顾客画像、损耗分析
};

// ============ 双产品线（2026-09 采购为核心重构） ============
// 产品线 A：扫码点餐（POS）——basic 永久免费；advanced/premium 付费
// 产品线 B：采购管家（PURCHASE）——free 永久免费；plus/pro 付费
// 两条线独立开通、独立到期；鼎恒币为两线之间唯一兑换桥梁（诱导，不捆绑）。
// 说明：本区块为纯增量，下方「派生视图」保留历史字段名，老代码零改动可继续消费。

// 等级秩（两线各自独立，互不比较）
const POS_LEVELS = { basic: 0, advanced: 1, premium: 2 };
const PURCHASE_LEVELS = { free: 0, plus: 1, pro: 2 };
const POS_LEVEL_NAMES = { basic: '点餐基础版', advanced: '点餐进阶版', premium: '点餐尊享版' };
const PURCHASE_LEVEL_NAMES = { free: '采购免费版', plus: '采购省钱卡', pro: '采购省钱卡Pro' };

// 点餐线付费档定价（basic 永久免费，不可购买）
const POS_PRICING = {
  advanced: { name: '点餐进阶版', monthlyRmb: 39, monthlyCoin: 1500 },
  premium:  { name: '点餐尊享版', monthlyRmb: 79, monthlyCoin: 2400 }
};

// 采购线付费档定价（free 永久免费，不可购买）
const PURCHASE_PRICING = {
  plus: { name: '采购省钱卡',   monthlyRmb: 99,  monthlyCoin: 3000 },
  pro:  { name: '采购省钱卡Pro', monthlyRmb: 199, monthlyCoin: 5000 }
};

// 采购线返币率（币/元）：free 2元=1币；plus/pro 1元=1币
const PURCHASE_COIN_RATE = { free: 0.5, plus: 1.0, pro: 1.0 };

// 会员价值基准（币/天，升级折算剩余天数用）：月卡币价 / 30
const DAILY_COIN_POS = { basic: 0, advanced: 50, premium: 80 };
const DAILY_COIN_PURCHASE = { free: 0, plus: 100, pro: 167 };

// 点餐线功能权限（按点餐等级 + 有效期开放）
const posFeatures = {
  customerPoints: ['basic', 'advanced', 'premium'],         // 顾客积分：免费起开放（粘性工具）
  marketingDiscount: ['advanced', 'premium'],                // 满减
  marketingCategoryDiscount: ['premium'],                    // 分类折扣
  marketingRecharge: ['premium'],                            // 充值送
  reportBasic: ['advanced', 'premium'],                      // 经营报表
  reportAdvanced: ['premium'],                               // 顾客画像/损耗分析
  premiumTheme: ['advanced', 'premium'],                     // 高级主题/自定义头图/LOGO
  storedValue: ['advanced', 'premium']                       // 顾客储值
};

// 采购线功能权限（按采购等级开放；free 永久可用基础能力）
const purchaseFeatures = {
  basicReplenish: ['free', 'plus', 'pro'],                   // 基础补货建议：免费
  smartForecast: ['plus', 'pro'],                            // 30 天销量预测
  priceMonitor: ['plus', 'pro'],                             // 采购价监控
  largeCoupon: ['plus', 'pro'],                              // 大额券档（100 元）
  priceCompare: ['pro'],                                     // 比价 / 降价提醒
  priorityDelivery: ['pro']                                  // 优先配送标识
};

// 券所需采购等级映射：原券 needLevel(basic/advanced/premium) → 采购线(free/plus/pro)
const COUPON_NEED_PURCHASE_LEVEL = { basic: 'free', advanced: 'plus', premium: 'pro' };

// Addon 零成本币兑增值包（阶段3）：用鼎恒币兑换的限时功能包，边际成本≈0
// 定位：给商家更快到期的小额币一个"泄洪池"，同时让免费档用户零成本尝鲜付费能力。
// 原则：小额定价（400~600 币，专收快到期零钱）、必须真有用、不打折会员等级。
// 结构：{ key, name, coinPrice, days, productLine, features[], desc }
//   features 为要临时解锁的功能键（对应 posFeatures / purchaseFeatures 的键）
const ADDONS = [
  {
    key: 'theme30', name: '高级装修 30 天', coinPrice: 500, days: 30, productLine: 'pos',
    features: ['premiumTheme'],
    desc: '高级主题 + 专属头图/LOGO 装修，30 天内自由使用'
  },
  {
    key: 'marketing7', name: '营销工具 7 天包', coinPrice: 400, days: 7, productLine: 'pos',
    features: ['marketingDiscount', 'marketingCategoryDiscount', 'marketingRecharge'],
    desc: '满减 / 分类折扣 / 充值送，7 天体验完整营销能力'
  },
  {
    key: 'forecast7', name: '智能预测 7 天包', coinPrice: 600, days: 7, productLine: 'purchase',
    features: ['smartForecast', 'priceMonitor'],
    desc: '30 天销量预测 + 采购价监控，7 天体验采购预测能力'
  }
];

// ============ 派生视图（兼容历史字段名，老代码零改动可继续消费） ============
// 会员定价：{ name, price(人民币月价), coinCost(币月价) }
const membership = Object.keys(MEMBER_PRICING).reduce((acc, lv) => {
  acc[lv] = {
    name: MEMBER_PRICING[lv].name,
    price: MEMBER_PRICING[lv].monthlyRmb,
    coinCost: MEMBER_PRICING[lv].monthlyCoin
  };
  return acc;
}, {});

// ============ 支付资金流模式（2026-09 供应商进件上线） ============
// 业务口径（绝对金额，非比例）：供应商报供货价 → 平台加价得卖价 → 门店按卖价付款
//   → 供应商实得供货价全额（一分不少）→ 平台实得加价部分（加多少拿多少）。
// 金额拆分计算统一走 utils/split.js（唯一正确实现），本配置只决定「资金走哪条路」，不影响金额。
//
// 'supplier_first'（默认，钱进供应商）：门店货款直接进供应商的微信特约商户号（sub_mchid），
//   平台随后发起服务商分账，只抽走「加价部分」给平台自己。
//   - 微信规则：单笔订单分账总额不得超过收款商户在商户平台设置的「订单分账最大比例」（默认上限 30%）。
//   - 钱进平台再分给供应商：供应商占货款九成以上 → 超过 30% 默认限额，须向微信申请高比例分账白名单（1-4 周，不一定批）。
//   - 钱先进供应商：平台只抽加价部分（远低于 30%）→ 默认限额内，无需申请白名单。
//
// 'platform_first'（钱进平台）：门店货款先进平台账户，再按供货价分账给供应商。
//   【切换前提】必须先拿到微信支付「高比例分账」白名单批准，否则分账请求会被微信拒绝。
//   切换前请确认：1) 白名单已批复；2) 所有在售供应商已完成进件（有可用特约商户号）。
//
// 运行时读取：所有支付/分账代码通过 utils/payRuntime.getPaymentFlowMode() 动态读取
// （开发者后台可在「系统设置」切换，立即生效，不用重启）；本常量为缺省默认值（唯一事实源）。
const PAYMENT_FLOW_MODE = 'supplier_first';

// 归一化资金流模式：非法值回退默认 supplier_first
function resolvePaymentFlowMode(v) {
  return v === 'platform_first' ? 'platform_first' : 'supplier_first';
}

// ============ 平台加价率（采购分账层） ============
// 采购订单零售价 = 供货价 × (1 + 加价率/100)，差价归平台；
// 可按供应商/品类在 SplitRule 集合覆盖，未配置时兜底此默认值
const DEFAULT_PLATFORM_RATE = 6;

// ============ 卖价底线（最低加价率） ============
// 平台盈利 = 卖价 − 供货价 − 平台成本（主要是抵扣券成本），故：
//   卖价底线 = 供货价 × (1 + 最低加价率)
// 【硬地板语义】最低加价率是平台不允许突破的成本底线（不是建议值）：
//   - 下单校验：卖价 < 供货价 × (1 + 最低加价率) → 拒绝；
//   - 定价工作台写入校验：同上；
//   - 一键定价也会把计算出的加价率与最低加价率比对，命中硬地板则强制拉到最低加价率。
// 最低加价率由开发者在「系统设置」配置（0~1 的小数），默认 0.05（5%）。
// 2026-09 调整：默认值由 0.10 下调到 0.05——10% 太高，挡住了低价跑量的需求。
const DEFAULT_MIN_MARKUP_RATE = 0.05;

// 最低加价率的绝对下限（0.03 = 3%）：3% 就是平台成本线，不能再低。
// 配置值低于成本线一律收敛到此处，避免配置失误导致「定价即亏本」。
const MIN_MARKUP_RATE_HARD_FLOOR = 0.03;

// 归一化最低加价率：缺省/非法（非数字、<0）回退默认值；低于 3% 成本线收敛到 3%；>1 收敛为 1
function resolveMinMarkupRate(v) {
  if (v === null || v === undefined || v === '') return DEFAULT_MIN_MARKUP_RATE;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return DEFAULT_MIN_MARKUP_RATE;
  if (n > 1) return 1;
  return n < MIN_MARKUP_RATE_HARD_FLOOR ? MIN_MARKUP_RATE_HARD_FLOOR : n;
}

// 元 → 分（整数）：金额比较统一用「分」，避免浮点误差
function toFen(yuan) {
  return Math.round((Number(yuan) || 0) * 100);
}

// 最低卖价（分，整数）：向上取整到分( 供货价分 × (1 + 最低加价率) )
// 例：供货价 3.20 元 = 320 分、比例 0.10 → 320×1.10=352 → 352 分
function computeMinSalePriceFen(costPrice, rate) {
  const costFen = toFen(costPrice);
  const rawFen = costFen * (1 + resolveMinMarkupRate(rate));
  // 先规整浮点误差（如 1000×1.1=1100.0000000000002）再向上取整到分
  return Math.ceil(Number(rawFen.toFixed(6)));
}

// 最低卖价（元）：分转元显示，与 computeMinSalePriceFen 共用同一计算逻辑
// 例：供货价 10.00、比例 0.10 → 11.00
function computeMinSalePrice(costPrice, rate) {
  return +(computeMinSalePriceFen(costPrice, rate) / 100).toFixed(2);
}

// ============ 【2026-09 上线加固】一键定价配置 ============
// 保底加价额（元，默认 0.5）：小额商品加价率算下来金额太小（1 元加 10% 只有 1 角钱），
// 通过「保底加价额」兜底——卖价至少比供货价高 0.5 元，覆盖操作/履约成本。
// 【2026-09 低价商品加价上限】本值可在「定价工作台」页面上直接改（只随本次请求生效，不落库）。
const MIN_MARKUP_AMOUNT = 0.5;

// 加价率上限倍数（默认 2）：保底加价额对极低价商品过于激进
// （0.3 元的打包盒按保底加 0.5 元 → 实际加价率 167%）。为此给保底加一道上限——
// 单个商品的实际加价率不得超过「设定加价率 × 本倍数」；超过时放弃保底、改用按比例算出的精确值。
// 例：设 8%、上限 2 倍（16%）：0.3 元商品 → 加价 0.3×16% = 0.048 元 → 卖价 0.35 元。
// 【2026-09 低价商品加价上限】本值同样可在「定价工作台」页面上直接改（只随本次请求生效，不落库）。
const MARKUP_CAP_MULTIPLIER = 2;
// 页面可填范围（服务端与页面共用同一套校验口径）
const MIN_MARKUP_AMOUNT_MAX = 10;           // 保底加价额上限（元）
const MARKUP_CAP_MULTIPLIER_MIN = 1;        // 上限倍数下限：低于 1 倍会卖得比设定加价率还低
const MARKUP_CAP_MULTIPLIER_MAX = 10;       // 上限倍数上限（倍）

// 尾数取整规则（历史常量，保留兜底）：定价后卖价落到哪个尾数，让价格更整、好读。
//   'none' 不取整（精确到分）｜'round' 四舍五入到角｜'floor_to_9' 向下到 .9｜'ceil_to_9' 向上到 .9
// 【2026-09 尾数取整可配置】一键定价改为按「定价工作台页面上的选项」取整，
// 本常量只在调用方未传取整选项时兜底（老调用方/单元测试口径不变）。
const PRICE_ROUND_TAIL = 'ceil_to_9';

// ============ 【2026-09】尾数取整选项（定价工作台页面可选，不进后台配置、不落库）============
// mode      'none' 不取整（精确到分）｜'round' 四舍五入到角｜'ceil' 向上取整到尾数 .X｜'int' 向上取整到整数
// tailDigit mode='ceil' 时的尾数（0~9），页面上可自由填，不局限 .9/.8/.7/.6
// guard     取整保护（默认开启）：单个商品取整后的加价率不得超过「生效加价率 × 1.5」，
//           超出则放弃取整、改用精确值。例：设 8%（上限 12%），3 元商品取整会到 30% → 放弃取整按 3.24 收。
const ROUND_MODES = ['none', 'round', 'ceil', 'int'];
const DEFAULT_ROUND_MODE = 'round';   // 页面默认：四舍五入到角（比向上取整到 .9 温和，误差最小）
const DEFAULT_ROUND_TAIL_DIGIT = 9;   // 「向上取整到 .X」的默认尾数
const ROUND_GUARD_MULTIPLIER = 1.5;   // 取整保护上限 = 生效加价率 × 1.5
const DEFAULT_ROUND_GUARD = true;     // 取整保护默认开启

// 归一化取整方式：非法返回 null；兼容历史规则串（'ceil_to_9' / 'floor_to_9'）
function normalizeRoundMode(v) {
  const s = String(v == null ? '' : v).trim();
  if (ROUND_MODES.includes(s)) return s;
  if (s === 'ceil_to_9' || s === 'floor_to_9') return 'ceil';
  return null;
}

// 归一化尾数：0~9 的整数，非法值回退 fallback
function normalizeRoundTailDigit(v, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(9, Math.max(0, Math.floor(n)));
}

/**
 * 解析尾数取整选项
 * @param {object} [opt] { roundMode, roundTail, roundGuard }
 * @returns {{ mode:string, tailDigit:number, guard:boolean }}
 * 未传 opt（老调用方/单元测试）→ 历史行为：向上取整到 .9、不启用取整保护
 * 传了 opt（定价工作台接口）  → 缺省 mode='round'（四舍五入到角）、guard=true（取整保护开启）
 */
function resolveRoundOptions(opt) {
  if (opt === null || opt === undefined) {
    return { mode: 'ceil', tailDigit: 9, guard: false };
  }
  const mode = normalizeRoundMode(opt.roundMode) || DEFAULT_ROUND_MODE;
  let tailDigit = normalizeRoundTailDigit(opt.roundTail, null);
  if (tailDigit == null) {
    // 兼容历史规则串里带尾数的写法（ceil_to_9 → 9）
    const m = /_(\d)$/.exec(String(opt.roundMode == null ? '' : opt.roundMode));
    tailDigit = m ? Number(m[1]) : DEFAULT_ROUND_TAIL_DIGIT;
  }
  const g = opt.roundGuard;
  const guard = (g === undefined || g === null || g === '')
    ? DEFAULT_ROUND_GUARD
    : !!(g === true || g === 1 || g === '1' || g === 'true');
  return { mode, tailDigit, guard };
}

// 取整选项的中文描述（页面提示 / 接口回显共用同一套文案）
function roundOptionsText(mode, tailDigit) {
  switch (normalizeRoundMode(mode)) {
    case 'none':  return '不取整（精确到分）';
    case 'int':   return '向上取整到整数';
    case 'ceil':  return '向上取整到 .' + normalizeRoundTailDigit(tailDigit, DEFAULT_ROUND_TAIL_DIGIT);
    case 'round': return '四舍五入到角';
    default:      return '四舍五入到角';
  }
}

// 成本线保护比例（默认 0.03 = 3%）：一键定价时若算出的加价率低于成本线，
// 强制拉到硬地板（系统设置·最低加价率，缺省 DEFAULT_MIN_MARKUP_RATE），避免定价反而让平台亏本。
const COST_FLOOR_RATE = 0.03;

// ============ 【2026-09 低价商品加价上限】保底加价额 / 上限倍数 归一化 ============
/**
 * 归一化「保底加价额」（元）：页面可传入；非法/越界回退默认值 MIN_MARKUP_AMOUNT
 * @param {*} v 数字 / 数字串；null/undefined/'' 视为未传（用默认值）
 * @returns {number} 0 ~ MIN_MARKUP_AMOUNT_MAX 之间的数值（保留 2 位小数）
 */
function resolveMinMarkupAmount(v) {
  if (v === null || v === undefined || v === '') return MIN_MARKUP_AMOUNT;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return MIN_MARKUP_AMOUNT;
  return Math.min(MIN_MARKUP_AMOUNT_MAX, +n.toFixed(2));
}

/**
 * 归一化「加价率上限倍数」：页面可传入；非法回退默认值 MARKUP_CAP_MULTIPLIER，最低 1 倍
 * （低于 1 倍会算出「比设定加价率还低」的卖价，保守收敛到 1 倍）
 * @param {*} v 数字 / 数字串；null/undefined/'' 视为未传（用默认值）
 * @returns {number} MARKUP_CAP_MULTIPLIER_MIN ~ MARKUP_CAP_MULTIPLIER_MAX 之间的数值（保留 2 位小数）
 */
function resolveMarkupCapMultiplier(v) {
  if (v === null || v === undefined || v === '') return MARKUP_CAP_MULTIPLIER;
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return MARKUP_CAP_MULTIPLIER;
  return Math.min(MARKUP_CAP_MULTIPLIER_MAX, Math.max(MARKUP_CAP_MULTIPLIER_MIN, +n.toFixed(2)));
}

/**
 * 一键定价（详细版）：按统一加价率算卖价（带保底 + 加价率上限 + 成本线保护 + 尾数取整 + 取整保护）
 * @param {number} costPrice      供货价（元）
 * @param {number} rate           加价率（如 0.10 表示 10%）
 * @param {number} [minMarkupRate] 可选：硬地板（系统设置·最低加价率），
 *                                 命中成本线保护时按此值重算；缺省回退 DEFAULT_MIN_MARKUP_RATE
 * @param {object} [options]      可选：定价页面选项（定价工作台传入，只随本次请求生效、不落库）
 *                                尾数取整 { roundMode, roundTail, roundGuard } +
 *                                保底/上限 { minMarkupAmount, markupCapMultiplier }
 *                                不传＝历史行为（向上取整到 .9、不启用取整保护、保底 0.5、上限 2 倍）；
 *                                传对象但字段留空＝页面默认（四舍五入到角、取整保护开启、保底 0.5、上限 2 倍）
 * @returns {{
 *   salePrice:number, rawSalePrice:number, markupRate:number, actualMarkupRate:number, rawMarkupRate:number,
 *   markupAmount:number, capped:boolean, rounded:boolean, roundingSkipped:boolean,
 *   roundMode:string, roundTail:number, roundGuard:boolean, roundGuardLimit:number|null,
 *   minMarkupAmount:number, markupCapMultiplier:number, markupCapRate:number, floorDropped:boolean
 * }}
 *   salePrice           最终卖价（元，已应用尾数取整与取整保护）
 *   rawSalePrice        取整前的精确卖价（元，向上取整到分）
 *   markupRate          实际生效的加价率（被成本线保护拉高时返回硬地板值）
 *   actualMarkupRate    最终卖价真实加价率：(卖价-供货价)/供货价
 *   rawMarkupRate       取整前真实加价率（用于对比取整放大了多少）
 *   markupAmount        卖价 − 供货价（元）
 *   capped              true 表示触发了成本线保护（实际加价率 < COST_FLOOR_RATE，被强制拉到硬地板）
 *   rounded             最终卖价是否真的应用了取整
 *   roundingSkipped     true 表示因「取整保护」或硬地板兜底而放弃取整、改用精确值
 *   roundGuardLimit     取整保护上限加价率（生效加价率 × 1.5）
 *   minMarkupAmount     本次实际使用的保底加价额（元）
 *   markupCapMultiplier 本次实际使用的加价率上限倍数
 *   markupCapRate       上限加价率（生效加价率 × 上限倍数）
 *   floorDropped        true 表示保底加价额被上限截断（放弃保底、改用按比例算出的精确值）
 */
function computeBulkSalePriceDetailed(costPrice, rate, minMarkupRate, options) {
  const roundOpt = resolveRoundOptions(options);
  const opt = (options && typeof options === 'object') ? options : {};
  // 【2026-09 低价商品加价上限】保底加价额 / 上限倍数：页面可传，缺省用服务端默认值
  const minMarkupAmount = resolveMinMarkupAmount(opt.minMarkupAmount);
  const capMultiplier = resolveMarkupCapMultiplier(opt.markupCapMultiplier);
  const cost = +(Number(costPrice) || 0);
  if (!(cost > 0)) {
    // 供货价为 0 或非法值：一律返回 0，由调用方决定是否跳过
    return {
      salePrice: 0, rawSalePrice: 0, markupRate: 0, actualMarkupRate: 0, rawMarkupRate: 0,
      markupAmount: 0, capped: false, rounded: false, roundingSkipped: false,
      roundMode: roundOpt.mode, roundTail: roundOpt.tailDigit, roundGuard: roundOpt.guard, roundGuardLimit: null,
      minMarkupAmount, markupCapMultiplier: capMultiplier, markupCapRate: 0, floorDropped: false
    };
  }
  const r = Math.max(0, Number(rate) || 0);
  // 1) 比例卖价 / 保底卖价 / 上限卖价（上限卖价 = 供货价 × (1 + 加价率 × 上限倍数)）
  //    取「比例卖价」与「保底卖价」中较大者，但保底卖价不得超过上限卖价：
  //    超过时放弃保底、改用按比例算出的精确值（例：0.3 元设 8%、上限 2 倍 → 加价 0.048 → 卖价 0.35）
  const ratioPrice = cost * (1 + r);
  const floorPrice = cost + minMarkupAmount;
  let capPrice = cost * (1 + r * capMultiplier);
  let rawPrice = Math.max(ratioPrice, Math.min(floorPrice, capPrice));
  let floorDropped = floorPrice > capPrice + 1e-9;
  // 2) 实际加价率（用于判断是否触发成本线保护）
  const effectiveMarkupRate = (rawPrice - cost) / cost;
  let capped = false;
  let finalRate = r;
  if (effectiveMarkupRate < COST_FLOOR_RATE) {
    // 触底：按硬地板（系统设置·最低加价率）重算；未传时回退默认值
    finalRate = resolveMinMarkupRate(minMarkupRate == null ? DEFAULT_MIN_MARKUP_RATE : minMarkupRate);
    // 硬地板重算同样受「加价率上限倍数」约束：按生效加价率重算上限卖价
    capPrice = cost * (1 + finalRate * capMultiplier);
    rawPrice = Math.max(cost * (1 + finalRate), Math.min(floorPrice, capPrice));
    floorDropped = floorPrice > capPrice + 1e-9;
    capped = true;
  }
  // 精确卖价（向上取整到分）：先规整浮点误差再取整，保证不低于「供货价 × (1 + 生效加价率)」
  const rawSalePrice = +(Math.ceil(Number((rawPrice * 100).toFixed(6))) / 100).toFixed(2);

  // 3) 尾数取整（按页面选项：不取整 / 四舍五入到角 / 向上到 .X / 向上到整数）
  const roundedPrice = roundTailPrice(rawPrice, roundOpt.mode, roundOpt.tailDigit);
  let salePrice = roundedPrice;
  let rounded = roundOpt.mode !== 'none';
  let roundingSkipped = false;
  // 4) 取整保护：取整后加价率 > 生效加价率 × 1.5 → 放弃取整，改用精确值
  const roundGuardLimit = +(finalRate * ROUND_GUARD_MULTIPLIER).toFixed(6);
  if (roundOpt.guard && roundOpt.mode !== 'none' && ((roundedPrice - cost) / cost) > roundGuardLimit + 1e-9) {
    salePrice = rawSalePrice;
    rounded = false;
    roundingSkipped = true;
  }
  // 5) 硬地板兜底：取整（尤其四舍五入）可能把价格裁到「最低卖价」之下而写入被拒，这里拉回底线
  const floorYuan = computeMinSalePrice(cost, minMarkupRate == null ? DEFAULT_MIN_MARKUP_RATE : minMarkupRate);
  if (salePrice + 0.0001 < floorYuan) {
    salePrice = floorYuan;
    rounded = false;
    roundingSkipped = true;
  }
  salePrice = +salePrice.toFixed(2);
  return {
    salePrice,
    rawSalePrice,
    markupRate: finalRate,
    actualMarkupRate: +(((salePrice - cost) / cost) || 0).toFixed(4),
    rawMarkupRate: +(((rawSalePrice - cost) / cost) || 0).toFixed(4),
    markupAmount: +(salePrice - cost).toFixed(2),
    capped,
    rounded,
    roundingSkipped,
    roundMode: roundOpt.mode,
    roundTail: roundOpt.tailDigit,
    roundGuard: roundOpt.guard,
    roundGuardLimit,
    // 【2026-09 低价商品加价上限】本次实际使用的保底/上限参数与是否被上限截断
    minMarkupAmount,
    markupCapMultiplier: capMultiplier,
    markupCapRate: +(finalRate * capMultiplier).toFixed(4),
    floorDropped
  };
}

/**
 * 一键定价（兼容旧签名）：返回历史精简字段，口径与历史保持一致
 * （向上取整到 .9、不启用取整保护）——老调用方与单元测试零改动
 */
function computeBulkSalePrice(costPrice, rate, minMarkupRate) {
  const d = computeBulkSalePriceDetailed(costPrice, rate, minMarkupRate, {
    roundMode: PRICE_ROUND_TAIL, roundTail: 9, roundGuard: false
  });
  return {
    salePrice: d.salePrice,
    markupRate: d.markupRate,
    actualMarkupRate: d.actualMarkupRate,
    markupAmount: d.markupAmount,
    capped: d.capped
  };
}

/**
 * 尾数取整：把价格裁到「整.9」或其它规则
 * @param {number} price  原价（元）
 * @param {string} rule   'none' 不取整 | 'round' 四舍五入到角 | 'ceil' 向上取整到尾数 .X
 *                        | 'int' 向上取整到整数 | 'floor_to_9' 向下到 .9 | 'ceil_to_9' 向上到 .9（历史）
 * @param {number} [tailDigit] rule='ceil' 时的尾数（0~9，可自由填），缺省 9
 * @returns {number} 取整后价格（元，保留两位小数）
 */
function roundTailPrice(price, rule, tailDigit) {
  const p = +(Number(price) || 0);
  switch (rule) {
    case 'round':        return +(Math.round(p * 10) / 10).toFixed(2);
    case 'int':          return +(Math.ceil(p)).toFixed(2);
    case 'floor_to_9': {
      // 向下取整到 .9：先取 (整数部分 + 0.9)，若 > 原价则减 1 落到上一档 .9
      // 10.0 → 10.9 > 10 → 9.9（少赚 0.1，平台少赚）
      // 37.4 → 37.9 > 37.4 → 36.9
      // 36.9 → 36.9 = 36.9 → 36.9
      const base = Math.floor(p);
      let cand = base + 0.9;
      if (cand > p + 0.0001) cand -= 1;
      return +cand.toFixed(2);
    }
    case 'ceil':
    case 'ceil_to_9': {
      // 向上取整到 .X（X 默认 9，页面可自定义）：先取 (整数部分 + X/10)，
      // 若 < 原价则加 1 进位到下一档 .X
      // 10.0  → 10.9 > 10 → 10.9
      // 10.99 → 10.9 < 10.99 → 11.9（必须进位）
      // 36.9  → 36.9 = 36.9 → 36.9
      // 11.0  → 11.9 > 11 → 11.9
      const tail = rule === 'ceil' ? normalizeRoundTailDigit(tailDigit, 9) : 9;
      const base = Math.floor(p);
      let cand = base + tail / 10;
      if (cand + 0.0001 < p) cand += 1;
      return +cand.toFixed(2);
    }
    case 'none':
    default:
      return +(p).toFixed(2);
  }
}

// 采购返币率
const coinRate = COIN_RATE;

// 抵用券：补全 type（purchase_<面额>）/ coinCost / needLevel 历史字段名
const coupons = COUPONS.map(c => ({
  type: `purchase_${c.faceValue}`,
  faceValue: c.faceValue,
  coinCost: c.coinPrice,
  coinPrice: c.coinPrice,
  coinPerYuan: c.coinPerYuan,
  minOrder: c.minOrder,
  needLevel: c.minLevel,
  minLevel: c.minLevel,
  locked: !!c.locked
}));

/**
 * 判断品类所属毛利档：'lowMargin' | 'midMargin' | 'highMargin'
 * 双向 includes 模糊匹配（如 '白酒/茅台' 命中 '白酒'）；未命中保守返回 lowMargin
 */
function classifyMarginCategory(categoryName) {
  const name = String(categoryName || '').trim();
  if (!name || name === '未分类') return 'lowMargin';
  for (const key of ['highMargin', 'midMargin', 'lowMargin']) {
    if (CATEGORY_CLASSIFICATION[key].some(k => name.includes(k) || k.includes(name))) {
      return key;
    }
  }
  return 'lowMargin'; // 保守兜底
}

// 会员是否在有效期内（未开通/已过期均视为无有效会员）
function isMembershipActive(member) {
  if (!member || !member.memberExpire) return false;
  return new Date(member.memberExpire).getTime() > Date.now();
}

module.exports = {
  // 新 canonical 常量
  LEVEL_NAMES,
  LEVEL_RANK,
  COUPONS,
  COIN_RATE,
  MEMBER_PRICING,
  DEFAULT_TIERS_UNIFIED,
  DEFAULT_TIERS_BY_CATEGORY,
  DEFAULT_PLATFORM_RATE,
  // 【2026-09 供应商进件】支付资金流模式（supplier_first 默认 / platform_first 需白名单）
  PAYMENT_FLOW_MODE,
  resolvePaymentFlowMode,
  CATEGORY_CLASSIFICATION,
  DAILY_COIN,
  features,
  coinExpireDays,
  couponExpireDays,
  FIRST_ORDER_NO_AUTH_LIMIT,
  REQUIRE_PHONE_VERIFIED,
  CERT_GATING,
  GEOCODE,
  DRAFT_ORDER_TTL_HOURS,
  COUPON_LOCK_MINUTES,
  classifyMarginCategory,
  isMembershipActive,
  DEFAULT_MIN_MARKUP_RATE,
  MIN_MARKUP_RATE_HARD_FLOOR,
  resolveMinMarkupRate,
  toFen,
  computeMinSalePriceFen,
  computeMinSalePrice,
  // 【2026-09 上线加固】一键定价相关常量与计算函数
  MIN_MARKUP_AMOUNT,
  PRICE_ROUND_TAIL,
  COST_FLOOR_RATE,
  computeBulkSalePrice,
  roundTailPrice,
  // 【2026-09 低价商品加价上限】保底加价额 + 加价率上限倍数（定价页面可改，不落库）
  MARKUP_CAP_MULTIPLIER,
  MIN_MARKUP_AMOUNT_MAX,
  MARKUP_CAP_MULTIPLIER_MIN,
  MARKUP_CAP_MULTIPLIER_MAX,
  resolveMinMarkupAmount,
  resolveMarkupCapMultiplier,
  // 【2026-09 尾数取整可配置】定价工作台页面选项（不进后台配置）
  ROUND_MODES,
  DEFAULT_ROUND_MODE,
  DEFAULT_ROUND_TAIL_DIGIT,
  ROUND_GUARD_MULTIPLIER,
  DEFAULT_ROUND_GUARD,
  normalizeRoundMode,
  normalizeRoundTailDigit,
  resolveRoundOptions,
  roundOptionsText,
  computeBulkSalePriceDetailed,
  // 双产品线（2026-09 采购为核心重构）
  POS_LEVELS,
  PURCHASE_LEVELS,
  POS_LEVEL_NAMES,
  PURCHASE_LEVEL_NAMES,
  POS_PRICING,
  PURCHASE_PRICING,
  PURCHASE_COIN_RATE,
  DAILY_COIN_POS,
  DAILY_COIN_PURCHASE,
  posFeatures,
  purchaseFeatures,
  COUPON_NEED_PURCHASE_LEVEL,
  ADDONS,
  // 兼容历史字段名派生视图
  membership,
  coinRate,
  coupons
};
