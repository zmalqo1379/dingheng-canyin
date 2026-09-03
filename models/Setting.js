const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true,
    unique: true
  },
  shopName: {
    type: String,
    default: '鼎恒餐饮'
  },
  // 店铺风格主题：classic 经典橙 / minimal 简约白 / dark 时尚暗黑 / green 清新绿 / redgold 国潮红金
  theme: {
    type: String,
    enum: ['classic', 'minimal', 'dark', 'green', 'redgold'],
    default: 'classic'
  },
  // 头部横幅背景图（尊享版专属可自定义，空 = 使用主题默认）
  bannerImage: {
    type: String,
    default: ''
  },
  // 店铺 LOGO（尊享版专属可自定义，显示在店名左侧，空 = 使用主题默认）
  logoImage: {
    type: String,
    default: ''
  },
  enableVoice: {
    type: Boolean,
    default: true
  },
  enableBigscreen: {
    type: Boolean,
    default: true
  },
  enablePrinter: {
    type: Boolean,
    default: false
  },
  enableWechat: {
    type: Boolean,
    default: false
  },
  printerSN: {
    type: String,
    default: ''
  },
  printerKey: {
    type: String,
    default: ''
  },
  notifyPhone: {
    type: String,
    default: ''
  }
}, { timestamps: true });

module.exports = mongoose.model('Setting', settingSchema);
