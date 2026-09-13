const PurchaseOrder = require('../models/PurchaseOrder');
const SupplyProduct = require('../models/SupplyProduct');

// ============ 囤货保护（按供应商要求规则） ============
// 商家下单提交前预检（POST /api/purchase-orders/pre-check）：
//   对每个商品检测"本次下单数量 > 该商家该商品近 7 日采购总量"，
//   无 7 日数据时按 3 倍于常量的兜底（常量 = 近 7 日单次采购量中位数，无单次记录则用本次数量×3 比较）
// 触发则返回 warning（前端弹窗提醒），可修改或坚持下单（force=true 跳过预检）
//
// 跌价预警：
//   最终售价比近 7 日均价低超 15% 时返回 priceDropWarning，前端保存时需二次确认
//
// 阈值：默认按"近 7 日采购总量"比较；无 7 日数据则按"3 倍常量"兜底
const STOCKPILE_RATIO = 3; // 兜底倍数：无 7 日数据时按 3 倍常量
const PRICE_DROP_THRESHOLD = 0.15; // 跌价超 15% 触发预警

// 查询某商家某商品近 7 日采购记录（任意状态，已完成优先）
// 返回：{ totalQty, orderCount, records: [{ orderNo, quantity, unitPrice, createdAt }] }
async function get7DayPurchaseHistory(shopId, productId) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const orders = await PurchaseOrder.find({
    shopId,
    'items.productId': productId,
    createdAt: { $gte: since }
  }).lean();
  let totalQty = 0;
  const records = [];
  for (const o of orders) {
    for (const it of (o.items || [])) {
      if (String(it.productId) === String(productId)) {
        totalQty += Number(it.quantity || 0);
        records.push({
          orderNo: o.orderNo,
          quantity: Number(it.quantity || 0),
          unitPrice: Number(it.unitPrice || 0),
          createdAt: o.createdAt
        });
      }
    }
  }
  return { totalQty, orderCount: records.length, records };
}

// 计算近 7 日均价（按数量加权平均）
function calc7DayAvgPrice(records) {
  if (!records || records.length === 0) return null;
  let totalAmt = 0, totalQty = 0;
  for (const r of records) {
    totalAmt += r.unitPrice * r.quantity;
    totalQty += r.quantity;
  }
  if (totalQty === 0) return null;
  return totalAmt / totalQty;
}

// 计算常量（近 7 日单次采购量中位数；无记录则返回 null，触发兜底）
function medianQty(records) {
  if (!records || records.length === 0) return null;
  const qtys = records.map(r => r.quantity).sort((a, b) => a - b);
  const mid = Math.floor(qtys.length / 2);
  return qtys.length % 2 === 0 ? (qtys[mid - 1] + qtys[mid]) / 2 : qtys[mid];
}

// ============ 预检：返回需要提醒的商品 ============
// 入参：shopId, items=[{ productId, quantity, unitPrice }]
// 返回：{ stockpileWarnings: [...], priceDropWarnings: [...] }
//   stockpileWarnings: [{ productId, name, quantity, history7DayTotal, baseline, ratio }]
//   priceDropWarnings: [{ productId, name, unitPrice, avg7Day, dropRatio }]
async function preCheckOrder(shopId, items) {
  const stockpileWarnings = [];
  const priceDropWarnings = [];
  // 批量拉取商品（避免逐个查）
  const productIds = [...new Set(items.map(i => String(i.productId)))];
  const products = await SupplyProduct.find({ _id: { $in: productIds } }).lean();
  const productMap = {};
  for (const p of products) productMap[String(p._id)] = p;

  for (const it of items) {
    const product = productMap[String(it.productId)];
    if (!product) continue;
    const qty = Number(it.quantity || 0);
    const unitPrice = Number(it.unitPrice != null ? it.unitPrice : (product.costPrice || 0));

    // ---- 囤货检测 ----
    const history = await get7DayPurchaseHistory(shopId, it.productId);
    let isAnomaly = false;
    let baseline = null;
    let ratio = 0;
    if (history.orderCount > 0) {
      // 有 7 日数据：本次数量 > 7 日总量即触发
      if (qty > history.totalQty && history.totalQty > 0) {
        isAnomaly = true;
        baseline = history.totalQty;
        ratio = qty / history.totalQty;
      } else if (history.totalQty === 0) {
        // 7 日记录存在但总量 0（极少见，按兜底）
        const med = medianQty(history.records) || qty;
        if (qty > med * STOCKPILE_RATIO) {
          isAnomaly = true;
          baseline = med;
          ratio = qty / med;
        }
      }
    } else {
      // 无 7 日数据：按 3 倍于常量兜底；常量无记录时用本次数量自身兜底（即任何首单都不触发，
      // 但本次数量异常大且无历史时仍按本次数量×3 比较，等同不触发——避免首单误报）
      // 实际策略：无历史数据时不触发（首单无法判定异常），返回 baseline=null 仅供前端展示
      baseline = null;
    }
    if (isAnomaly) {
      stockpileWarnings.push({
        productId: String(it.productId),
        name: product.name,
        quantity: qty,
        history7DayTotal: history.totalQty,
        baseline,
        ratio: +ratio.toFixed(2)
      });
    }

    // ---- 跌价预警 ----
    const avg7 = calc7DayAvgPrice(history.records);
    if (avg7 != null && avg7 > 0 && unitPrice < avg7) {
      const dropRatio = (avg7 - unitPrice) / avg7;
      if (dropRatio > PRICE_DROP_THRESHOLD) {
        priceDropWarnings.push({
          productId: String(it.productId),
          name: product.name,
          unitPrice,
          avg7Day: +avg7.toFixed(2),
          dropRatio: +(dropRatio * 100).toFixed(1)
        });
      }
    }
  }
  return { stockpileWarnings, priceDropWarnings };
}

module.exports = {
  STOCKPILE_RATIO,
  PRICE_DROP_THRESHOLD,
  get7DayPurchaseHistory,
  calc7DayAvgPrice,
  medianQty,
  preCheckOrder
};
