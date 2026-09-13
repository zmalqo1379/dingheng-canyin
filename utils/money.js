/**
 * 金额工具（分账口径统一用「分」为整数单位，规避浮点误差）
 *
 * 约定：
 *   - 数据库 / 对外展示沿用「元」（两位小数）
 *   - 所有涉及金额的加减乘除一律先转「分」（整数）再运算，最后转回「元」
 *   - 分账恒等式：供应商实得 + 平台实得 ≡ 顾客实付（分整数下严格成立）
 */

// 元 → 分（四舍五入取整）
function toFen(yuan) {
  const n = Number(yuan);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

// 分 → 元（保留两位小数，返回 Number）
function toYuan(fen) {
  const n = Number(fen);
  if (!isFinite(n)) return 0;
  return Math.round(n) / 100;
}

// 保留两位小数的元金额（用于既有元口径字段的落库/展示）
function round2(yuan) {
  return toYuan(toFen(yuan));
}

// 分整数乘法：单价(分) × 数量，数量允许小数（如过秤重量），结果四舍五入到分
function mulFen(unitFen, qty) {
  const q = Number(qty);
  if (!isFinite(q)) return 0;
  return Math.round(Number(unitFen) * q);
}

module.exports = { toFen, toYuan, round2, mulFen };
