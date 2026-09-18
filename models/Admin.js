const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// 开发者账号模型：开发者账号由服务启动时读取环境变量 DEV_ADMIN_USER / DEV_ADMIN_PASSWORD 创建（见 server.js），
// 或由管理员直接在数据库手动创建；不再提供任何公开播种接口。
const adminSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  name: {
    type: String,
    default: '开发者'
  }
}, { timestamps: true });

// 保存前对明文密码进行 bcrypt 加密
adminSchema.pre('save', async function (next) {
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
adminSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
