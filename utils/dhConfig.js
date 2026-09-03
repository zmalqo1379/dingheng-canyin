// 鼎恒币（DH）经济系统配置常量
// 极简、无概率、无倍率：鼎恒币为虚拟数字（零成本），抵用券面额为平台唯一硬成本
module.exports = {
  // 会员定价（月卡）
  membership: {
    advanced: { name: '进阶版', price: 99, coinCost: 3000 },   // 进阶版月卡
    premium: { name: '尊享版', price: 199, coinCost: 5000 }    // 尊享版月卡
  },
  // 采购返币率（币/元）：基础版 2元=1币，进阶/尊享 1元=1币
  coinRate: {
    basic: 0.5,
    advanced: 1,
    premium: 1
  },
  // 抵用券配置（面额越大越划算，但平台每笔净利均为正）
  coupons: [
    { type: 'purchase_10', faceValue: 10, coinCost: 600, minOrder: 300, needLevel: 'basic' },
    { type: 'purchase_20', faceValue: 20, coinCost: 1100, minOrder: 500, needLevel: 'basic' },
    { type: 'purchase_30', faceValue: 30, coinCost: 1500, minOrder: 800, needLevel: 'basic' },
    { type: 'purchase_50', faceValue: 50, coinCost: 2400, minOrder: 1200, needLevel: 'advanced' },
    { type: 'purchase_100', faceValue: 100, coinCost: 4500, minOrder: 2500, needLevel: 'advanced' },
    { type: 'purchase_200', faceValue: 200, coinCost: 8000, minOrder: 4000, needLevel: 'premium' }
  ],
  coinExpireDays: 90,   // 鼎恒币有效期 90 天
  couponExpireDays: 30, // 抵用券有效期 30 天
  // 功能权限映射（用于接口鉴权，按会员等级开放）
  features: {
    customerPoints: ['advanced', 'premium'], // 顾客积分（食客积分）
    marketingFull: ['premium'],              // 满减、充值送等高级营销
    reportBasic: ['advanced', 'premium'],    // 经营报表
    reportAdvanced: ['premium']              // 顾客画像、损耗分析
  }
};
