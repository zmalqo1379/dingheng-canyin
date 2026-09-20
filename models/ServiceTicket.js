const mongoose = require('mongoose');

// ============ 售后服务工单 ============
// 解决什么问题：以前商家收货发现少件、品质问题，只能打电话/发微信找供应商，
//   没有凭据、没有时限、扯不清时平台也无从介入 —— 纠纷靠嗓门大，供应商背冤枉锅。
// 现在：商家在订单上提交工单（带图片凭证）→ 供应商在控制台接单处理 → 双方谈不拢或超时自动升级平台裁决。
// 全程留痕（logs），既是维权凭据，也是供应商的品控数据来源（哪类问题多、哪家投诉率高）。

// 工单类型：覆盖生鲜采购最常见的纠纷场景
const TICKET_TYPES = [
  '品质问题',   // 不新鲜、腐烂、虫蛀、变质
  '数量短缺',   // 少件、少称（过秤后与下单量不符）
  '规格不符',   // 品种/等级/产地与下单不符
  '配送延误',   // 未在约定时段送达
  '包装破损',   // 运输破损导致损耗
  '退换货',     // 申请退货或换货
  '账款争议',   // 金额、补差、分账有异议
  '其他'
];

// 商家诉求：供应商据此给出处理方案
const EXPECT_ACTIONS = ['仅反馈', '补发', '换货', '退款', '折让'];

// 状态机：
//   待受理 →（供应商受理）处理中 →（供应商给方案）待商家确认 →（商家确认）已完成
//               ↘（供应商驳回）已驳回
//   待受理/处理中 →（任一方申请平台介入 或 超 24h 未受理）平台介入中 →（平台裁决）已完成
//   商家在供应商受理前可撤销 → 已撤销
// 终态：已完成 / 已驳回 / 已撤销（终态后只允许平台重开）
const TICKET_STATUS = ['待受理', '处理中', '待商家确认', '已完成', '已驳回', '已撤销', '平台介入中'];

const TERMINAL_STATUS = ['已完成', '已驳回', '已撤销'];

const ticketLogSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  // 操作人：商家记 shopId / 供应商记 supplierId / 平台记 dev
  by: { type: String, default: '' },
  byName: { type: String, default: '' },
  byRole: { type: String, enum: ['merchant', 'supplier', 'platform', ''], default: '' },
  action: { type: String, default: '' },     // 提交/受理/回复/方案/驳回/确认/撤销/升级/裁决
  from: { type: String, default: '' },       // 变更前状态
  to: { type: String, default: '' },         // 变更后状态
  note: { type: String, default: '' }
}, { _id: false });

// 涉事商品行：纠纷只揪出问题的那几行，不用整单重填
const ticketItemSchema = new mongoose.Schema({
  productId: { type: String, default: '' },
  name: { type: String, default: '' },
  unit: { type: String, default: '' },
  // 下单量（取自订单快照）
  quantity: { type: Number, default: 0 },
  // 问题描述中的异常量（如少了多少、坏了多少），不填表示整行有问题
  issueQuantity: { type: Number, default: 0 },
  unitPrice: { type: Number, default: 0 }
}, { _id: false });

const serviceTicketSchema = new mongoose.Schema({
  ticketNo: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // ============ 关联关系 ============
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PurchaseOrder',
    default: null,
    index: true
  },
  orderNo: { type: String, default: '', index: true },
  shopId: { type: String, required: true, index: true },
  shopName: { type: String, default: '' },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true,
    index: true
  },
  supplierName: { type: String, default: '' },

  // ============ 工单内容 ============
  type: {
    type: String,
    enum: TICKET_TYPES,
    default: '其他',
    index: true
  },
  // 标题：一句话说清问题（前端自动拼，也可手改）
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  // 凭证图片（商家上传，最多 6 张）
  images: { type: [String], default: [] },
  items: { type: [ticketItemSchema], default: [] },
  // 商家诉求
  expectAction: {
    type: String,
    enum: EXPECT_ACTIONS,
    default: '仅反馈'
  },
  // 诉求金额（退款/折让时填；供应商方案金额另存 resolution.amount）
  claimAmount: { type: Number, default: 0 },

  // ============ 状态机 ============
  status: {
    type: String,
    enum: TICKET_STATUS,
    default: '待受理',
    index: true
  },
  // 紧急：商家标记（如当天要用的货出问题），列表置顶 + 红标
  priority: {
    type: String,
    enum: ['普通', '紧急'],
    default: '普通'
  },
  logs: { type: [ticketLogSchema], default: [] },

  // ============ 时限（供应商 24h 内必须受理，超时自动升级平台）============
  // 受理时限：创建时 = createdAt + 24h
  dueAt: { type: Date, default: null, index: true },
  acceptedAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },

  // ============ 供应商处理方案 ============
  resolution: {
    action: { type: String, default: '' },        // 补发 / 换货 / 退款 / 折让 / 已解释
    amount: { type: Number, default: 0 },         // 退款或折让金额
    note: { type: String, default: '' },
    at: { type: Date, default: null }
  },

  // ============ 平台介入 ============
  platformIntervened: { type: Boolean, default: false, index: true },
  // 升级原因（超时未受理 / 商家申请 / 供应商申请）
  escalateReason: { type: String, default: '' },
  escalatedAt: { type: Date, default: null },
  platformNote: { type: String, default: '' },

  // ============ 商家评价（闭环最后一步，沉淀成供应商服务分）============
  rating: { type: Number, default: 0, min: 0, max: 5 },
  ratingNote: { type: String, default: '' },
  ratedAt: { type: Date, default: null }
}, { timestamps: true });

// 供应商常用查询：待办工单（状态 + 时间倒序）
serviceTicketSchema.index({ supplierId: 1, status: 1, createdAt: -1 });
// 商家常用查询：我提交的工单
serviceTicketSchema.index({ shopId: 1, createdAt: -1 });
// 平台总览：按状态 + 是否介入
serviceTicketSchema.index({ status: 1, platformIntervened: 1, createdAt: -1 });

// 生成工单号：TK + 年月日 + 4 位随机串（唯一索引兜底，冲突由调用方重试）
serviceTicketSchema.statics.genTicketNo = function () {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TK${day}${rand}`;
};

serviceTicketSchema.statics.TICKET_TYPES = TICKET_TYPES;
serviceTicketSchema.statics.EXPECT_ACTIONS = EXPECT_ACTIONS;
serviceTicketSchema.statics.TICKET_STATUS = TICKET_STATUS;
serviceTicketSchema.statics.TERMINAL_STATUS = TERMINAL_STATUS;
serviceTicketSchema.statics.isTerminal = function (status) {
  return TERMINAL_STATUS.includes(status);
};

module.exports = mongoose.model('ServiceTicket', serviceTicketSchema);
