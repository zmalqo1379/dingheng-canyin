// 顾客点餐页逻辑（移动端优先，桌面自动居中为手机宽度）
const params = new URLSearchParams(location.search);
let tableNumber = params.get('table') || params.get('t') || '';
// 店铺标识：必须从 URL 带 shopId 进入（由商家后台「预览点餐页」新标签打开）
const SHOP_ID = params.get('shopId') || '';
const IS_PREVIEW = params.get('preview') === '1';
// embed=1：预览以 iframe 嵌入商家后台手机框，关闭按钮与 Esc 由父页面接管
const IS_EMBED = params.get('embed') === '1';
const cart = {}; // { dishId: { dish, quantity } }
let dishes = [];
let categories = [];
let currentCategory = '';
let spyLockUntil = 0; // 点击分类平滑滚动期间暂停滚动联动
let dishMap = {};     // { dishId: dish }
let activeMarketing = []; // 当前生效的满减/折扣活动（/api/marketing/active 返回）

const $ = (id) => document.getElementById(id);

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hashStr(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// 桌号显示格式：纯数字 -> "5号桌"，否则 -> "A1桌"
function formatTable(num) {
  if (!num) return '未选桌';
  return /^\d+$/.test(String(num)) ? `${num}号桌` : `${num}桌`;
}

// 价格显示：整数部分大字、小数部分跟随
function priceHtml(p) {
  return `<span class="sym">¥</span><span class="num">${p}</span>`;
}

const toast = (msg) => {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1500);
};

// 无图占位：品类配色 + 食物图标（不用纯色块）
const PH_COLORS = [
  'linear-gradient(135deg,#ffe8d2,#ffb877)',
  'linear-gradient(135deg,#ffe0d6,#ff9d84)',
  'linear-gradient(135deg,#fff3c8,#ffcf5c)',
  'linear-gradient(135deg,#e3f6e6,#96dfa6)',
  'linear-gradient(135deg,#e1efff,#93c6ff)',
  'linear-gradient(135deg,#f5e6ff,#d0a3ff)',
  'linear-gradient(135deg,#ffe4ef,#ffa1c4)'
];
const PH_ICONS = ['🍜', '🍚', '🥘', '🍗', '🥟', '🍤', '🥗', '🍲', '🍳', '🍣', '🍛', '🥠', '🍢', '🫕'];
function phStyle(dish) {
  return {
    bg: PH_COLORS[hashStr(dish.category) % PH_COLORS.length],
    icon: PH_ICONS[hashStr(dish.name) % PH_ICONS.length]
  };
}

// 月销量占位（按菜名稳定生成）
const SALES = ['月售 32', '月售 58', '月售 126', '月售 200+', '月售 456+', '月售 88'];
function salesText(dish) {
  return SALES[hashStr('sale_' + dish.name) % SALES.length];
}

/* ---------- shopId 缺失校验 ---------- */
function ensureShopId() {
  if (SHOP_ID) return true;
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;';
  mask.innerHTML = '<div style="background:#fff;border-radius:16px;padding:32px 26px;max-width:340px;"><div style="font-size:44px;margin-bottom:12px;">🏪</div><h2 style="font-size:18px;margin-bottom:10px;">缺少店铺标识</h2><p style="font-size:14px;color:#666;line-height:1.6;">请扫描桌上二维码进入点餐，链接需带 <b>shopId</b> 参数。</p></div>';
  document.body.appendChild(mask);
  return false;
}

/* ---------- 店铺风格主题 ---------- */
// 与 models/Setting.js theme 枚举保持一致
const THEME_LIST = ['classic', 'minimal', 'dark', 'green', 'redgold'];
// 店名字体（系统字体栈，与后台 NAME_FONTS / models/Setting.js shopNameFont 一致）
const NAME_FONT_STACKS = {
  modern: '-apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif SC", "Songti SC", "STSong", "SimSun", serif',
  round: '"Yuanti SC", "YouYuan", "幼圆", "PingFang SC", sans-serif',
  hand: '"Kaiti SC", "STKaiti", "KaiTi", "楷体", cursive'
};
// 菜单排版（与 models/Setting.js layout 枚举一致）
const LAYOUT_LIST = ['list', 'large', 'grid'];
let currentLayout = 'list';

function applyShopTheme(setting) {
  const s = setting || {};
  const t = THEME_LIST.includes(s.theme) ? s.theme : 'classic';
  THEME_LIST.forEach(x => document.body.classList.remove('theme-' + x));
  document.body.classList.add('theme-' + t);
  // 店名字体：后台选择覆盖（系统字体栈，不加载外部字体）
  document.body.style.setProperty('--font-shopname', NAME_FONT_STACKS[s.shopNameFont] || NAME_FONT_STACKS.modern);
  // 菜单排版：list 经典列表 / large 大图模式 / grid 双列网格
  currentLayout = LAYOUT_LIST.includes(s.layout) ? s.layout : 'list';
  LAYOUT_LIST.forEach(x => document.body.classList.remove('layout-' + x));
  document.body.classList.add('layout-' + currentLayout);
  // 自定义横幅背景图：加深色遮罩保证文字可读；未上传则用主题默认渐变
  const banner = $('shopBanner');
  if (banner) {
    if (s.bannerImage) {
      banner.style.setProperty('--banner-layer',
        `linear-gradient(rgba(0,0,0,.28), rgba(0,0,0,.28)), url("${s.bannerImage}")`);
      banner.classList.add('has-photo');
    } else {
      banner.style.removeProperty('--banner-layer');
      banner.classList.remove('has-photo');
    }
  }
  // 自定义店铺 LOGO：显示在店名左侧；未上传则不显示任何默认图标，店名放大为视觉主体
  const logo = $('shopLogo');
  if (logo) {
    if (s.logoImage) {
      logo.style.display = 'flex';
      logo.innerHTML = `<img src="${esc(s.logoImage)}" alt="店铺LOGO" onerror="this.remove()">`;
    } else {
      logo.style.display = 'none';
      logo.innerHTML = '';
    }
  }
  const shopLine = $('shopLine');
  if (shopLine) shopLine.classList.toggle('no-logo', !s.logoImage);
}

/* ---------- 装修预览：URL 参数覆盖已应用 setting（叠加预览效果） ---------- */
function getPreviewOverrides() {
  const o = {};
  const theme = params.get('theme');
  const font = params.get('shopNameFont') || params.get('font');
  const layout = params.get('layout');
  const banner = params.get('bannerImage');
  const logo = params.get('logoImage');
  const name = params.get('shopName');
  if (theme) o.theme = theme;
  if (font) o.shopNameFont = font;
  if (layout) o.layout = layout;
  if (banner) o.bannerImage = banner;
  if (logo) o.logoImage = logo;
  if (name) o.shopName = name;
  return o;
}

/* ---------- 数据加载 ---------- */
async function loadShopInfo() {
  try {
    const res = await fetch(`/api/settings?shopId=${encodeURIComponent(SHOP_ID)}`).then(r => r.json());
    let s = res.success ? res.data : null;
    // 装修预览模式：URL 参数覆盖已应用 setting（叠加预览效果）
    if (IS_PREVIEW) s = Object.assign({}, s || {}, getPreviewOverrides());
    applyShopTheme(s);
    let shopName = '欢迎光临';
    if (res.success && res.data && res.data.shopName) shopName = res.data.shopName;
    if (s && s.shopName) shopName = s.shopName;
    $('shopName').textContent = shopName;
    document.title = `${shopName} · 扫码点餐`;
  } catch (e) {
    applyShopTheme(null);
    $('shopName').textContent = '欢迎光临';
  }
}

async function loadData() {
  try {
    const qs = `shopId=${encodeURIComponent(SHOP_ID)}`;
    const [catRes, dishRes] = await Promise.all([
      fetch(`/api/categories?${qs}`).then(r => r.json()),
      fetch(`/api/dishes?${qs}`).then(r => r.json())
    ]);
    categories = (catRes && catRes.data) ? catRes.data : [];
    // 保留全部菜品（含售罄），由前端显示遮罩
    dishes = (dishRes && dishRes.data) ? dishRes.data : [];
    dishMap = {};
    dishes.forEach(d => { dishMap[d._id] = d; });
    if (categories.length > 0 && !categories.some(c => c.name === currentCategory)) {
      currentCategory = categories[0].name;
    }
    renderMenu();
    highlightSidebar();
    $('skeleton').style.display = 'none';
    $('main').style.display = 'flex';
    // 拉取生效中的营销活动，渲染顶部横幅 + 凑单提示
    await loadActiveMarketing();
    updateCartUI();
  } catch (e) {
    $('skeleton').style.display = 'none';
    $('main').style.display = 'block';
    $('content').innerHTML = '<div class="empty-tip"><div class="icon">😵</div>加载失败，请刷新重试</div>';
  }
}

/* ---------- 营销活动：拉取生效中的满减/折扣 ---------- */
async function loadActiveMarketing() {
  try {
    const res = await fetch(`/api/marketing/active?shopId=${encodeURIComponent(SHOP_ID)}`).then(r => r.json());
    activeMarketing = (res && res.success && Array.isArray(res.data)) ? res.data : [];
  } catch (e) {
    activeMarketing = [];
  }
  renderPromoBanner();
}

function renderPromoBanner() {
  const banner = $('promoBanner');
  const inner = $('promoInner');
  if (!banner || !inner) return;
  if (!activeMarketing.length) { banner.style.display = 'none'; return; }
  const parts = [];
  activeMarketing.forEach(r => {
    if (r.type === 'fullReduction') {
      parts.push(`<span class="pi-tag">满减</span><span class="pi-txt">满 ¥${fmtMoney(r.threshold)} 减 ¥${fmtMoney(r.reduce)}</span>`);
    } else if (r.type === 'discount') {
      const zhe = Math.round(Number(r.rate) * 10);
      parts.push(`<span class="pi-tag">折扣</span><span class="pi-txt">${r.category ? esc(r.category) + ' ' : '全场 '}${zhe}折</span>`);
    }
  });
  inner.innerHTML = parts.join('<span style="opacity:.5;">·</span>');
  banner.style.display = 'block';
}

/* ---------- 渲染菜单 ---------- */
function dishImgHtml(dish, cls) {
  const ph = phStyle(dish);
  const img = dish.image
    ? `<img class="dish-photo" src="${esc(dish.image)}" alt="${esc(dish.name)}" loading="lazy" onerror="this.style.display='none'">`
    : '';
  return `<div class="${cls}">
    <div class="dish-ph" style="background:${ph.bg}"><span class="ico">${ph.icon}</span></div>
    ${img}
    ${dish.isAvailable === false ? '<div class="soldout-mask">已售罄</div>' : ''}
  </div>`;
}

function stepperHtml(dish, qty) {
  const available = dish.isAvailable !== false;
  const minus = (qty > 0 && available)
    ? `<button class="step-btn minus" data-id="${dish._id}" data-act="minus">−</button><span class="step-num">${qty}</span>`
    : '';
  return `${minus}<button class="step-btn plus" data-id="${dish._id}" data-act="plus" ${available ? '' : 'disabled'}>＋</button>`;
}

function renderMenu() {
  const sidebar = $('sidebar');
  const content = $('content');
  if (categories.length === 0) {
    sidebar.innerHTML = '<div class="sidebar-empty">暂无分类</div>';
    content.innerHTML = '<div class="empty-tip"><div class="icon">🍽️</div>商家还未上架菜品，稍后再来看看</div>';
    return;
  }
  sidebar.innerHTML = categories.map((c, i) =>
    `<div class="sidebar-item ${c.name === currentCategory ? 'active' : ''}" data-cat="${esc(c.name)}" data-index="${i}">${esc(c.name)}</div>`
  ).join('');

  content.innerHTML = categories.map((c, i) => {
    const list = dishes.filter(d => d.category === c.name);
    const cards = list.map(d => {
      const qty = (cart[d._id] && cart[d._id].quantity) || 0;
      const soldout = d.isAvailable === false;
      return `
      <div class="dish-card ${soldout ? 'soldout' : ''}" data-id="${d._id}">
        ${dishImgHtml(d, 'dish-img')}
        <div class="dish-info">
          <div class="dish-name">${esc(d.name)}</div>
          ${d.description ? `<div class="dish-desc">${esc(d.description)}</div>` : ''}
          <div class="dish-meta"><span class="sales">${salesText(d)}</span></div>
          <div class="dish-foot">
            <span class="price">${priceHtml(d.price)}</span>
            <div class="stepper step-slot" data-id="${d._id}">${stepperHtml(d, qty)}</div>
          </div>
        </div>
      </div>`;
    }).join('');
    // 双列网格布局：卡片包一层 grid 容器；其余布局直接平铺
    const cardsHtml = currentLayout === 'grid' ? `<div class="dish-grid">${cards}</div>` : cards;
    const bodyHtml = cards ? cardsHtml : '<div class="empty-tip">该分类暂无菜品</div>';
    return `<div class="cat-section" id="sec-${i}" data-cat="${esc(c.name)}">
      <div class="cat-title">— ${esc(c.name)} —</div>
      ${bodyHtml}
    </div>`;
  }).join('');
}

/* ---------- 购物车 ---------- */
function getQty(id) {
  return (cart[id] && cart[id].quantity) || 0;
}
function getCartArray() {
  return Object.values(cart).filter(i => i.quantity > 0);
}
function cartCount() {
  return getCartArray().reduce((s, i) => s + i.quantity, 0);
}
function cartTotal() {
  return getCartArray().reduce((s, i) => s + i.dish.price * i.quantity, 0);
}
// 金额显示：保留两位小数但去掉多余的 0
function fmtMoney(n) {
  return (Math.round(n * 100) / 100).toString();
}

/* ---------- 营销优惠计算（与后端 utils/marketingCalc.js 逻辑一致） ---------- */
// items: [{ dishName, price, quantity, category }]；rules: [{ type, threshold, reduce, rate, category }]
// 顺序：先按品类应用折扣得「折扣后小计」，再基于该小计应用满减
function computeDiscount(items, rules) {
  items = Array.isArray(items) ? items : [];
  rules = Array.isArray(rules) ? rules : [];
  const originalTotal = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
  let globalRate = 1;
  const catRates = {};
  for (const r of rules) {
    if (r.type !== 'discount') continue;
    const rate = Math.max(0.01, Math.min(1, Number(r.rate) || 1));
    if (!r.category) globalRate = Math.min(globalRate, rate);
    else {
      const cur = catRates[r.category];
      if (cur == null || rate < cur) catRates[r.category] = rate;
    }
  }
  let discountSubtotal = 0;
  const itemDiscounts = [];
  for (const it of items) {
    const lineOriginal = (Number(it.price) || 0) * (Number(it.quantity) || 0);
    const rate = (catRates[it.category] != null) ? catRates[it.category] : globalRate;
    discountSubtotal += lineOriginal * rate;
    if (rate < 1) itemDiscounts.push({ name: it.dishName, category: it.category, rate, saved: +(lineOriginal - lineOriginal * rate).toFixed(2) });
  }
  const itemDiscountAmount = +(originalTotal - discountSubtotal).toFixed(2);
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
  return {
    originalTotal: +originalTotal.toFixed(2),
    discountSubtotal: +discountSubtotal.toFixed(2),
    itemDiscountAmount, fullReductionAmount,
    discountAmount: +(originalTotal - finalTotal).toFixed(2),
    finalTotal, bestFull,
    discountRules: rules.filter(r => r.type === 'discount'),
    fullReductionRules: rules.filter(r => r.type === 'fullReduction')
  };
}
// 当前购物车的优惠计算结果
function getCartCalc() {
  const items = getCartArray().map(i => ({ dishName: i.dish.name, price: i.dish.price, quantity: i.quantity, category: i.dish.category }));
  return computeDiscount(items, activeMarketing);
}
// 凑单提示文案：找下一个未达门槛的满减
function buildHintText(calc) {
  if (!activeMarketing.length) return '';
  const sub = calc.discountSubtotal; // 折扣后小计，满减基于此判定
  const fulls = activeMarketing.filter(r => r.type === 'fullReduction')
    .map(r => ({ threshold: Number(r.threshold), reduce: Number(r.reduce) }))
    .filter(r => r.threshold > 0 && r.reduce > 0)
    .sort((a, b) => a.threshold - b.threshold);
  if (fulls.length) {
    // 已达最高档
    const maxMet = fulls.filter(f => sub >= f.threshold - 1e-9)
      .sort((a, b) => b.reduce - a.reduce)[0];
    const next = fulls.find(f => sub < f.threshold - 1e-9);
    if (maxMet && !next) return `已享满${maxMet.threshold}减${maxMet.reduce}`;
    if (next) {
      const diff = +(next.threshold - sub).toFixed(2);
      return `再买¥${fmtMoney(diff)}可减¥${next.reduce}`;
    }
  }
  // 仅有折扣：提示折扣
  const dr = activeMarketing.find(r => r.type === 'discount');
  if (dr) {
    const zhe = Math.round(Number(dr.rate) * 10);
    return dr.category ? `${dr.category}${zhe}折进行中` : `全场${zhe}折进行中`;
  }
  return '';
}

function addOne(id) {
  const d = dishMap[id];
  if (!d || d.isAvailable === false) return;
  if (!cart[id]) cart[id] = { dish: d, quantity: 0 };
  cart[id].quantity++;
  bumpCartIcon();
  refreshAfterQtyChange(id);
}
function subOne(id) {
  if (!cart[id]) return;
  cart[id].quantity--;
  if (cart[id].quantity <= 0) delete cart[id];
  refreshAfterQtyChange(id);
}
function refreshAfterQtyChange(id) {
  // 只更新对应卡片的加减器，避免整页重绘闪烁
  document.querySelectorAll(`.step-slot[data-id="${id}"]`).forEach(slot => {
    if (dishMap[id]) slot.innerHTML = stepperHtml(dishMap[id], getQty(id));
  });
  updateCartUI();
}

function bumpCartIcon() {
  const el = $('cartIcon');
  el.classList.remove('bump');
  void el.offsetWidth; // 重新触发动画
  el.classList.add('bump');
}

function updateCartUI() {
  const count = cartCount();
  const calc = getCartCalc();
  const total = fmtMoney(calc.finalTotal);
  const badge = $('cartBadge');
  badge.textContent = count;
  badge.style.display = count > 0 ? 'flex' : 'none';
  // 购物车栏显示实付金额（已应用优惠）
  $('cartTotal').textContent = total;
  $('cartCount').textContent = count > 0 ? `已选 ${count} 件` : '未选购商品';
  // 凑单提示
  const hintEl = $('cartHint');
  const sheetHintEl = $('sheetHint');
  if (count > 0 && activeMarketing.length) {
    const txt = buildHintText(calc);
    const hit = !!calc.bestFull;
    if (hintEl) { hintEl.textContent = txt; hintEl.classList.toggle('hit', hit); }
    if (sheetHintEl) { sheetHintEl.textContent = txt; sheetHintEl.classList.toggle('hit', hit); }
  } else {
    if (hintEl) hintEl.textContent = '';
    if (sheetHintEl) sheetHintEl.textContent = '';
  }
  $('checkoutBtn').disabled = count === 0;
  if ($('cartMask').classList.contains('show')) renderCartSheet();
}

/* ---------- 购物车清单弹层 ---------- */
function renderCartSheet() {
  const arr = getCartArray();
  $('sheetTotal').textContent = fmtMoney(getCartCalc().finalTotal);
  $('cartList').innerHTML = arr.map(i => {
    const ph = phStyle(i.dish);
    return `
    <div class="sheet-item">
      <div class="si-thumb"><div class="mini-ph" style="background:${ph.bg}">${ph.icon}</div>${i.dish.image ? `<img class="dish-photo" src="${esc(i.dish.image)}" alt="" onerror="this.style.display='none'">` : ''}</div>
      <div class="si-info">
        <div class="si-name">${esc(i.dish.name)}</div>
        <div class="si-price">¥${i.dish.price}</div>
      </div>
      <div class="stepper">
        <button class="step-btn minus" data-id="${i.dish._id}" data-act="minus">−</button>
        <span class="step-num">${i.quantity}</span>
        <button class="step-btn plus" data-id="${i.dish._id}" data-act="plus">＋</button>
      </div>
    </div>`;
  }).join('');
}

function openCartSheet() {
  if (getCartArray().length === 0) { toast('请先选择菜品'); return; }
  renderCartSheet();
  $('cartMask').classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeCartSheet() {
  $('cartMask').classList.remove('show');
  document.body.style.overflow = '';
}

/* ---------- 分类联动（滚动高亮 + 点击滚动） ---------- */
function highlightSidebar() {
  document.querySelectorAll('.sidebar-item').forEach(el => {
    const on = el.dataset.cat === currentCategory;
    el.classList.toggle('active', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
}

let scrollRaf = null;
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    if (Date.now() < spyLockUntil) return;
    const sections = document.querySelectorAll('.cat-section');
    if (!sections.length) return;
    const offset = 150;
    let active = sections[0].dataset.cat;
    sections.forEach(sec => {
      if (sec.getBoundingClientRect().top <= offset) active = sec.dataset.cat;
    });
    // 滚动到底时强制高亮最后一个分类
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 60) {
      active = sections[sections.length - 1].dataset.cat;
    }
    if (active !== currentCategory) {
      currentCategory = active;
      highlightSidebar();
    }
  });
}
window.addEventListener('scroll', onScroll, { passive: true });

$('sidebar').addEventListener('click', (e) => {
  const item = e.target.closest('.sidebar-item');
  if (!item) return;
  currentCategory = item.dataset.cat;
  highlightSidebar();
  spyLockUntil = Date.now() + 800;
  const sec = document.getElementById('sec-' + item.dataset.index);
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---------- 菜品加减（事件委托：卡片 + 购物车弹层通用） ---------- */
document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('.step-btn');
  if (!btn || btn.disabled) return;
  e.stopPropagation();
  const id = btn.dataset.id;
  if (btn.dataset.act === 'plus') addOne(id); else subOne(id);
});

/* ---------- 结算页 ---------- */
let tablesCache = null; // 桌台列表缓存（缺桌号参数时用于选择）

async function renderCheckout() {
  const arr = getCartArray();
  const calc = getCartCalc();
  $('ckTotal').textContent = fmtMoney(calc.finalTotal);
  $('ckTable').textContent = formatTable(tableNumber);
  // 未从二维码取到桌号：优先让顾客从桌台列表选，无桌台数据则手填
  const pickRow = $('ckTablePickRow');
  const inputRow = $('ckTableInputRow');
  pickRow.style.display = 'none';
  inputRow.style.display = 'none';
  if (!tableNumber) {
    try {
      if (!tablesCache) {
        const res = await fetch(`/api/tables?shopId=${encodeURIComponent(SHOP_ID)}`).then(r => r.json());
        tablesCache = (res.data || []).map(t => t.number);
      }
      if (tablesCache.length > 0) {
        $('ckTableSelect').innerHTML = '<option value="">请选择桌台</option>' +
          tablesCache.map(n => `<option value="${esc(n)}">${esc(formatTable(n))}</option>`).join('');
        pickRow.style.display = 'flex';
      } else {
        inputRow.style.display = 'flex';
      }
    } catch (e) {
      inputRow.style.display = 'flex';
    }
  }
  $('ckItems').innerHTML = arr.map(i => {
    const ph = phStyle(i.dish);
    return `
    <div class="ck-item">
      <div class="si-thumb"><div class="mini-ph" style="background:${ph.bg}">${ph.icon}</div>${i.dish.image ? `<img class="dish-photo" src="${esc(i.dish.image)}" alt="" onerror="this.style.display='none'">` : ''}</div>
      <div style="flex:1;min-width:0;">
        <div class="ck-item-name">${esc(i.dish.name)}</div>
        <div class="ck-item-sub">¥${i.dish.price} × ${i.quantity}</div>
      </div>
      <span class="ck-item-total">¥${fmtMoney(i.dish.price * i.quantity)}</span>
    </div>`;
  }).join('');
  // 优惠明细卡片（有满减/折扣时显示）
  renderDiscountCard(calc);
}

function renderDiscountCard(calc) {
  const card = $('ckDiscountCard');
  const body = $('ckDiscountBody');
  if (!card || !body) return;
  if (!activeMarketing.length || calc.discountAmount <= 0) {
    card.style.display = 'none';
    body.innerHTML = '';
    return;
  }
  card.style.display = 'block';
  const rows = [];
  rows.push(`<div class="ck-disc-row"><span>商品原价</span><span class="ck-disc-val">¥${fmtMoney(calc.originalTotal)}</span></div>`);
  if (calc.itemDiscountAmount > 0) {
    // 折扣明细：列出全场/分类折扣
    const dr = activeMarketing.find(r => r.type === 'discount');
    const label = dr ? (dr.category ? `${dr.category}折扣` : '全场折扣') : '折扣';
    const zhe = dr ? Math.round(Number(dr.rate) * 10) + '折' : '';
    rows.push(`<div class="ck-disc-row discount"><span>${label}${zhe ? '·' + zhe : ''}</span><span class="ck-disc-val">-¥${fmtMoney(calc.itemDiscountAmount)}</span></div>`);
  }
  if (calc.fullReductionAmount > 0 && calc.bestFull) {
    rows.push(`<div class="ck-disc-row discount"><span>满减（满${calc.bestFull.threshold}减${calc.bestFull.reduce}）</span><span class="ck-disc-val">-¥${fmtMoney(calc.fullReductionAmount)}</span></div>`);
  }
  rows.push(`<div class="ck-disc-row total"><span>实付</span><span class="ck-disc-val">¥${fmtMoney(calc.finalTotal)}</span></div>`);
  body.innerHTML = rows.join('');
}

async function openCheckout() {
  if (getCartArray().length === 0) { toast('请先选择菜品'); return; }
  closeCartSheet();
  $('ckRemark').value = '';
  $('checkoutPage').classList.add('show');
  document.body.style.overflow = 'hidden';
  await renderCheckout();
}
function closeCheckout() {
  $('checkoutPage').classList.remove('show');
  document.body.style.overflow = '';
}

$('ckSubmitBtn').onclick = async () => {
  const arr = getCartArray();
  if (arr.length === 0) { toast('请先选择菜品'); return; }
  let table = tableNumber;
  if (!table) {
    const pickRowVisible = $('ckTablePickRow').style.display !== 'none';
    table = pickRowVisible
      ? $('ckTableSelect').value
      : $('ckTableInput').value.trim();
  }
  if (!table) { toast('请选择或填写桌台号'); return; }
  tableNumber = table; // 记住本次使用的桌号
  const items = arr.map(i => ({ dishName: i.dish.name, price: i.dish.price, quantity: i.quantity, category: i.dish.category || '' }));
  const remark = $('ckRemark').value.trim().slice(0, 200);
  const btn = $('ckSubmitBtn');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    // 下单时通过 x-shop-id 请求头携带店铺标识，后端写入订单 shopId 字段
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-shop-id': SHOP_ID },
      body: JSON.stringify({ tableNumber, items, remark })
    }).then(r => r.json());
    if (res.success) {
      Object.keys(cart).forEach(k => delete cart[k]);
      closeCheckout();
      dishes.forEach(d => refreshAfterQtyChange(d._id));
      updateCartUI();
      $('successTable').textContent = formatTable(tableNumber);
      $('successPage').classList.add('show');
      document.body.style.overflow = 'hidden';
      clearTimeout(openCheckout._t);
      openCheckout._t = setTimeout(closeSuccess, 3200);
    } else {
      toast(res.message || '下单失败');
    }
  } catch (e) {
    toast('网络错误，请重试');
  } finally {
    btn.disabled = false;
    btn.textContent = '提交订单';
  }
};

function closeSuccess() {
  $('successPage').classList.remove('show');
  document.body.style.overflow = '';
}
$('successBackBtn').onclick = closeSuccess;
$('ckBackBtn').onclick = closeCheckout;

/* ---------- 事件绑定 ---------- */
$('checkoutBtn').onclick = openCheckout;
$('sheetCheckoutBtn').onclick = openCheckout;
$('cartIcon').onclick = openCartSheet;
$('cartMask').onclick = (e) => { if (e.target.id === 'cartMask') closeCartSheet(); };
$('clearCartBtn').onclick = () => {
  if (getCartArray().length === 0) return;
  if (!confirm('确定清空购物车吗？')) return;
  Object.keys(cart).forEach(k => delete cart[k]);
  dishes.forEach(d => refreshAfterQtyChange(d._id));
  updateCartUI();
  closeCartSheet();
  toast('已清空');
};

/* ---------- 装修预览模式：返回按钮 + Esc 返回 + 隐藏购物车交互 ----------
   说明：旧版「任意键返回」会拦截 F12 等开发者工具按键，已改为仅 Esc 返回。
   embed=1 时本页以 iframe 嵌入商家后台手机框，关闭由父页面接管（不渲染返回栏、不绑按键）。 */
function setupPreviewReturn() {
  // 隐藏购物车栏 / 加购按钮 / 桌号 pill（预览仅展示装修效果，不交互）
  const style = document.createElement('style');
  style.textContent = `
    .cart-bar, .stepper, .table-pill { display: none !important; }
    .banner-sub { gap: 0; }
    #backNav .back-link { font-weight: 700; }
  `;
  document.head.appendChild(style);
  // embed 模式：不渲染返回栏，关闭交给父页面
  if (IS_EMBED) return;
  // 改造顶部 back-nav 为「✕ 返回装修」
  const nav = $('backNav');
  if (nav) {
    nav.innerHTML = `<a class="back-link" id="previewBack">✕ 返回装修</a><span class="hint">按 Esc 键或点 ✕ 返回商家后台</span>`;
    const back = $('previewBack');
    if (back) back.onclick = closePreviewWindow;
  }
  // 仅 Esc 键返回（不再拦截 F12 等任意键）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePreviewWindow();
  });
}

function closePreviewWindow() {
  try {
    if (window.opener && !window.opener.closed) { window.close(); return; }
  } catch (e) {}
  // 后备：跳回 admin.html 装修栏目
  window.location.href = '/admin.html#decorate';
}

/* ---------- 初始化 ---------- */
if (IS_PREVIEW) {
  if (!IS_EMBED) document.body.classList.add('has-nav');
  setupPreviewReturn();
}
$('tableInfo').textContent = formatTable(tableNumber);
if (ensureShopId()) {
  loadShopInfo();
  loadData();
}
