const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// 商家账户：用于累计采购订单完成时生成的积分
// 同时承载商家身份认证字段（phone、password、contactName）
// （PurchaseOrder.pointsGenerated 自动累加到此账户）
const shopAccountSchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  shopName: {
    type: String,
    default: ''
  },
  // 联系人姓名
  contactName: {
    type: String,
    default: ''
  },
  // 手机号（商家登录账号，唯一；sparse 允许自动创建的账户留空）
  phone: {
    type: String,
    default: '',
    unique: true,
    sparse: true,
    trim: true
  },
  // 登录密码（bcrypt 加密；注册时写入，自动创建账户可为空）
  password: {
    type: String,
    default: ''
  },
  pointsBalance: {
    type: Number,
    default: 0,
    min: 0
  }
}, { timestamps: true });

// 保存前对明文密码进行 bcrypt 加密（仅在密码被修改、非空、且不是已哈希值时）
shopAccountSchema.pre('save', async function (next) {
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
shopAccountSchema.methods.comparePassword = function (candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('ShopAccount', shopAccountSchema);
