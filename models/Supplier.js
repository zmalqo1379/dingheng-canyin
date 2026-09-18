const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const supplierSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  contact: {
    type: String,
    default: ''
  },
  phone: {
    type: String,
    default: '',
    unique: true,
    sparse: true,
    trim: true
  },
  loginAccount: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
  },
  webhookUrl: {
    type: String,
    default: ''
  },
  // 主营品类（多选）：蔬菜/肉类/冻品/粮油/酱料/一次性用品
  categories: {
    type: [String],
    default: []
  },
  // 起送价（单位：元），订单合计需 >= minOrderAmount 才可提交，默认 300
  minOrderAmount: {
    type: Number,
    default: 300,
    min: 0
  },
  // 通知设置：popup=页面弹窗提醒, sms=短信通知, voice=语音电话提醒
  notificationSettings: {
    popup: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
    voice: { type: Boolean, default: false }
  },
  // ============ 配送时段公告（供应商自定义配送规则说明，展示给商家端） ============
  // 例："每日上午 7:00-9:30 统一配送，节假日顺延至次日"
  // 商家在采购商城该供应商店铺页顶部与采购订单确认收货页可见
  deliveryNotice: {
    type: String,
    default: '',
    maxlength: 500,
    trim: true
  },
  // 【已废弃】默认返点比例（0~1）：返点体系已停用，不再参与任何计算，仅保留字段兼容历史。
  rebateRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 1
  },
  // 【已废弃】返点模式：返点体系已停用，不再参与任何计算。
  rebateMode: {
    type: String,
    enum: ['unified', 'byCategory'],
    default: 'unified',
    required: true
  },
  // 【已废弃】返点模式切换审计日志：返点体系已停用。
  rebateModeLogs: {
    type: [{
      by: { type: String, default: '' },        // 操作人（开发者账号/标识）
      at: { type: Date, default: Date.now },    // 切换时间
      from: { type: String, default: '' },      // 切换前模式
      to: { type: String, default: '' }         // 切换后模式
    }],
    default: []
  },
  // 【已废弃】应付给我的返点累计金额：返点体系已停用，供应商实得改由订单分账字段体现，不再回写此字段。
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  // ============ 微信支付服务商分账 ============
  // 供应商在微信支付服务商下的特约商户号（分账接收方账号）；为空则无法作为分账接收方
  wechatSubMchId: {
    type: String,
    default: '',
    trim: true
  },
  // ============ 微信支付进件（2026-09 供应商进件流程）============
  // 资金流 supplier_first 模式：门店货款直接进供应商特约商户号，平台分账抽走加价部分。
  // 本轮不接微信真实进件 API（特约商户号由平台在微信商户平台代为进件），采用
  // 「供应商线上提交资料 → 平台人工在微信侧进件 → 开发者后台录入特约商户号并标记通过」模式。
  // 进件状态机：none=未提交 / pending=审核中 / approved=已通过 / rejected=被驳回（可重新提交）
  // 银行账号等敏感字段 AES-256-GCM 加密存储（utils/cryptoBox.js），接口/日志一律脱敏输出。
  wechatOnboarding: {
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none',
      index: true
    },
    // 营业执照照片 URL（/uploads/...）
    businessLicenseUrl: { type: String, default: '' },
    // 法人姓名
    legalPerson: { type: String, default: '', trim: true },
    // 法人身份证正/反面照片 URL
    idCardFrontUrl: { type: String, default: '' },
    idCardBackUrl: { type: String, default: '' },
    // 银行账户（结算户）：账号加密存储，其余明文
    bankAccountName: { type: String, default: '', trim: true },
    bankAccountNoEnc: { type: String, default: '' },
    bankName: { type: String, default: '', trim: true },
    bankBranch: { type: String, default: '', trim: true },
    // 联系人 / 联系电话
    contactName: { type: String, default: '', trim: true },
    contactPhone: { type: String, default: '', trim: true },
    // 经营类目（如：蔬菜/肉类/冻品/粮油/调料/一次性用品 等，可与主营品类不同）
    category: { type: String, default: '', trim: true },
    // 经营地址
    address: { type: String, default: '', trim: true, maxlength: 200 },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, default: '', trim: true }
  },
  // ============ 供应商治理体系字段 ============
  // 入驻审核状态：pending=待审核（默认，新注册）/ active=已通过 / frozen=已冻结 / rejected=已拒绝
  status: {
    type: String,
    enum: ['pending', 'active', 'frozen', 'rejected'],
    default: 'pending',
    index: true
  },
  // 审核拒绝原因（status=rejected 时由开发者填写，供应商端可见）
  rejectReason: {
    type: String,
    default: '',
    trim: true
  },
  // 冻结原因（status=frozen 时由开发者填写，供应商端可见）
  frozenReason: {
    type: String,
    default: '',
    trim: true
  },
  // 审核通过时间（status 切换到 active 时记录）
  approvedAt: {
    type: Date,
    default: null
  },
  // 是否已签署《供应商入驻合作协议》
  agreementSigned: {
    type: Boolean,
    default: false
  },
  // 协议签署时间
  agreementSignedAt: {
    type: Date,
    default: null
  },
  // 协议签署证据存档（电子签名法律效力依据，见《电子签名法》第13/14条）：
  // 记录签署时间、来源IP、设备信息、协议版本号、协议文本哈希，作为签署事实的证明材料
  agreementEvidence: {
    confirmedAt: { type: Date, default: null },
    ip: { type: String, default: '' },
    ua: { type: String, default: '' },
    version: { type: String, default: '' },
    textHash: { type: String, default: '' }
  },
  // 是否已开通接单权限（开发者后台"确认开通接单"开关；agreementSigned && orderEnabled 才可在采购商城上架/接单）
  orderEnabled: {
    type: Boolean,
    default: false
  },
  // 开通接单时间
  orderEnabledAt: {
    type: Date,
    default: null
  },
  // ============ 开通接单资质核验（"一道闸门"：签协议后即可进控制台，上传资质核验通过才上线接单） ============
  // 资质核验状态：none=未上传 / pending=核验中 / approved=核验通过（已开通接单）/ rejected=已驳回（可重新上传）
  qualification: {
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none',
      index: true
    },
    businessLicense: { type: String, default: '' }, // 营业执照照片 URL
    storeFront: { type: String, default: '' },      // 门店门头照 URL
    storeInterior: { type: String, default: '' },   // 店内环境照 URL
    goods: { type: String, default: '' },           // 货品照 URL
    submittedAt: { type: Date, default: null },     // 最近一次提交时间
    reviewedAt: { type: Date, default: null },      // 平台核验时间
    rejectReason: { type: String, default: '', trim: true }, // 核验驳回原因（供应商端可见）
    // 本次提交资质前的协议确认证据（每次提交/重新提交均记录一份，作为电子签署存档）
    agreementEvidence: {
      confirmedAt: { type: Date, default: null },
      ip: { type: String, default: '' },
      ua: { type: String, default: '' },
      version: { type: String, default: '' },
      textHash: { type: String, default: '' }
    }
  },
  // ============ 新手接单引导（三步走）进度标记 ============
  // 是否已保存过新订单提醒设置（点"保存设置"即完成第二步）
  onboardNotifySet: {
    type: Boolean,
    default: false
  },
  // 是否查看过合作结算页（点"去看看"即完成第三步）
  onboardSettleSeen: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

// 保存前对明文密码进行 bcrypt 加密
supplierSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  if (!this.password) return next();
  // 已是 bcrypt 哈希（$2a$/$2b$/$2y$ 开头）则跳过，避免二次哈希导致无法登录
  if (/^\$2[aby]\$/.test(this.password)) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// 密码比对方法
supplierSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('Supplier', supplierSchema);
