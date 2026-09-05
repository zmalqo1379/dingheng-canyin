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
  // 头部横幅背景图（进阶版及以上可自定义，空 = 使用主题默认）
  bannerImage: {
    type: String,
    default: ''
  },
  // 店铺 LOGO（进阶版及以上可自定义，显示在店名左侧，空 = 使用主题默认）
  logoImage: {
    type: String,
    default: ''
  },
  // 店名字体（点餐页店名渲染，系统字体栈实现）：modern 现代黑体 / serif 雅致宋体 / round 圆润体 / hand 手写风格
  shopNameFont: {
    type: String,
    enum: ['modern', 'serif', 'round', 'hand'],
    default: 'modern'
  },
  // 点餐页菜单排版：list 经典列表（默认）/ large 大图模式 / grid 双列网格
  layout: {
    type: String,
    enum: ['list', 'large', 'grid'],
    default: 'list'
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
  },
  // ============ 顾客积分配置（进阶版权益，存 Setting 便于公开接口读取） ============
  // 积分功能总开关（关闭后顾客端隐藏所有积分信息与入口，不再累计积分）
  pointEnabled: {
    type: Boolean,
    default: true
  },
  // 返积分比例：每消费 1 元返多少积分（0 = 不返）
  pointSpendPerPoint: {
    type: Number,
    default: 1,
    min: 0
  },
  // 积分抵现开关
  pointDeductEnabled: {
    type: Boolean,
    default: true
  },
  // 抵现比例：多少积分抵 1 元（默认 100 积分 = 1 元）
  pointDeductPoints: {
    type: Number,
    default: 100,
    min: 1
  },
  // 单笔订单积分抵现上限（占实付金额百分比，默认 20%）
  pointDeductMaxPercent: {
    type: Number,
    default: 20,
    min: 0,
    max: 100
  },
  // 积分兑换菜品列表：[{ dishId, dishName, points }]
  pointExchangeDishes: [{
    dishId: { type: String, required: true },
    dishName: { type: String, default: '', maxlength: 50 },
    points: { type: Number, default: 100, min: 1 }
  }]
}, { timestamps: true });

module.exports = mongoose.model('Setting', settingSchema);
