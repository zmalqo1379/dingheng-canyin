const mongoose = require('mongoose');

// 商家营销活动（满减 / 折扣 / 充值送）
// 一个店铺可创建多条活动；生效判定：enabled=true 且当前时间在 [startTime, endTime] 内
// 权限：满减(fullReduction) 为进阶版及以上可用；折扣(discount)、充值送(rechargeBonus) 为尊享版可用
// 规则字段按 type 解释，统一存储，未使用的字段保持默认值
const marketingSchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true
  },
  shopName: {
    type: String,
    default: '',
    trim: true
  },
  // 活动类型
  type: {
    type: String,
    enum: ['fullReduction', 'discount', 'rechargeBonus'],
    required: true
  },
  // 满减：满 threshold 元减 reduce 元
  threshold: { type: Number, default: 0, min: 0 },
  reduce: { type: Number, default: 0, min: 0 },
  // 折扣：rate 折扣率（0.8 = 8 折，范围 0~1，不含 0）；category 为空表示全场，否则指定分类折扣
  rate: { type: Number, default: 0, min: 0, max: 1 },
  category: { type: String, default: '', trim: true },
  // 充值送：充 recharge 元送 bonus 元
  recharge: { type: Number, default: 0, min: 0 },
  bonus: { type: Number, default: 0, min: 0 },
  // 活动标题（可选，前端展示用，未填则按规则自动生成）
  title: { type: String, default: '', trim: true, maxlength: 40 },
  // 生效时间窗口
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date, default: null },
  enabled: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Marketing', marketingSchema);
