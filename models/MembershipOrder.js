const mongoose = require('mongoose');

// 会员现金购卡订单（线下收款 → 平台确认后开通）
// 线上支付通道未接入前，商家提交购卡订单（pending），客服确认收款后由开发者后台确认开通（paid）。
const membershipOrderSchema = new mongoose.Schema({
  // 订单号：MO + yyyymmdd + 6 位随机数
  orderNo: {
    type: String,
    required: true,
    unique: true
  },
  shopId: {
    type: String,
    required: true,
    index: true
  },
  // 下单时店铺名快照，便于开发者后台直接查看
  shopName: {
    type: String,
    default: ''
  },
  // 产品线（2026-09 双产品线重构）：
  //   pos      = 扫码点餐线（等级 basic/advanced/premium，basic 永久免费不售）
  //   purchase = 采购管家线（等级 free/plus/pro，free 永久免费不售）
  // 历史订单无该字段，一律视为 pos（重构前只有点餐线一条）
  productLine: {
    type: String,
    enum: ['pos', 'purchase'],
    default: 'pos',
    index: true
  },
  // 购买的会员等级（点餐线 basic/advanced/premium；采购线 free/plus/pro）
  level: {
    type: String,
    enum: ['basic', 'advanced', 'premium', 'free', 'plus', 'pro'],
    required: true
  },
  // 购买月数（1~12）
  months: {
    type: Number,
    default: 1,
    min: 1,
    max: 12
  },
  // 应付人民币金额（= 等级月价 × 月数，下单时快照，后续调价不影响历史订单）
  amountRmb: {
    type: Number,
    required: true,
    min: 0
  },
  // 订单状态：pending 待支付 / paid 已收款已开通 / cancelled 已取消
  status: {
    type: String,
    enum: ['pending', 'paid', 'cancelled'],
    default: 'pending',
    index: true
  },
  // 商家备注（如开票信息、付款流水号）
  buyerNote: {
    type: String,
    default: '',
    maxlength: 200
  },
  // 平台确认收款时间
  paidAt: {
    type: Date,
    default: null
  },
  // 确认人（开发者账号标识）
  confirmedBy: {
    type: String,
    default: ''
  },
  // 开通后写入的会员到期时间（存档，便于对账核对实际生效期）
  memberExpireAfter: {
    type: Date,
    default: null
  },

  // ============ 线上支付（微信支付 · 服务商模式） ============
  // 支付渠道：cash 线下收款 / wechat 微信支付
  payChannel: {
    type: String,
    enum: ['cash', 'wechat'],
    default: 'cash',
    index: true
  },
  // 商户订单号（微信支付 out_trade_no，微信侧唯一）
  outTradeNo: {
    type: String,
    default: ''
  },
  prepayId: {
    type: String,
    default: ''
  },
  // Native 支付二维码链接（前端展示扫码）
  codeUrl: {
    type: String,
    default: ''
  },
  // 微信支付订单号（支付成功后回填）
  transactionId: {
    type: String,
    default: ''
  },
  // 支付状态：unpaid 待支付 / paid 已支付 / closed 已关闭 / refunded 已退款
  payStatus: {
    type: String,
    enum: ['unpaid', 'paid', 'closed', 'refunded'],
    default: 'unpaid',
    index: true
  },
  // 支付截止时间（超时未支付由定时任务自动取消）
  payExpireAt: {
    type: Date,
    default: null
  },
  payerOpenid: {
    type: String,
    default: ''
  },

  // ============ 云分账（微信支付服务商分账） ============
  // 分账供应商（会员费的 94% 分给该供应商；由平台配置默认值）
  splitSupplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    default: null
  },
  splitSupplierName: {
    type: String,
    default: ''
  },
  // 平台抽佣金额（元，= amountRmb × 抽佣比例）
  platformAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 供应商应分账金额（元，= amountRmb - platformAmount）
  supplyAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // 分账状态：none 无需分账 / pending 分账中 / done 已分账 / failed 分账失败 / returned 已回退
  splitStatus: {
    type: String,
    enum: ['none', 'pending', 'done', 'failed', 'returned'],
    default: 'none',
    index: true
  },
  // 分账单号（微信 out_order_no）
  splitOrderNo: {
    type: String,
    default: ''
  },
  // 微信分账单号（回填，退款回退时用作 order_id）
  wxSplitOrderId: {
    type: String,
    default: ''
  },
  splitAt: {
    type: Date,
    default: null
  },
  splitError: {
    type: String,
    default: ''
  },
  // 分账自动重试次数（定时任务重试用，超过上限不再自动重试）
  splitRetryCount: {
    type: Number,
    default: 0,
    min: 0
  },

  // ============ 退款（先退款后退分账：已分账则先回退分账再退款） ============
  refundNo: {
    type: String,
    default: ''
  },
  refundStatus: {
    type: String,
    enum: ['none', 'refunding', 'refunded', 'failed'],
    default: 'none',
    index: true
  },
  refundAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  refundAt: {
    type: Date,
    default: null
  },
  refundError: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// 微信支付商户订单号唯一（线下单为空不参与索引）
membershipOrderSchema.index({ outTradeNo: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('MembershipOrder', membershipOrderSchema);
