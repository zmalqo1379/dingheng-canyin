// 营销优惠计算（满减 + 折扣），顾客点餐页与后端下单共用同一套规则
// 顾客端 customer.js 内嵌同等逻辑（保持一致），后端用本模块做权威计算防止前端篡改
//
// 输入：
//   items: [{ dishName, price, quantity, category }]
//   rules: [{ type, threshold, reduce, rate, category }]  （仅 fullReduction / discount）
// 顺序：先按品类应用折扣得到「折扣后小计」，再基于折扣后小计应用满减
// 输出：{ originalTotal, itemDiscountAmount, fullReductionAmount, discountAmount, finalTotal,
//        bestFull, globalRate, catRates, itemDiscounts }

function computeDiscount(items, rules) {
  items = Array.isArray(items) ? items : [];
  rules = Array.isArray(rules) ? rules : [];

  const originalTotal = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);

  // 1) 折扣：全场折扣（category 为空）作为兜底；指定品类折扣优先于全场，取最低 rate（让利最大）
  let globalRate = 1;
  const catRates = {};
  for (const r of rules) {
    if (r.type !== 'discount') continue;
    const rate = Math.max(0.01, Math.min(1, Number(r.rate) || 1));
    if (!r.category) {
      globalRate = Math.min(globalRate, rate);
    } else {
      const cur = catRates[r.category];
      if (cur == null || rate < cur) catRates[r.category] = rate;
    }
  }

  let discountSubtotal = 0;
  const itemDiscounts = [];
  for (const it of items) {
    const lineOriginal = (Number(it.price) || 0) * (Number(it.quantity) || 0);
    const rate = (catRates[it.category] != null) ? catRates[it.category] : globalRate;
    const linePaid = lineOriginal * rate;
    discountSubtotal += linePaid;
    if (rate < 1) {
      itemDiscounts.push({ name: it.dishName, category: it.category, rate, saved: +(lineOriginal - linePaid).toFixed(2) });
    }
  }
  const itemDiscountAmount = +(originalTotal - discountSubtotal).toFixed(2);

  // 2) 满减：基于折扣后小计，在所有满足门槛的活动中取减免金额最大者
  let bestFull = null;
  for (const r of rules) {
    if (r.type !== 'fullReduction') continue;
    const threshold = Number(r.threshold) || 0;
    const reduce = Number(r.reduce) || 0;
    if (threshold > 0 && reduce > 0 && discountSubtotal >= threshold - 1e-9) {
      if (!bestFull || reduce > bestFull.reduce) bestFull = { threshold, reduce };
    }
  }
  const fullReductionAmount = bestFull ? +bestFull.reduce.toFixed(2) : 0;

  const finalTotal = +Math.max(0, discountSubtotal - fullReductionAmount).toFixed(2);
  const discountAmount = +(originalTotal - finalTotal).toFixed(2);

  return {
    originalTotal: +originalTotal.toFixed(2),
    itemDiscountAmount,
    fullReductionAmount,
    discountAmount,
    finalTotal,
    bestFull,
    globalRate,
    catRates,
    itemDiscounts
  };
}

module.exports = { computeDiscount };
