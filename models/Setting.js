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
  // 优惠海报图（进阶版及以上可上传；点餐页顶部优惠区优先显示，空 = 文字轮播）
  promoPoster: {
    type: String,
    default: ''
  },
  // 优惠海报显示尺寸：small 小横幅（矮）/ medium 小海报（中）/ large 大海报（高）
  promoPosterSize: {
    type: String,
    enum: ['small', 'medium', 'large'],
    default: 'small'
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
  // ============ 通知渠道真实对接配置（均由商家/平台填入后生效，未配置则该渠道跳过并记录日志） ============
  // 通用 Webhook：新订单等事件以 JSON POST 到此地址（对接自建/第三方通知服务）
  notifyWebhookUrl: {
    type: String,
    default: '',
    trim: true
  },
  // 云打印服务地址：POST 打印小票 payload（打印机编号/密钥在请求体中携带）
  printerApiUrl: {
    type: String,
    default: '',
    trim: true
  },
  // 短信服务地址与密钥
  smsApiUrl: {
    type: String,
    default: '',
    trim: true
  },
  smsApiKey: {
    type: String,
    default: '',
    trim: true
  },
  // 语音电话服务地址与密钥
  voiceApiUrl: {
    type: String,
    default: '',
    trim: true
  },
  voiceApiKey: {
    type: String,
    default: '',
    trim: true
  },
  // ============ 微信通知（公众号模板消息网关 / 企业微信机器人 Webhook）============
  // 微信通知服务地址：POST 模板消息 JSON（含模板ID/接收者/订单内容）
  wechatApiUrl: {
    type: String,
    default: '',
    trim: true
  },
  // 微信通知服务密钥（如需要）
  wechatApiKey: {
    type: String,
    default: '',
    trim: true
  },
  // 微信模板消息模板 ID
  wechatTemplateId: {
    type: String,
    default: '',
    trim: true
  },
  // 微信接收者 OpenID / 企业微信成员 ID（留空则由服务端按配置默认接收人）
  wechatToUser: {
    type: String,
    default: '',
    trim: true
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
  }],
  // 积分有效期模式：permanent 永久有效 / fixed 固定天数
  pointExpiryMode: {
    type: String,
    enum: ['permanent', 'fixed'],
    default: 'permanent'
  },
  // 积分有效期天数（仅 fixed 模式有效，正整数）
  pointExpiryDays: {
    type: Number,
    default: 30,
    min: 1
  },
  // ============ 配送三件套：门店定位与收货 ============
  // 门店经度（选填）：来源为①商家在地图上标注/手输 ②后端按 shopAddress 自动地理编码换算
  //   （utils/geocode.js，高德 Web 服务；换算结果与状态见下面 certification.geo*）
  shopLongitude: {
    type: Number,
    default: null
  },
  // 门店纬度（选填，同 shopLongitude）
  shopLatitude: {
    type: Number,
    default: null
  },
  // 详细地址文本（精确到门牌号，供供应商配送单页显示）
  shopAddress: {
    type: String,
    default: '',
    maxlength: 200,
    trim: true
  },
  // 门头照 URL（必传，供应商配送单页缩略图显示）
  storeFrontPhoto: {
    type: String,
    default: ''
  },
  // 街景照 URL（选传，辅助供应商找门）
  streetViewPhoto: {
    type: String,
    default: ''
  },
  // 收货方式：supplier_arranged 按供应商安排（默认，新商家不再强制选择）
  //             / door_container 门口自备保温容器 / open_door 开门后配送 / self_pickup 到店自提
  receiveMethod: {
    type: String,
    enum: ['supplier_arranged', 'door_container', 'open_door', 'self_pickup'],
    default: 'supplier_arranged'
  },
  // 期望收货时段起（HH:mm，配送单按此时段排序路线）
  expectedReceiveStart: {
    type: String,
    default: '06:00'
  },
  // 期望收货时段止（HH:mm）
  expectedReceiveEnd: {
    type: String,
    default: '09:00'
  },
  // ============ 商家认证（内嵌 Setting，写法参照 Supplier.qualification） ============
  // 认证状态：none=未认证（默认）/ pending=已提交待平台核验 / approved=已认证 / rejected=已驳回（可重新提交）
  // 已认证（approved）商家下采购单不受金额限制；未认证商家受「首单直通」规则约束（utils/dhConfig.FIRST_ORDER_NO_AUTH_LIMIT）
  certification: {
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none',
      index: true
    },
    // 营业执照照片 URL（第二批接入 OCR 自动识别，本轮仅预留字段位）
    businessLicense: { type: String, default: '' },
    // 手机号是否已验证（等 AppID / 短信通道就绪后启用验证逻辑，本轮仅预留字段位，默认 false）
    phoneVerified: { type: Boolean, default: false },
    phoneVerifiedAt: { type: Date, default: null },
    // 门店定位（经纬度）自动换算状态（服务端用高德 Web 服务按文字地址换算，见 utils/geocode.js）：
    //   none     未尝试
    //   provided 商家在地图上选点/手输自带（无需换算）
    //   ok       后端按文字地址自动换算成功
    //   failed   换算失败（技术原因，不阻断认证与下单；记录原因供后续补全）
    geoStatus: {
      type: String,
      enum: ['none', 'provided', 'ok', 'failed'],
      default: 'none'
    },
    // 用于换算的文字地址（失败后便于补全/重试，避免重复打高德配额）
    geoFrom: { type: String, default: '', trim: true },
    // 换算失败原因（高德返回的 info 或网络错误摘要）
    geoMessage: { type: String, default: '', trim: true },
    // 最近一次尝试换算时间
    geoAttemptedAt: { type: Date, default: null },
    // 最近一次提交认证时间
    submittedAt: { type: Date, default: null },
    // 平台核验时间
    reviewedAt: { type: Date, default: null },
    // 核验驳回原因（商家端可见）
    rejectReason: { type: String, default: '', trim: true }
  }
}, { timestamps: true });

module.exports = mongoose.model('Setting', settingSchema);
