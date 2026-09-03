/**
 * 鼎恒币「品类得币倍率」服务（得币倍率唯一计算入口）
 *
 * 数据源链路：CoinRule（开发者控制台配置）→ 本服务计算 → 采购订单确认收货发币落库
 * 倍率一律来自数据库 CoinRule 集合，代码中不写死任何倍率；未配置品类按 1 倍计。
 *
 * 发币口径：订单明细逐行计算，每行 = 商品金额(totalPrice) × 会员返币率(rate) × 品类倍率，逐行汇总后向下取整。
 */
const CoinRule = require('../models/CoinRule');
const SupplyProduct = require('../models/SupplyProduct');

// 未配置任何规则时的默认倍率
const DEFAULT_MULTIPLIER = 1;
// 未知品类兜底品类名
const FALLBACK_CATEGORY = '其他';

// 标准品类（控制台默认列出；实际清单会与商品库现有品类、已配置规则动态合并）
const STANDARD_CATEGORIES = ['蔬菜', '肉类', '冻品', '海鲜', '酒水', '粮油', '调料', '粮油酱料', '一次性用品', '其他'];

/**
 * 取生效倍率映射（仅 enabled=true 的规则）
 * @returns {Promise<Map<string, number>>} category → multiplier
 */
async function getMultiplierMap() {
  const rules = await CoinRule.find({ enabled: true }).lean();
  const map = new Map();
  rules.forEach(r => {
    const v = Number(r.multiplier);
    map.set(r.category, isNaN(v) || v < 0 ? 0 : v);
  });
  return map;
}

/**
 * 某品类的生效倍率：精确品类匹配 → 「其他」兜底规则 → 默认 1 倍
 */
function multiplierFor(map, category) {
  const cat = String(category || '').trim();
  if (cat && map.has(cat)) return Number(map.get(cat)) || 0;
  if (map.has(FALLBACK_CATEGORY)) return Number(map.get(FALLBACK_CATEGORY)) || 0;
  return DEFAULT_MULTIPLIER;
}

/**
 * 全部品类清单：标准品类 ∪ 商品库现有品类 ∪ 已配置规则品类（去重）
 */
async function listAllCategories() {
  const [productCats, rules] = await Promise.all([
    SupplyProduct.distinct('category'),
    CoinRule.find().select('category').lean()
  ]);
  const set = new Set(STANDARD_CATEGORIES);
  (productCats || []).forEach(c => {
    const v = String(c || '').trim();
    if (v) set.add(v);
  });
  rules.forEach(r => {
    const v = String(r.category || '').trim();
    if (v) set.add(v);
  });
  return [...set];
}

/**
 * 控制台配置视图：每个品类一行 { category, multiplier, enabled, configured }
 * 未配置过的品类 multiplier 返回默认 1、enabled=true、configured=false
 */
async function getRuleView() {
  const [categories, rules] = await Promise.all([
    listAllCategories(),
    CoinRule.find().lean()
  ]);
  const ruleMap = new Map(rules.map(r => [r.category, r]));
  return categories.map(category => {
    const rule = ruleMap.get(category);
    return {
      category,
      multiplier: rule ? Number(rule.multiplier) : DEFAULT_MULTIPLIER,
      enabled: rule ? !!rule.enabled : true,
      configured: !!rule
    };
  });
}

/**
 * 逐行计算订单采购返币
 * 发币口径：券不返币——按实付金额计算。若订单使用了抵用券，券抵扣额按各行金额占比
 * 分摊到各行（ratio = actualPayAmount / totalAmount），每行实付金额 × 返币率 × 品类倍率，
 * 汇总后向下取整。无券时 ratio=1，与原逻辑一致。
 * @param {Array} items 订单明细 [{ category, totalPrice, productId }]
 * @param {number} rate 会员返币率（币/元），0 表示不发币
 * @param {Map} [map] 品类倍率映射（不传则现查）
 * @param {{totalAmount:number, actualPayAmount:number}} [opts] 券抵扣分摊用：订单原价与实付金额
 * @returns {Promise<{rewardCoin:number, baseCoin:number, boosted:boolean, lines:Array}>}
 *   rewardCoin 实发鼎恒币（含倍率，按实付金额）；baseCoin 不含倍率的基准币；boosted 是否存在 >1 倍品类
 */
async function calcOrderRewardCoin(items, rate, map, opts) {
  if (!rate || rate <= 0) {
    return { rewardCoin: 0, baseCoin: 0, boosted: false, lines: [] };
  }
  const multMap = map || (await getMultiplierMap());
  // 券抵扣分摊比例：用券时 <1（券抵扣部分不发币），无券时 =1
  const totalAmt = opts && Number(opts.totalAmount) > 0 ? Number(opts.totalAmount) : 0;
  const actualAmt = opts && Number(opts.actualPayAmount) >= 0 ? Number(opts.actualPayAmount) : 0;
  let payRatio = 1;
  if (totalAmt > 0 && actualAmt > 0 && actualAmt < totalAmt) {
    payRatio = actualAmt / totalAmt;
  }
  const productCache = new Map();
  let weightedSum = 0;
  let baseSum = 0;
  let boosted = false;
  const lines = [];

  for (const it of (items || [])) {
    const amount = Number(it.totalPrice) || 0;
    let category = String(it.category || '').trim();
    // 老订单明细无品类快照时，按 productId 回查商品库
    if (!category && it.productId) {
      const key = String(it.productId);
      if (!productCache.has(key)) {
        const p = await SupplyProduct.findById(it.productId).select('category').lean();
        productCache.set(key, p ? String(p.category || '').trim() : '');
      }
      category = productCache.get(key);
    }
    const mult = multiplierFor(multMap, category);
    if (mult > 1) boosted = true;
    // 实付金额 = 行原价 × 分摊比例（券抵扣部分不计入发币基数）
    const effAmount = amount * payRatio;
    const base = effAmount * rate;
    const weighted = base * mult;
    weightedSum += weighted;
    baseSum += base;
    lines.push({ category: category || FALLBACK_CATEGORY, amount: effAmount, multiplier: mult, coin: weighted });
  }

  return {
    rewardCoin: Math.floor(weightedSum),
    baseCoin: Math.floor(baseSum),
    boosted,
    lines
  };
}

module.exports = {
  DEFAULT_MULTIPLIER,
  FALLBACK_CATEGORY,
  STANDARD_CATEGORIES,
  getMultiplierMap,
  multiplierFor,
  listAllCategories,
  getRuleView,
  calcOrderRewardCoin
};
