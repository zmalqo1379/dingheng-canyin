/**
 * 分账计算服务（加价分销 · 云分账口径）
 *
 * 商业模式（代码严格遵循，不做任何自动加价）：
 *   1) 供应商每日更新商品「供货价」costPrice（含供应商成本+利润）
 *   2) 平台手动填写商品「卖价」salePrice（可空，未填默认等于供货价）；加价完全由平台手动决定
 *   3) 顾客按卖价付款，云分账拆两笔：供货价 → 供应商，差价（卖价-供货价）→ 平台
 *
 * 金额一律以「分」为整数单位运算（utils/money.js），最后转回「元」落库。
 *
 * 下单付款即分账（数量 Q1 = 下单数量）：
 *   顾客实付 = Σ 卖价 × Q1 − 券抵扣
 *   供应商分账 = Σ 供货价 × Q1
 *   平台分账 = 顾客实付 − 供应商分账
 *   恒成立：供应商分账 + 平台分账 ≡ 顾客实付
 *
 * 过秤后补差（数量 Q2 = 实称重量，Q2 ≠ Q1 时）：
 *   差额 D = Σ 卖价 × (Q2 − Q1)（可正可负）
 *   D > 0（补收）：顾客补付 D；其中 Σ 供货价×(Q2−Q1) 补分账给供应商，其余补分账给平台
 *   D < 0（退款）：退款 |D| 给顾客；按比例追回：向供应商追回 Σ 供货价×(Q1−Q2)，向平台追回其余
 *   补差只与数量差异相关，与价格无关（价格下单时已锁定）
 */
const money = require('./money');

// 分账状态机常量
const SPLIT_STATUS = {
  PENDING: '待分账',
  INITIATED: '已发起分账',
  SUCCESS: '分账成功',
  FAILED: '分账失败',
  COMPENSATING: '补差中',
  COMPENSATED: '已补差',
  // 供应商未进件/进件未通过时的降级状态：订单不阻断，由平台线下人工结算
  // （金额计算口径不变，仅资金划转不走渠道分账）
  MANUAL: '待人工分账'
};

function num(v, d = 0) {
  const n = Number(v);
  return isFinite(n) ? n : d;
}

function monthKeyOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(month) {
  const parts = String(month).split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

/**
 * 商品生效卖价（元）：平台手动填写的 salePrice；未填（null/空/<=0）时默认等于供货价
 */
function resolveSalePrice(salePrice, costPrice) {
  const s = Number(salePrice);
  if (isFinite(s) && s > 0) return s;
  return num(costPrice);
}

// 取某行的计价数量（分）：useActual=true 且已过秤时按实称重量，否则按下单数量
function lineQty(item, useActual) {
  const q1 = num(item.quantity);
  if (!useActual) return q1;
  const w = num(item.actualWeight);
  return w > 0 ? w : q1;
}

/**
 * 计算某一计价基准（下单数量 / 实称重量）下的两笔拆账（分整数）
 * @returns {{saleFen,supplyFen,supplierShareFen,platformShareFen,customerPayFen,diffFen}}
 *   saleFen          卖价总额（未扣券）
 *   supplyFen        供货价总额（= 供应商实得）
 *   supplierShareFen 供应商实得
 *   platformShareFen 平台实得（券成本由平台承担）
 *   customerPayFen   顾客实付 = 卖价总额 − 券抵扣
 *   diffFen          差价总额 = 卖价总额 − 供货价总额
 */
function calcSplitFen(items, opts = {}) {
  const useActual = !!opts.useActual;
  const couponFen = money.toFen(num(opts.couponAmount));
  let saleFen = 0;
  let supplyFen = 0;
  for (const it of (Array.isArray(items) ? items : [])) {
    // 老订单无 salePrice 时回退到 retailPrice/unitPrice（等价于卖价），再无则等于供货价
    const supplyUnitYuan = it.supplyPrice != null ? it.supplyPrice : it.unitPrice;
    const saleUnitYuan = (it.salePrice != null && Number(it.salePrice) > 0)
      ? it.salePrice
      : ((it.retailPrice != null && Number(it.retailPrice) > 0) ? it.retailPrice : supplyUnitYuan);
    const qty = lineQty(it, useActual);
    saleFen += money.mulFen(money.toFen(saleUnitYuan), qty);
    supplyFen += money.mulFen(money.toFen(supplyUnitYuan), qty);
  }
  // 顾客实付不低于 0（券面值大于卖价总额时兜底）
  const customerPayFen = Math.max(0, saleFen - couponFen);
  // 供应商实得不超过顾客实付（极端券场景下保障恒等式与不为负）
  const supplierShareFen = Math.min(supplyFen, customerPayFen);
  const platformShareFen = customerPayFen - supplierShareFen;
  // 平台倒贴额：券抵扣吃掉全部加价还不够时，供应商少收的部分。
  // 微信分账最多只能分「顾客实付」那么多，这笔钱进不了分账指令，
  // 只能由平台在支付链路之外补给供应商 —— 记账必须留痕，不能凭空消失。
  const subsidyFen = Math.max(0, supplyFen - supplierShareFen);
  return {
    saleFen,
    supplyFen,
    supplierShareFen,
    platformShareFen,
    customerPayFen,
    subsidyFen,
    diffFen: saleFen - supplyFen
  };
}

// 将分整数结果转为元口径（落库/展示）
function fenResultToYuan(r) {
  return {
    saleAmount: money.toYuan(r.saleFen),
    supplyAmount: money.toYuan(r.supplyFen),
    supplierShare: money.toYuan(r.supplierShareFen),
    platformShare: money.toYuan(r.platformShareFen),
    splitAmount: money.toYuan(r.customerPayFen),
    platformAmount: money.toYuan(r.saleFen - r.supplyFen),
    subsidyAmount: money.toYuan(r.subsidyFen || 0)
  };
}

// 下单时（按 Q1）分账金额
function calcOrderSplit(order) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  const coupon = num(order && order.discountAmount);
  return fenResultToYuan(calcSplitFen(items, { useActual: false, couponAmount: coupon }));
}

// 过秤后（按 Q2）分账金额
function calcActualSplit(order) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  const coupon = num(order && order.discountAmount);
  return fenResultToYuan(calcSplitFen(items, { useActual: true, couponAmount: coupon }));
}

/**
 * 过秤补差计算（元，含符号：正=补收，负=退款）
 *   差额 D = 卖价×(Q2−Q1)；补分账供应商 = 供货价×(Q2−Q1)；补分账平台 = D − 补供应商
 */
function calcCompensation(order) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  const atOrder = calcSplitFen(items, { useActual: false });
  const atActual = calcSplitFen(items, { useActual: true });
  // 补差只与数量差异相关：分别对卖价/供货价求两次口径之差
  const compSaleFen = atActual.saleFen - atOrder.saleFen;       // D = S×(Q2−Q1)
  const compSupplierFen = atActual.supplyFen - atOrder.supplyFen; // C×(Q2−Q1)
  const compPlatformFen = compSaleFen - compSupplierFen;         // (S−C)×(Q2−Q1)
  return {
    compensateAmount: money.toYuan(compSaleFen),
    compensateSupplierShare: money.toYuan(compSupplierFen),
    compensatePlatformShare: money.toYuan(compPlatformFen),
    // 分整数（供渠道请求用）
    compensateFen: compSaleFen,
    compensateSupplierFen: compSupplierFen,
    compensatePlatformFen: compPlatformFen
  };
}

// 分账日志追加（保留最近 50 条）
function appendSplitLog(order, entry) {
  const logs = Array.isArray(order.splitLogs) ? order.splitLogs : [];
  logs.push(Object.assign({ at: new Date() }, entry || {}));
  order.splitLogs = logs.slice(-50);
  return order.splitLogs;
}

module.exports = {
  SPLIT_STATUS,
  resolveSalePrice,
  calcOrderSplit,
  calcActualSplit,
  calcCompensation,
  appendSplitLog,
  monthKeyOf,
  monthRange,
  // 分整数内部函数（单测/渠道请求可用）
  _calcSplitFen: calcSplitFen
};
