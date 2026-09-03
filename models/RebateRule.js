const mongoose = require('mongoose');

// 返点档位：按月累计采购额确定命中档位
const rebateTierSchema = new mongoose.Schema({
  // 该档门槛：月累计采购金额达到此值（元，含本数）即命中本档
  minAmount: {
    type: Number,
    required: true,
    min: 0
  },
  // 该档返点率（统一以小数存储，0.05 = 5%；前端展示时 ×100 格式化）
  rate: {
    type: Number,
    required: true,
    min: 0,
    max: 1
  },
  // 累进方式（mode）：
  //   full     全额累进——命中本档后，全部累计金额按本档费率计返点
  //   marginal 超额累进——仅本档门槛以上的部分按本档费率计，各档分段求和
  mode: {
    type: String,
    enum: ['full', 'marginal'],
    default: 'full'
  }
}, { _id: false });

// 供应商分品类返点规则（返点率的唯一权威数据源，页面/接口一律从此读取）
const rebateRuleSchema = new mongoose.Schema({
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true,
    index: true
  },
  // 品类名称；'全部' 表示该供应商的通用规则（无品类专属规则时兜底使用）
  category: {
    type: String,
    required: true,
    trim: true,
    default: '全部'
  },
  // 阶梯档位（按 minAmount 升序）
  tiers: {
    type: [rebateTierSchema],
    default: []
  },
  // 是否启用（false 时该规则不参与计算，回退该供应商「全部」通用规则或默认兜底率）
  enabled: {
    type: Boolean,
    default: true
  },
  // 规则生效日期（仅当月度结算口径需追溯历史规则时使用；当前实时计算取最新规则）
  effectiveDate: {
    type: Date,
    default: Date.now
  },
  remark: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// 同一供应商同一品类仅保留一条规则（新增即覆盖更新）
rebateRuleSchema.index({ supplierId: 1, category: 1 }, { unique: true });

module.exports = mongoose.model('RebateRule', rebateRuleSchema);
