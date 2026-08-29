const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  shopName: {
    type: String,
    default: '鼎恒餐饮'
  },
  adminPassword: {
    type: String,
    default: 'admin123'
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
