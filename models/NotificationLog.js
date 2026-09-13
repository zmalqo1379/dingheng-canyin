const mongoose = require('mongoose');

// 通知发送日志：记录各渠道通知的真实发送结果（success/failed/skipped），便于排查
const notificationLogSchema = new mongoose.Schema({
  // 商家店铺标识（供应商通知为空）
  shopId: {
    type: String,
    default: '',
    index: true
  },
  // 渠道：webhook 通用回调 / printer 云打印 / sms 短信 / voice 语音电话 / bigscreen 大屏 / wechat 微信
  channel: {
    type: String,
    enum: ['webhook', 'printer', 'sms', 'voice', 'bigscreen', 'wechat'],
    required: true,
    index: true
  },
  // 事件类型：order_created / order_confirmed / order_delivered / order_received ...
  event: {
    type: String,
    default: ''
  },
  // 接收目标（回调地址 / 手机号等）
  target: {
    type: String,
    default: ''
  },
  title: {
    type: String,
    default: ''
  },
  content: {
    type: String,
    default: ''
  },
  // success 发送成功 / failed 发送失败 / skipped 未配置或未启用
  status: {
    type: String,
    enum: ['success', 'failed', 'skipped'],
    default: 'success',
    index: true
  },
  error: {
    type: String,
    default: ''
  },
  payload: {
    type: Object,
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.model('NotificationLog', notificationLogSchema);
