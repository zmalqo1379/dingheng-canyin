const mongoose = require('mongoose');
const dhConfig = require('../utils/dhConfig');

// 平台全局配置（单例集合，key 固定为 'platform'）
// 与按店铺隔离的 Setting 不同，这里存开发者后台维护的平台级参数
const platformConfigSchema = new mongoose.Schema({
  key: {
    type: String,
    default: 'platform',
    unique: true,
    trim: true
  },
  // 甲方（平台）营业执照全称——用于《供应商入驻合作协议》顶部甲乙双方信息栏
  platformCompanyName: {
    type: String,
    default: '',
    trim: true
  },
  // 开发者后台"供应商管理"待办最近一次查看时间（红点已读标记，类似微信未读）
  supplierTodoReadAt: {
    type: Date,
    default: null
  },
  // ============ 会员购卡 · 微信支付云分账（服务商分账） ============
  // 默认分账供应商：会员费扣除平台抽佣后（默认 94%）分给该供应商
  defaultSplitSupplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    default: null
  },
  // 平台抽佣比例（百分比，默认 6），决定平台/供应商的分账金额拆分
  membershipSplitRate: {
    type: Number,
    default: 6,
    min: 0,
    max: 100
  },
  // ============ 卖价底线 · 最低加价率（0~1 的小数，默认 0.05） ============
  // 卖价底线 = 供货价 × (1 + 最低加价率)；平台盈利 = 卖价 − 供货价 − 平台成本（主要是抵扣券成本）
  // 下限为 0.03（3% = 平台成本线，不能再低）；由开发者后台「系统设置」调整。
  minMarkupRate: {
    type: Number,
    default: dhConfig.DEFAULT_MIN_MARKUP_RATE,
    min: dhConfig.MIN_MARKUP_RATE_HARD_FLOOR,
    max: 1
  },
  // ============ 支付模式（2026-09 上线加固，运行时可切换，立即生效不用重启）============
  // mock=演示模式（所有交易模拟，真实微信接口直接拒绝调用）/ wechat=真实微信支付
  // 缺省 mock；由开发者后台「系统设置」切换，读取入口 utils/payRuntime.getPayMode()
  payMode: {
    type: String,
    enum: ['mock', 'wechat'],
    default: 'mock'
  },
  // ============ 支付资金流模式（2026-09 供应商进件）============
  // supplier_first=钱进供应商特约商户号，平台分账抽加价部分（默认）
  // platform_first=钱进平台，再按供货价分账给供应商（需微信「高比例分账」白名单批复后才可切）
  // 缺省值为空串 → 运行时回退 utils/dhConfig.js 的 PAYMENT_FLOW_MODE（唯一事实源）
  paymentFlowMode: {
    type: String,
    enum: ['', 'supplier_first', 'platform_first'],
    default: ''
  },
  // ============ 【2026-09 上线加固】一键定价快照 ============
  // 仅保留最近一次一键定价的应用前快照（覆盖式），供回滚接口使用
  // 字段语义：
  //   appliedAt        一键定价执行时间
  //   rate             当时使用的加价率
  //   affectedCount    被改价商品数（不含跳过的手动定价）
  //   skippedManual    跳过的手动定价商品数
  //   overriddenManual 其中被「强制覆盖手动定价」改掉的手动定价商品数
  //   items            每个被改价商品的 ID 与改价前/后的 salePrice + isManualPrice
  //                    仅存 ID 与改价字段，不存整商品文档，体积可控；
  //                    回滚时再按 ID 取出商品并恢复
  lastBulkPricingSnapshot: {
    appliedAt: { type: Date, default: null },
    rate: { type: Number, default: null },
    affectedCount: { type: Number, default: 0 },
    skippedManual: { type: Number, default: 0 },
    overriddenManual: { type: Number, default: 0 },
    items: [{
      productId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplyProduct' },
      prevSalePrice: { type: Number, default: null },
      prevIsManualPrice: { type: Boolean, default: false },
      newSalePrice: { type: Number, required: true },
      newIsManualPrice: { type: Boolean, default: false }
    }]
  }
}, { timestamps: true });

// 获取单例配置（不存在则返回内存默认对象，不自动写库，避免无谓写入）
platformConfigSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'platform' }).lean();
  if (!doc) {
    doc = {
      key: 'platform',
      platformCompanyName: '',
      platformCreditCode: '',
      supplierTodoReadAt: null,
      defaultSplitSupplierId: null,
      membershipSplitRate: 6,
      minMarkupRate: dhConfig.DEFAULT_MIN_MARKUP_RATE,
      payMode: 'mock',
      paymentFlowMode: '',
      lastBulkPricingSnapshot: null
    };
  }
  return doc;
};

module.exports = mongoose.model('PlatformConfig', platformConfigSchema);
