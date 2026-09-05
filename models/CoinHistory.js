const mongoose = require('mongoose');
const dhConfig = require('../utils/dhConfig');

// 鼎恒币流水：必须逐笔记录，用于 FIFO 扣减与过期
const coinHistorySchema = new mongoose.Schema({
  shopId: {
    type: String,
    required: true,
    index: true
  },
  // +为获得，-为消耗/过期
  amount: {
    type: Number,
    required: true
  },
  type: {
    type: String,
    enum: ['purchase_reward', 'redeem_membership', 'redeem_coupon', 'refund_deduct', 'expired', 'system_gift', 'new_shop_gift'],
    required: true
  },
  // 关联采购订单ID（字符串形式，便于跨表对账）
  sourceOrderId: {
    type: String,
    default: ''
  },
  // 变动后余额（冗余字段，方便对账）
  balanceAfter: {
    type: Number,
    default: 0
  },
  // 仅收入时有效 = createdAt + 90 天；支出/过期时为 null
  expireAt: {
    type: Date,
    default: null
  },
  // 收入记录的当前未消耗余额（FIFO 扣减时逐笔递减；支出记录为 null）
  // 说明：spec 未列出此字段，但 FIFO「未完全消耗的记录」判定必须依赖它，故新增
  remaining: {
    type: Number,
    default: null
  },
  // 收入记录过期清理后置 true，防止 cron 重复处理
  isExpired: {
    type: Boolean,
    default: false
  },
  description: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// 按 shopId + createdAt 建复合索引，加速 FIFO 查询
coinHistorySchema.index({ shopId: 1, createdAt: 1 });

module.exports = mongoose.model('CoinHistory', coinHistorySchema);
