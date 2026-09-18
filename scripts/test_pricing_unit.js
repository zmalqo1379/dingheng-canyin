// 一键定价函数单元测试（不依赖 mongo/网络）
const c = require('../utils/dhConfig');

const tests = [];
function assertEq(name, got, want) {
  tests.push({ name, got, want, pass: JSON.stringify(got) === JSON.stringify(want) });
}

// === roundTailPrice ===
assertEq('roundTailPrice 37.4 ceil_to_9 → 37.9', c.roundTailPrice(37.4, 'ceil_to_9'), 37.9);
assertEq('roundTailPrice 37.0 ceil_to_9 → 37.9', c.roundTailPrice(37.0, 'ceil_to_9'), 37.9);
assertEq('roundTailPrice 37.9 ceil_to_9 → 37.9', c.roundTailPrice(37.9, 'ceil_to_9'), 37.9);
assertEq('roundTailPrice 10   ceil_to_9 → 10.9', c.roundTailPrice(10,   'ceil_to_9'), 10.9);
assertEq('roundTailPrice 10.01 ceil_to_9 → 10.9', c.roundTailPrice(10.01, 'ceil_to_9'), 10.9);
assertEq('roundTailPrice 10.99 ceil_to_9 → 11.9（进位）', c.roundTailPrice(10.99, 'ceil_to_9'), 11.9);
assertEq('roundTailPrice 11   ceil_to_9 → 11.9', c.roundTailPrice(11,   'ceil_to_9'), 11.9);
assertEq('roundTailPrice 37.4 floor_to_9 → 36.9', c.roundTailPrice(37.4, 'floor_to_9'), 36.9);
assertEq('roundTailPrice 36.9 floor_to_9 → 36.9', c.roundTailPrice(36.9, 'floor_to_9'), 36.9);
assertEq('roundTailPrice 10   floor_to_9 → 9.9（少赚）', c.roundTailPrice(10, 'floor_to_9'), 9.9);
assertEq('roundTailPrice 10   round → 10',        c.roundTailPrice(10,   'round'),      10);
assertEq('roundTailPrice 10.04 round → 10',       c.roundTailPrice(10.04, 'round'),      10);
assertEq('roundTailPrice 10.06 round → 10.1',     c.roundTailPrice(10.06, 'round'),      10.1);
assertEq('roundTailPrice 10.01 none → 10.01',     c.roundTailPrice(10.01, 'none'),       10.01);

// === computeBulkSalePrice ===
assertEq('cost=0 → 卖价0',       c.computeBulkSalePrice(0, 0.10),      { salePrice: 0, markupRate: 0, actualMarkupRate: 0, markupAmount: 0, capped: false });
assertEq('cost=10 rate=0.10 → 卖价 11.9',
  c.computeBulkSalePrice(10, 0.10),
  { salePrice: 11.9, markupRate: 0.10, actualMarkupRate: 0.19, markupAmount: 1.9, capped: false });

// 1 元商品 → 保底起作用（1+0.5=1.5 → 取整 1.9）
assertEq('cost=1 rate=0.10 → 卖价 1.9（保底+取整）',
  c.computeBulkSalePrice(1, 0.10),
  { salePrice: 1.9, markupRate: 0.10, actualMarkupRate: 0.9, markupAmount: 0.9, capped: false });

// 成本线保护：cost=100 rate=0.01 → raw=101 但加价率仅 1% < 3% → 强制硬地板（默认 5%）→ 取整 105.9
const r = c.computeBulkSalePrice(100, 0.01);
assertEq('cost=100 rate=0.01 → capped=true', r.capped, true);
assertEq('cost=100 rate=0.01 → salePrice 105.9', r.salePrice, 105.9);
assertEq('cost=100 rate=0.01 → markupRate 0.05 (硬地板默认值)', r.markupRate, 0.05);

// 硬地板可由「系统设置·最低加价率」传入：最低 3%
const rFloor = c.computeBulkSalePrice(100, 0.01, 0.03);
assertEq('cost=100 rate=0.01 硬地板=0.03 → salePrice 103.9', rFloor.salePrice, 103.9);
assertEq('cost=100 rate=0.01 硬地板=0.03 → markupRate 0.03', rFloor.markupRate, 0.03);
assertEq('硬地板低于成本线被收敛：硬地板=0.01 → 0.03', c.computeBulkSalePrice(100, 0.01, 0.01).markupRate, 0.03);

// 5% 加价率：cost=100 → 105 → 取整 105.9（加价率 5.9% > 3% 成本线）
const r2 = c.computeBulkSalePrice(100, 0.05);
assertEq('cost=100 rate=0.05 → capped=false', r2.capped, false);
assertEq('cost=100 rate=0.05 → salePrice 105.9', r2.salePrice, 105.9);

// cost=37.4 rate=0.10 → 41.14 → 取整 41.9
assertEq('cost=37.4 rate=0.10 → salePrice 41.9', c.computeBulkSalePrice(37.4, 0.10).salePrice, 41.9);

// === 加价率上限（保底不得把实际加价率推过「加价率 × 上限倍数」，默认 2 倍）===
// 0.3 元商品设 8%：保底 0.5 元会使加价率 167% > 16%（8%×2）→ 放弃保底，改用按比例算出的精确值
const capLow = c.computeBulkSalePriceDetailed(0.3, 0.08, 0.05, { roundMode: 'none', roundGuard: false });
assertEq('0.3 元 @8% 上限2倍 → 加价 0.048、卖价 0.35（放弃保底）',
  [capLow.salePrice, capLow.markupAmount, capLow.floorDropped],
  [0.35, 0.05, true]);
assertEq('0.3 元 @8% 上限2倍 → 上限加价率 0.16', capLow.markupCapRate, 0.1600);

// 上限倍数可在页面改：3 倍 → 1 元 @10% 的保底 1.5 被截断到 1 × (1 + 10%×3) = 1.30
const capLow3 = c.computeBulkSalePriceDetailed(1, 0.10, 0.05, { roundMode: 'none', roundGuard: false, markupCapMultiplier: 3 });
assertEq('1 元 @10% 上限3倍 → 卖价 1.30（保底被截断）',
  [capLow3.salePrice, capLow3.markupCapRate], [1.3, 0.3]);

// 保底加价额可在页面改：改成 0.05 元后 1 元商品不再被拉到 1.5（上限 1.2 内，保底 0.05 → 按比例 1.1）
const minAmtSmall = c.computeBulkSalePriceDetailed(1, 0.10, 0.05, { roundMode: 'none', roundGuard: false, minMarkupAmount: 0.05 });
assertEq('保底改为 0.05 元：1 元 @10% → 卖价 1.10（比例价生效）',
  [minAmtSmall.salePrice, minAmtSmall.floorDropped], [1.10, false]);
assertEq('保底改为 0.05 元：回显本次使用的保底值 0.05', minAmtSmall.minMarkupAmount, 0.05);

// 高价商品不受上限影响：10 元 @10% → 11（保底 0.5 未超上限 12）
const capHigh = c.computeBulkSalePriceDetailed(10, 0.10, 0.05, { roundMode: 'none', roundGuard: false });
assertEq('10 元 @10% 上限2倍 → 卖价 11.00（保底未触发上限）',
  [capHigh.salePrice, capHigh.floorDropped], [11, false]);

// 保底在范围内仍然生效：3.2 元 @8% → 保底 3.7 ≤ 上限 3.712 → 卖价 3.70
const capMid = c.computeBulkSalePriceDetailed(3.2, 0.08, 0.05, { roundMode: 'none', roundGuard: false });
assertEq('3.2 元 @8% 上限2倍 → 保底仍生效（3.70）',
  [capMid.salePrice, capMid.floorDropped], [3.7, false]);

// 归一化：非法值回退，越界收敛
assertEq('resolveMinMarkupAmount(null) → 0.5（默认）', c.resolveMinMarkupAmount(null), 0.5);
assertEq('resolveMinMarkupAmount(-1) → 0.5（默认）', c.resolveMinMarkupAmount(-1), 0.5);
assertEq('resolveMarkupCapMultiplier(null) → 2（默认）', c.resolveMarkupCapMultiplier(null), 2);
assertEq('resolveMarkupCapMultiplier(0.5) → 1（下限）', c.resolveMarkupCapMultiplier(0.5), 1);
assertEq('resolveMarkupCapMultiplier(99) → 10（上限）', c.resolveMarkupCapMultiplier(99), 10);

// === computeMinSalePrice ===
assertEq('computeMinSalePrice(10, 0.10) → 11',  c.computeMinSalePrice(10, 0.10), 11);
assertEq('computeMinSalePrice(3.20, 0.10) → 3.52', c.computeMinSalePrice(3.20, 0.10), 3.52);

// === resolveMinMarkupRate 归一化 ===
assertEq('resolveMinMarkupRate(null) → 0.05（默认值）',  c.resolveMinMarkupRate(null), 0.05);
assertEq('resolveMinMarkupRate("0.2") → 0.2', c.resolveMinMarkupRate('0.2'), 0.2);
assertEq('resolveMinMarkupRate(2) → 1 (上限)', c.resolveMinMarkupRate(2), 1);
assertEq('resolveMinMarkupRate(-1) → 0.05（默认值）',    c.resolveMinMarkupRate(-1), 0.05);
assertEq('resolveMinMarkupRate(0) → 0.03 (成本线下限)', c.resolveMinMarkupRate(0), 0.03);
assertEq('resolveMinMarkupRate(0.01) → 0.03 (低于成本线收敛)', c.resolveMinMarkupRate(0.01), 0.03);
assertEq('resolveMinMarkupRate(0.03) → 0.03 (下限原样保留)', c.resolveMinMarkupRate(0.03), 0.03);

// === 配置项导出值 ===
assertEq('MIN_MARKUP_AMOUNT = 0.5', c.MIN_MARKUP_AMOUNT, 0.5);
assertEq('PRICE_ROUND_TAIL = ceil_to_9', c.PRICE_ROUND_TAIL, 'ceil_to_9');
assertEq('COST_FLOOR_RATE = 0.03', c.COST_FLOOR_RATE, 0.03);
assertEq('DEFAULT_MIN_MARKUP_RATE = 0.05', c.DEFAULT_MIN_MARKUP_RATE, 0.05);
assertEq('MIN_MARKUP_RATE_HARD_FLOOR = 0.03', c.MIN_MARKUP_RATE_HARD_FLOOR, 0.03);

// 输出结果
let pass = 0, fail = 0;
for (const t of tests) {
  if (t.pass) { pass++; }
  else {
    fail++;
    console.log(`✗ ${t.name}\n   got=${JSON.stringify(t.got)}\n   want=${JSON.stringify(t.want)}`);
  }
}
console.log(`\n[合计] 通过 ${pass} / 失败 ${fail} / 共 ${tests.length}`);
process.exit(fail > 0 ? 1 : 0);