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
  // 默认返点比例（0~1），用于采购订单完成时计算返点
  rebateRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 1
  },
  // 应付给我的返点累计金额
  balance: {
    type: Number,
    default: 0,
    min: 0
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
