const SupplyProduct = require('../models/SupplyProduct');
const priceRule = require('./priceRule');

// ============ 保鲜期保护：每日定时任务 ============
// 规则（按供应商要求）：
//   1) 商品超过其品类保鲜期未更新 priceUpdatedAt → 第一次发提醒（设置 freshnessAlertedAt）
//   2) 继续超期 → 商品冻结（priceFrozen=true，商家端显示"价格更新中"，不可下单）
//   3) 超过保鲜期 3 倍 → 自动下架（status='下架'）
//   4) 改价或一键沿用后即解除（清除 freshnessAlertedAt / priceFrozen / priceFrozenAt）
//
// 阶段划分（以 freshDays 为单位）：
//   - daysSinceUpdate > freshDays         → 提醒阶段（首次进入时设置 freshnessAlertedAt）
//   - daysSinceUpdate > freshDays × 1.5   → 冻结阶段（priceFrozen=true）
//   - daysSinceUpdate > freshDays × 3     → 自动下架阶段（status='下架'，并清除冻结标记）
//
// 注：提醒阶段与冻结阶段之间存在过渡；为避免反复在边界横跳，
//     提醒只在 freshnessAlertedAt=null 时设置一次；冻结只在 priceFrozen=false 时设置一次。
async function runFreshnessCheck() {
  const now = new Date();
  const products = await SupplyProduct.find({ status: '上架' }).lean();
  // 一次性拉取所有供应商的规则 Map（按供应商分组）
  const ruleMapCache = {};
  async function getRuleMapFor(supplierId) {
    const key = String(supplierId);
    if (!ruleMapCache[key]) {
      ruleMapCache[key] = await priceRule.getRuleMap(supplierId);
    }
    return ruleMapCache[key];
  }

  let alertedCount = 0;
  let frozenCount = 0;
  let autoOffCount = 0;
  const toAlert = [];
  const toFreeze = [];
  const toAutoOff = [];

  for (const p of products) {
    if (!p.priceUpdatedAt) continue;
    const ruleMap = await getRuleMapFor(p.supplierId);
    const rule = priceRule.ruleForCategory(ruleMap, p.category);
    const freshDays = rule.freshDays;
    const msSince = now.getTime() - new Date(p.priceUpdatedAt).getTime();
    const daysSince = msSince / (24 * 60 * 60 * 1000);

    if (daysSince > freshDays * 3) {
      // 自动下架阶段
      toAutoOff.push(p);
    } else if (daysSince > freshDays * 1.5) {
      // 冻结阶段（未冻结才标记，避免重复写）
      if (!p.priceFrozen) toFreeze.push(p);
    } else if (daysSince > freshDays) {
      // 提醒阶段（未提醒过才标记）
      if (!p.freshnessAlertedAt) toAlert.push(p);
    }
  }

  // 1) 提醒阶段：设置 freshnessAlertedAt（首次提醒标记）
  if (toAlert.length) {
    const r = await SupplyProduct.updateMany(
      { _id: { $in: toAlert.map(p => p._id) } },
      { $set: { freshnessAlertedAt: now } }
    );
    alertedCount = r.modifiedCount;
  }
  // 2) 冻结阶段：priceFrozen=true + priceFrozenAt=now
  if (toFreeze.length) {
    const r = await SupplyProduct.updateMany(
      { _id: { $in: toFreeze.map(p => p._id) } },
      { $set: { priceFrozen: true, priceFrozenAt: now } }
    );
    frozenCount = r.modifiedCount;
  }
  // 3) 自动下架阶段：status='下架' + 清除冻结标记（已下架无需再显示"价格更新中"）
  if (toAutoOff.length) {
    const r = await SupplyProduct.updateMany(
      { _id: { $in: toAutoOff.map(p => p._id) } },
      { $set: { status: '下架', priceFrozen: false, priceFrozenAt: null } }
    );
    autoOffCount = r.modifiedCount;
  }

  console.log(`[Freshness] 保鲜期检查：提醒=${alertedCount}，冻结=${frozenCount}，自动下架=${autoOffCount}`);
  return { alertedCount, frozenCount, autoOffCount };
}

// 查询某供应商所有触发保鲜期保护的商品（用于后台横幅提醒）
// 返回：{ alerted: [...], frozen: [...] }，含商品名/品类/超期天数/保鲜期
async function getFreshnessAlerts(supplierId) {
  const now = new Date();
  const products = await SupplyProduct.find({ supplierId }).lean();
  const ruleMap = await priceRule.getRuleMap(supplierId);
  const alerted = [];
  const frozen = [];
  for (const p of products) {
    if (p.status !== '上架' && !p.priceFrozen) continue;
    if (!p.priceUpdatedAt) continue;
    const rule = priceRule.ruleForCategory(ruleMap, p.category);
    const freshDays = rule.freshDays;
    const daysSince = (now.getTime() - new Date(p.priceUpdatedAt).getTime()) / (24 * 60 * 60 * 1000);
    if (p.priceFrozen) {
      frozen.push({
        _id: String(p._id), name: p.name, category: p.category,
        daysSince: +daysSince.toFixed(1), freshDays
      });
    } else if (p.freshnessAlertedAt || daysSince > freshDays) {
      alerted.push({
        _id: String(p._id), name: p.name, category: p.category,
        daysSince: +daysSince.toFixed(1), freshDays
      });
    }
  }
  return { alerted, frozen };
}

module.exports = { runFreshnessCheck, getFreshnessAlerts };
