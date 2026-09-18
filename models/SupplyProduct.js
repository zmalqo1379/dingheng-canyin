const mongoose = require('mongoose');

const supplyProductSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    required: true,
    trim: true
  },
  image: {
    type: String,
    default: ''
  },
  unit: {
    type: String,
    default: '个'
  },
  // 供应商「供货价」（含供应商成本+利润），由供应商每日更新，是分账给供应商的唯一单价口径。
  costPrice: {
    type: Number,
    required: true,
    min: 0
  },
  // 【已废弃】marketPrice（旧零售价展示字段）已被平台卖价 salePrice 取代，不再参与任何计算。
  marketPrice: {
    type: Number,
    required: true,
    min: 0
  },
  // 【已废弃】rebateRate（旧返点率字段），返点体系已停用，不再参与任何计算。
  rebateRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 1
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  supplierName: {
    type: String,
    required: true,
    trim: true
  },
  stock: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['上架', '下架'],
    default: '上架'
  },
  description: {
    type: String,
    default: ''
  },
  // ============ 加价分销：平台卖价 ============
  // 平台「卖价」：由平台运营方在定价工作台手动填写，顾客按卖价付款。
  // 可空——未填写（null）时视为等于供货价 costPrice（平台不加价）。
  // 加价额 = salePrice - costPrice，完全由平台手动决定，系统不设公式/比例/上下限。
  // 供应商更新供货价后，卖价默认保持不变，由平台决定是否跟进调整。
  salePrice: {
    type: Number,
    default: null,
    min: 0
  },
  // 【2026-09 上线加固】手动定价标记：true 表示该商品卖价由人工填写，
  // 一键定价（批量加价率）不得覆盖此类商品——手动定价的优先级最高。
  // PUT /api/dev/pricing/product/:id 写入非空 salePrice 时置 true，
  // 一键定价命中带 isManualPrice=true 的商品时直接跳过（不在影响范围内）。
  isManualPrice: {
    type: Boolean,
    default: false
  },
  // ============ 【已废弃】智能定价系统字段 ============
  // markupRate（单品加价率）已随智能定价停用，仅保留字段避免旧数据写入报错，不再参与任何计算。
  markupRate: {
    type: Number,
    default: null,
    min: 0
  },
  // 最近改价时间：用于保鲜期保护（每日定时任务检查是否超期未更新）
  // 改价 / 一键沿用昨日价后即刷新；新建商品默认取 createdAt
  priceUpdatedAt: {
    type: Date,
    default: Date.now
  },
  // 档次标签（双档次蔬菜支持）：standard=实惠档 / premium=精品档 / null=无档次（非蔬菜或单档）
  grade: {
    type: String,
    enum: ['standard', 'premium', null],
    default: null
  },
  // 双档次关联：精品档商品指向其实惠档主品 _id，便于采购商城相邻展示与同步管理
  // 实惠档主品此字段为 null；精品档子品此字段指向主品
  parentProductId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SupplyProduct',
    default: null
  },
  // ============ 保鲜期保护状态字段 ============
  // 价格冻结标记：true 时商家端显示"价格更新中"且不可下单；改价/沿用后清除
  priceFrozen: {
    type: Boolean,
    default: false
  },
  // 冻结时间（priceFrozen=true 时记录）
  priceFrozenAt: {
    type: Date,
    default: null
  },
  // 首次保鲜期提醒时间（超过品类保鲜期未更新 priceUpdatedAt 时记录，用于"只提醒一次"）
  freshnessAlertedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

// 索引：按供应商 + 分类查询改价工作台；按 parentProductId 关联子档品
supplyProductSchema.index({ supplierId: 1, category: 1 });
supplyProductSchema.index({ parentProductId: 1 });

module.exports = mongoose.model('SupplyProduct', supplyProductSchema);
