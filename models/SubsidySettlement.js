const mongoose = require('mongoose');

// ============ 平台补差（券成本倒贴）结算单 ============
// 场景：顾客用券把「加价空间」吃光后，供应商这单少收（供货价 > 实付，差额进不了微信分账指令），
//       这笔钱由平台补给供应商。补给动作在系统内走完：按周 / 按月批量结算，一键转给供应商。
// 设计：结算单 = 某供应商某次结算的凭证；items 是当时每笔订单的快照（结算后订单状态变了也不影响凭证）。

// 结算明细（每单一行快照）
const settleItemSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder' },
  orderNo: { type: String, default: '' },
  shopName: { type: String, default: '' },
  // 该单平台应补金额
  subsidyAmount: { type: Number, default: 0, min: 0 },
  // 该单供货价应收 / 供应商实收（对账凭证用）
  supplyAmount: { type: Number, default: 0, min: 0 },
  supplierShare: { type: Number, default: 0, min: 0 },
  receiveAt: { type: Date, default: null }
}, { _id: false });

const subsidySettlementSchema = new mongoose.Schema({
  // 结算单号：BS20260919-0001
  settleNo: { type: String, required: true, unique: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
  supplierName: { type: String, default: '' },
  // 结算周期：周结 / 月结 / 手动（一次结清某个供应商的全部待补）
  periodType: { type: String, enum: ['周结', '月结', '手动'], default: '周结', index: true },
  // 本单覆盖的订单完成时间区间
  periodStart: { type: Date, default: null },
  periodEnd: { type: Date, default: null },
  orderCount: { type: Number, default: 0, min: 0 },
  amount: { type: Number, default: 0, min: 0 },
  // 出款通道：platform=平台内结算（系统记账 + 线下出款留痕）
  //          wechat_transfer=微信商家转账（需平台商户号开通该产品后启用，未开通自动降级为 platform）
  channel: { type: String, enum: ['platform', 'wechat_transfer'], default: 'platform' },
  // 状态：已结算（钱已出、供应商端显示「已收」）/ 结算失败（出款异常，订单保持待补）
  status: { type: String, enum: ['已结算', '结算失败'], default: '已结算', index: true },
  settledAt: { type: Date, default: null },
  // 操作人（开发者账号）
  operator: { type: String, default: '' },
  note: { type: String, default: '', trim: true },
  items: { type: [settleItemSchema], default: [] },
  // 收款户快照（结算当时供应商的结算户信息，出凭证用；卡号只存后 4 位）
  payee: {
    bankName: { type: String, default: '' },
    bankBranch: { type: String, default: '' },
    bankAccountName: { type: String, default: '' },
    bankAccountNoTail: { type: String, default: '' }
  }
}, { timestamps: true });

subsidySettlementSchema.index({ supplierId: 1, settledAt: -1 });

module.exports = mongoose.model('SubsidySettlement', subsidySettlementSchema);
