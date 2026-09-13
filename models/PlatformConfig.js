const mongoose = require('mongoose');

// 平台全局配置（单例集合，key 固定为 'platform'）
// 与按店铺隔离的 Setting 不同，这里存开发者后台维护的平台级参数
const platformConfigSchema = new mongoose.Schema({
  key: {
    type: String,
    default: 'platform',
    unique: true,
    trim: true
  },
  // 甲方（平台）营业执照全称——用于《供应商入驻合作协议》顶部甲乙双方信息栏
  platformCompanyName: {
    type: String,
    default: '',
    trim: true
  },
  // 开发者后台"供应商管理"待办最近一次查看时间（红点已读标记，类似微信未读）
  supplierTodoReadAt: {
    type: Date,
    default: null
  },
  // ============ 会员购卡 · 微信支付云分账（服务商分账） ============
  // 默认分账供应商：会员费扣除平台抽佣后（默认 94%）分给该供应商
  defaultSplitSupplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    default: null
  },
  // 平台抽佣比例（百分比，默认 6），决定平台/供应商的分账金额拆分
  membershipSplitRate: {
    type: Number,
    default: 6,
    min: 0,
    max: 100
  }
}, { timestamps: true });

// 获取单例配置（不存在则返回内存默认对象，不自动写库，避免无谓写入）
platformConfigSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'platform' }).lean();
  if (!doc) {
    doc = {
      key: 'platform',
      platformCompanyName: '',
      platformCreditCode: '',
      supplierTodoReadAt: null,
      defaultSplitSupplierId: null,
      membershipSplitRate: 6
    };
  }
  return doc;
};

module.exports = mongoose.model('PlatformConfig', platformConfigSchema);
