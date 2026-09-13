const PriceRule = require('../models/PriceRule');

// ============ 平台预置品类保鲜期 ============
// 叶菜 1 天、根茎茄果 2 天、鲜肉 1 天、冻品 7 天、米面粮油 30 天、干调 30 天、蛋 3 天、一次性用品 90 天、其他 7 天
// 注意：加价率（markupRate）已随智能定价停用，本模块只负责「保鲜期」与工作台分类。
const FRESH_PRESETS = [
  { category: '叶菜', freshDays: 1 },
  { category: '根茎茄果', freshDays: 2 },
  { category: '鲜肉', freshDays: 1 },
  { category: '冻品', freshDays: 7 },
  { category: '米面粮油', freshDays: 30 },
  { category: '干调', freshDays: 30 },
  { category: '蛋', freshDays: 3 },
  { category: '一次性用品', freshDays: 90 },
  { category: '其他', freshDays: 7 }
];

// 兜底保鲜期（无任何规则时使用）
const DEFAULT_FRESH_DAYS = 7;

// ============ 改价工作台 8 大分类标签 ============
// 商品 category 字段（更细品类）映射到工作台 8 大分类标签，便于分组展示
const WORKBENCH_TABS = [
  { key: '米面粮油', match: ['米面粮油', '粮油'] },
  { key: '肉', match: ['肉', '肉类', '鲜肉'] },
  { key: '蛋', match: ['蛋', '蛋类'] },
  { key: '菜', match: ['菜', '蔬菜', '叶菜', '根茎茄果'] },
  { key: '干调', match: ['干调', '调料', '酱料'] },
  { key: '冻品', match: ['冻品'] },
  { key: '一次性用品', match: ['一次性用品', '一次性'] },
  { key: '其他', match: ['其他', '未分类', ''] }
];

// 将商品的 category 字段映射到工作台 8 大分类之一
function workbenchTabFor(category) {
  const cat = String(category || '').trim();
  for (const tab of WORKBENCH_TABS) {
    if (tab.match.includes(cat)) return tab.key;
  }
  return '其他';
}

// ============ 保鲜期类别归一化 ============
// 将任意 category 字符串归一化到 FRESH_PRESETS 中的某个键，用于保鲜期天数查询
function freshCategoryFor(category) {
  const cat = String(category || '').trim();
  const preset = FRESH_PRESETS.find(p => p.category === cat);
  if (preset) return preset.category;
  if (['肉类', '肉'].includes(cat)) return '鲜肉';
  if (['蔬菜', '菜', '叶菜'].includes(cat)) return '叶菜';
  if (['根茎茄果'].includes(cat)) return '根茎茄果';
  if (['粮油', '米面粮油'].includes(cat)) return '米面粮油';
  if (['调料', '酱料', '干调'].includes(cat)) return '干调';
  if (['蛋', '蛋类'].includes(cat)) return '蛋';
  if (['一次性用品', '一次性'].includes(cat)) return '一次性用品';
  if (['冻品'].includes(cat)) return '冻品';
  return '其他';
}

// ============ 查询某供应商某品类的保鲜期规则 ============
// 优先级：供应商专属规则 > 平台预置（supplierId=null）> 内置兜底常量
async function getRule(supplierId, category) {
  const freshCat = freshCategoryFor(category);
  let rule = null;
  if (supplierId) {
    rule = await PriceRule.findOne({ supplierId, category: freshCat }).lean();
  }
  if (!rule) {
    rule = await PriceRule.findOne({ supplierId: null, category: freshCat }).lean();
  }
  if (!rule) {
    const preset = FRESH_PRESETS.find(p => p.category === freshCat);
    return { freshDays: preset ? preset.freshDays : DEFAULT_FRESH_DAYS, category: freshCat };
  }
  return { freshDays: rule.freshDays, category: freshCat };
}

// 批量查询某供应商所有品类的保鲜期规则
// 返回 Map：freshCategory → { freshDays }
async function getRuleMap(supplierId) {
  const [globalRules, supplierRules] = await Promise.all([
    PriceRule.find({ supplierId: null }).lean(),
    supplierId ? PriceRule.find({ supplierId }).lean() : []
  ]);
  const map = {};
  for (const r of globalRules) {
    map[r.category] = { freshDays: r.freshDays };
  }
  // 内置兜底补全 FRESH_PRESETS（防止预置未入库）
  for (const p of FRESH_PRESETS) {
    if (!map[p.category]) {
      map[p.category] = { freshDays: p.freshDays };
    }
  }
  // 供应商专属覆盖预置
  for (const r of supplierRules) {
    map[r.category] = { freshDays: r.freshDays };
  }
  if (!map['其他']) {
    map['其他'] = { freshDays: DEFAULT_FRESH_DAYS };
  }
  return map;
}

// 由规则 Map 查询某商品 category 的保鲜期（用于改价工作台与定时任务批量计算）
function ruleForCategory(ruleMap, category) {
  const freshCat = freshCategoryFor(category);
  return ruleMap[freshCat] || ruleMap['其他'] || { freshDays: DEFAULT_FRESH_DAYS };
}

// ============ 预置平台规则入库（幂等，仅 supplierId=null 的预置规则） ============
async function seedGlobalPresets() {
  for (const preset of FRESH_PRESETS) {
    await PriceRule.updateOne(
      { supplierId: null, category: preset.category },
      { $setOnInsert: { freshDays: preset.freshDays } },
      { upsert: true }
    );
  }
}

module.exports = {
  FRESH_PRESETS,
  WORKBENCH_TABS,
  DEFAULT_FRESH_DAYS,
  workbenchTabFor,
  freshCategoryFor,
  getRule,
  getRuleMap,
  ruleForCategory,
  seedGlobalPresets
};
