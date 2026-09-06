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
  CATEGORY_CLASSIFICATION,
  DAILY_COIN,
  features,
  coinExpireDays,
  couponExpireDays,
  classifyMarginCategory,
  isMembershipActive,
  // 兼容历史字段名派生视图
  membership,
  coinRate,
  coupons
};
