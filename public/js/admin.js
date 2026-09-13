/* 鼎恒餐饮 · 管理后台逻辑 */
/* 注意：后端实际接口为 /api/admin/dishes、/api/admin/tables（非 /api/dishes、/api/dishes），
   本文件按 server.js 中真实存在的接口调用，未改动 server.js。 */

// 当前登录商家的 shopId（来自商家登录返回），用于鼎恒币/会员/券等以 shopId 为参数的接口
const SHOP_ID = localStorage.getItem('merchantShopId') || 'shop_default_001';

// ===== 权限控制：JWT 商家身份校验 =====
// 页面加载时检查商家登录凭证，无 token 强制跳转到商家登录页
const MERCHANT_TOKEN = localStorage.getItem('merchantToken');
if (!MERCHANT_TOKEN) {
  location.href = '/merchant-login.html';
}

const $ = (id) => document.getElementById(id);
let categories = [];

/* ---------- 工具 ---------- */
function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1600);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function api(url, opts) {
  try {
    // 自动携带商家登录凭证 + 当前店铺 shopId（x-shop-id 请求头）
    // 后端：公开接口按 x-shop-id 过滤，商家鉴权接口按 JWT.shopId 校验一致性
    const finalOpts = opts || {};
    const headers = Object.assign({}, finalOpts.headers || {});
    if (MERCHANT_TOKEN && !headers['Authorization']) {
      headers['Authorization'] = 'Bearer ' + MERCHANT_TOKEN;
    }
    if (SHOP_ID && !headers['x-shop-id']) {
      headers['x-shop-id'] = SHOP_ID;
    }
    finalOpts.headers = headers;
    const res = await fetch(url, finalOpts).then(r => r.json());
    return res;
  } catch (e) {
    toast('网络错误', true);
    return { success: false, message: 'network' };
  }
}

/* ---------- 登出 ---------- */
$('logoutBtn').onclick = () => {
  // 清除商家登录凭证并跳转回商家登录页
  localStorage.removeItem('merchantToken');
  localStorage.removeItem('merchantShopId');
  localStorage.removeItem('merchantShopName');
  location.href = '/merchant-login.html';
};

// 已通过 JWT 登录（存在 merchantToken）则直接进入管理界面；无 token 已在上方跳转登录页
if (MERCHANT_TOKEN) {
  document.getElementById('adminPage').classList.add('show');
  // 响应 URL hash：从预览返回时自动定位到装修栏目
  const h = location.hash.replace('#', '');
  const initTab = (h && ['home','mall','smartReplenish','purchase','procurement','dishes','tables','orders','stats','decorate','settings','member','coin','points','storedvalue','marketing'].includes(h)) ? h : 'home';
  // 延迟到当前脚本执行完再切换：避免 switchTab 在脚本顶层执行时，
  // 访问到尚未初始化的模块级变量（如 _obData）导致 TDZ 报错
  setTimeout(() => {
    try { switchTab(initTab); } catch (e) { console.error('初始化失败', e); }
    // 首屏渲染后，后台静默预加载其余栏目，让后续点击秒开
    setTimeout(preloadAllTabs, 300);
  }, 0);
  // 新手开张四步曲任务卡（首页顶部，状态实时检测）
  try { loadOnboarding(); } catch (e) { console.error('新手任务加载失败', e); }
}

/* ---------- 侧边栏导航 ---------- */
// 栏目缓存 + 预热：登录后后台静默预加载所有栏目数据，用户点击任意栏目均秒开
const _tabCache = {};
const _realtimeTabs = new Set(['orders', 'purchase', 'stats', 'procurement']);

// 仅做数据加载（不切换 UI），供 switchTab 与预加载共用
function runTabLoader(tab) {
  if (tab === 'home') loadHome();
  else if (tab === 'dishes') { loadDishes(); loadLowStockBanner(); }
  else if (tab === 'tables') loadTables();
  else if (tab === 'orders') loadOrders();
  else if (tab === 'stats') loadStats();
  else if (tab === 'decorate') loadDecorate();
  else if (tab === 'settings') loadSettings();
  else if (tab === 'member') loadMemberCenter();
  else if (tab === 'coin') loadCoinCenter();
  else if (tab === 'smartReplenish') loadSmartReplenish();
  else if (tab === 'mall') loadMall();
  else if (tab === 'purchase') loadPurchaseOrders();
  else if (tab === 'procurement') loadProcurement();
  else if (tab === 'points') loadPoints();
  else if (tab === 'storedvalue') loadStoredValue();
  else if (tab === 'marketing') loadMarketing();
}

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach(x => x.classList.toggle('active', x.id === 'pane-' + tab));
  closeSidebar();
  if (tab === 'mall') reportOnboardStep('mall');
  try {
    if (_tabCache[tab]) {
      // 实时栏目：已缓存则静默刷新一次，保证看到最新数据；其余已缓存栏目直接秒开
      if (_realtimeTabs.has(tab)) runTabLoader(tab);
      return;
    }
    _tabCache[tab] = true;
    runTabLoader(tab);
  } catch (e) { console.error('tab load error', tab, e); }
}

// 登录后后台静默预加载全部栏目（串行 + 间隔，避免并发压垮后端），让首次点击也秒开
const _preloadOrder = ['home', 'mall', 'smartReplenish', 'purchase', 'procurement', 'dishes', 'tables', 'orders', 'stats', 'decorate', 'settings', 'member', 'coin', 'points', 'storedvalue', 'marketing'];
function preloadAllTabs() {
  let i = 0;
  function next() {
    if (i >= _preloadOrder.length) return;
    const tab = _preloadOrder[i++];
    if (!_tabCache[tab]) {
      _tabCache[tab] = true;
      try { runTabLoader(tab); } catch (e) { console.error('preload error', tab, e); }
    }
    setTimeout(next, 150);
  }
  next();
}
document.querySelectorAll('.nav-item').forEach(t => t.onclick = () => switchTab(t.dataset.tab));

/* ---------- 工作台（第一栏目 · 经营门面） ----------
   门面/热身区：问候 + 今日数据 + 待办直达 + 高倍率品类激励。
   内部使用引导，非宣传页。任一数据源失败不阻塞其他区块。 */
const _homeTips = [
  '库存告急的菜品今天就补上，别让顾客失望而归',
  '下单前看看「得币攻略」，高倍率品类得币更多',
  '收到货记得确认收货，返的鼎恒币能免费兑换会员',
  '每天看一眼待办，生意好坏心里有数',
  '采购会员快到期？鼎恒币余额够就能免费续',
  '今天还没下单？去商城逛逛今日高倍率品类',
];
function _homeGreetWord() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}
function _startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

let _homeCoinMapRes = null; // 品类倍率缓存（得币攻略用）
async function loadHome() {
  // 1) 问候横幅：店名 + 日期 + 随机小贴士
  const shopName = localStorage.getItem('merchantShopName') || '';
  const greet = $('homeGreet');
  if (greet) greet.textContent = `${_homeGreetWord()}，${shopName}`;
  const dateEl = $('homeDate');
  if (dateEl) {
    const now = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    dateEl.textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${week}`;
  }
  const tipEl = $('homeTip');
  if (tipEl) tipEl.textContent = '💡 ' + _homeTips[Math.floor(Math.random() * _homeTips.length)];

  // 2) 并行拉取：采购订单（今日额+待办）、低库存、会员状态、品类倍率
  const [poRes, lowRes, coinRes, multRes] = await Promise.all([
    api('/api/purchase-orders').catch(() => null),
    api('/api/admin/low-stock-dishes?limit=6').catch(() => null),
    api(`/api/coin/status/${SHOP_ID}`).catch(() => null),
    (async () => {
      if (_homeCoinMapRes) return _homeCoinMapRes;
      try { _homeCoinMapRes = await api('/api/coin/category-multipliers'); } catch (e) { return null; }
      return _homeCoinMapRes;
    })(),
  ]);

  // 3) 今日数据卡：今日采购额/单数 + 较昨日趋势
  const orders = (poRes && poRes.data) || [];
  const today0 = _startOfDay(new Date());
  const today24 = new Date(today0.getTime() + 86400000);
  const yst0 = new Date(today0); yst0.setDate(yst0.getDate() - 1);
  const inRange = (o, from, to) => { const t = new Date(o.createdAt); return t >= from && t < to; };
  const todayOrders = orders.filter(o => inRange(o, today0, today24));
  const ystOrders = orders.filter(o => inRange(o, yst0, today0));
  const sumAmt = (arr) => arr.reduce((s, o) => s + Number(o.totalAmount || 0), 0);
  const todayAmt = sumAmt(todayOrders), ystAmt = sumAmt(ystOrders);
  const setTrend = (id, nowV, ystV) => {
    const tr = $(id); if (!tr) return;
    if (!ystV) {
      tr.textContent = nowV > 0 ? '今日开张' : '';
      tr.className = nowV > 0 ? 'up' : '';
      return;
    }
    const pct = Math.round(((nowV - ystV) / ystV) * 100);
    tr.textContent = pct >= 0 ? `较昨日 +${pct}%` : `较昨日 ${pct}%`;
    tr.className = pct >= 0 ? 'up' : 'down';
  };
  const amtEl = $('hsTodayAmount'); if (amtEl) amtEl.textContent = '¥' + todayAmt.toFixed(2);
  const cntEl = $('hsTodayOrders'); if (cntEl) cntEl.textContent = String(todayOrders.length);
  setTrend('hsAmountTrend', todayAmt, ystAmt);
  setTrend('hsOrdersTrend', todayOrders.length, ystOrders.length);

  // 4) 待办清单：待收货 > 库存告急 > 待确认 > 会员临期
  const shipping = orders.filter(o => o.status === '已发货');
  const pending = orders.filter(o => o.status === '待确认');
  const lowData = (lowRes && lowRes.success && lowRes.data) || {};
  const lowItems = (lowData.hasBom && lowData.items) || [];
  const urgent = lowItems.filter(x => x.portionsLeft <= 5);
  const coinData = (coinRes && coinRes.success && coinRes.data) || {};
  const coinEl = $('hsCoin'); if (coinEl) coinEl.textContent = String(Number(coinData.dinghengCoin ?? 0));
  const todoEl = $('hsTodoCount'); if (todoEl) todoEl.textContent = String(shipping.length + pending.length);

  let expiringDays = null;
  if (coinData.purchaseActive !== false && coinData.purchaseExpire) {
    const days = Math.ceil((new Date(coinData.purchaseExpire) - new Date()) / 86400000);
    if (days > 0 && days <= 30) expiringDays = days;
  }

  const todos = [];
  if (shipping.length) todos.push({ tone: 'red', text: `${shipping.length} 笔订单已发货，核对重量后确认收货、坐等返币`, sub: '待收货', btn: '确认收货', tab: 'purchase' });
  if (urgent.length) todos.push({ tone: 'red', text: `${urgent.length} 道菜库存告急（${urgent.slice(0, 2).map(x => x.dishName).join('、')}${urgent.length > 2 ? ' 等' : ''}）`, sub: '库存告急', btn: '去补货', tab: 'mall' });
  else if (lowItems.length) todos.push({ tone: 'orange', text: `${lowItems.length} 道菜原料偏低，酌情补货`, sub: '库存偏低', btn: '去补货', tab: 'mall' });
  if (pending.length) todos.push({ tone: 'orange', text: `${pending.length} 笔订单已提交，等待供应商接单确认`, sub: '待确认', btn: '去查看', tab: 'purchase' });
  if (expiringDays !== null) todos.push({ tone: 'orange', text: `采购管家会员剩 ${expiringDays} 天到期，鼎恒币余额够可免费续`, sub: '会员临期', btn: '去续费', tab: 'member' });

  const list = $('homeTodoList');
  if (list) {
    if (!todos.length) {
      list.innerHTML = `<div class="home-todo-all">🎉 今日待办全部处理完，生意兴隆！</div>`;
      const sub = $('homeTodoSub'); if (sub) sub.textContent = '全部完成';
    } else {
      list.innerHTML = todos.map(t => `
        <div class="home-todo-item">
          <span class="ht-dot ${t.tone}"></span>
          <div class="ht-text">${esc(t.text)}<small>${t.sub}</small></div>
          <button class="btn" data-go="${t.tab}">${t.btn}</button>
        </div>`).join('');
      const sub = $('homeTodoSub'); if (sub) sub.textContent = `${todos.length} 项待处理`;
      list.querySelectorAll('.btn').forEach(b => b.onclick = () => switchTab(b.dataset.go));
    }
  }

  // 5) 得币攻略：品类倍率倒序（>1 高亮激励，=1 弱化展示）
  const tips = $('homeCoinTips');
  if (tips) {
    const map = (multRes && multRes.success && multRes.data) || {};
    const entries = Object.entries(map).sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0)).slice(0, 6);
    if (!entries.length) {
      tips.innerHTML = `<span class="home-coin-tag">所有品类均按 1 倍得币，正常采购即可</span>`;
    } else {
      tips.innerHTML = entries.map(([cat, m]) => {
        const mult = Number(m) || 1;
        return `<span class="home-coin-tag ${mult > 1 ? '' : 'mult1'}">${esc(cat)} <b>${mult} 倍得币</b></span>`;
      }).join('');
    }
  }
}

// 工作台快捷入口宫格：点击直达对应栏目
document.querySelectorAll('#pane-home .home-grid-item').forEach(el => el.onclick = () => switchTab(el.dataset.go));

/* ---------- 升级引导统一入口（双产品线） ----------
   所有"去升级/升级会员/升级尊享版"按钮统一跳会员中心并定位目标卡片：
   采购线 plus → vplanPlus（¥99/月）；pro → vplanPro（¥199/月）
   点餐线 advanced → vplanAdvanced（¥39/月）；premium → vplanPremium（¥79/月）
   落地后目标卡片 2 秒呼吸高亮。
   若该商家鼎恒币余额达标且本次访问未弹过，弹出引导前往鼎恒币兑换专区免费兑换（同一次访问最多一次）。 */
function goUpgrade(target) {
  switchTab('member');
  requestAnimationFrame(() => {
    const cardMap = {
      plus: 'vplanPlus', pro: 'vplanPro',
      advanced: 'vplanAdvanced', premium: 'vplanPremium',
      basic: 'vplanAdvanced', free: 'vplanPlus'
    };
    const planEl = $(cardMap[target] || 'vplanPlus');
    if (planEl) {
      planEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      planEl.classList.remove('upgrade-glow');
      void planEl.offsetWidth; // 强制重排，保证连续点击也能重启动画
      planEl.classList.add('upgrade-glow');
      clearTimeout(planEl._glowTimer);
      planEl._glowTimer = setTimeout(() => planEl.classList.remove('upgrade-glow'), 2000);
    }
    // 2. 等待余额加载完成后检测是否弹升级引导窗
    checkUpsellAfterUpgrade(target);
  });
}
window.goUpgrade = goUpgrade;

/* 等待 ezCoinBalance 余额加载完成（switchTab 异步触发 loadMemberCenter）。
   loadMemberCenter 加载完会置 dataset.loaded='1'。最多等 2 秒，超时放弃弹窗。 */
function waitForCoinLoaded(timeout = 2000) {
  return new Promise((resolve) => {
    const node = $('ezCoinBalance');
    if (node && node.dataset.loaded === '1') { resolve(true); return; }
    const start = Date.now();
    const timer = setInterval(() => {
      const n = $('ezCoinBalance');
      if (n && n.dataset.loaded === '1') { clearInterval(timer); resolve(true); return; }
      if (Date.now() - start > timeout) { clearInterval(timer); resolve(false); }
    }, 80);
  });
}

/* 落地后检测：余额达标且本次访问未弹过 → 弹升级引导窗
   "同一次访问"= 当前页面会话（刷新页面算新一次进入）；用内存变量控制，刷新即重置。 */
let _upsellShownThisVisit = false;
async function checkUpsellAfterUpgrade(target) {
  if (_upsellShownThisVisit) return; // 同一次访问最多弹一次
  await waitForCoinLoaded();
  const node = $('ezCoinBalance');
  const coin = Number(node ? node.textContent : 0) || 0;
  const cfg = PLAN_CFG[target];
  if (!cfg) return;
  if (coin < cfg.coinCost) return; // 余额不足，不打扰
  showUpsellModal(target, coin);
}

/* 弹出升级引导窗（文案随 target 动态填充） */
function showUpsellModal(target, coin) {
  const body = $('upsellBody');
  if (!body) return;
  const cfg = PLAN_CFG[target];
  const planName = (typeof LEVEL_NAME !== 'undefined' && LEVEL_NAME[target]) ||
    (target === 'premium' ? '尊享版' : target === 'basic' ? '基础版' : '进阶版');
  body.innerHTML =
    '<p>💡 发现你有 <b>' + coin + '</b><span class="upsell-coin-unit"> 鼎恒币</span>，'
    + '可直接免费兑换' + planName + '月卡（价值¥' + cfg.price + '），是否前往兑换？</p>'
    + '<p class="upsell-tip">无需支付人民币，直接用鼎恒币兑换</p>';
  $('upsellConfirm').dataset.target = target;
  const mask = $('upsellModal');
  mask.classList.add('show');
  _upsellShownThisVisit = true; // 标记本次访问已弹过
  if (!window._upsellEscBound) {
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUpsellModal(); });
    window._upsellEscBound = true;
  }
}

function closeUpsellModal() {
  const mask = $('upsellModal');
  if (mask) mask.classList.remove('show');
}
window.closeUpsellModal = closeUpsellModal;

/* "去兑换"：关闭弹窗 → 平滑滚动到鼎恒币兑换专区对应卡片并高亮 2 秒 */
function goUpsellExchange(target) {
  closeUpsellModal();
  requestAnimationFrame(() => {
    // 各目标对应兑换卡片：采购线 pro→ezProCard、plus→ezBtnPlus；点餐线 premium→ezPremiumCard、advanced→ezBtnAdvanced
    const anchorBtn = { plus: 'ezBtnPlus', pro: 'ezBtnPro', advanced: 'ezBtnAdvanced', premium: 'ezBtnPremium' }[target];
    let el = target === 'premium' ? $('ezPremiumCard')
      : (target === 'pro' ? $('ezProCard')
        : (anchorBtn && $(anchorBtn) ? $(anchorBtn).closest('.ez-card') : null));
    if (!el && $('exchangeZone')) el = $('exchangeZone'); // 兜底回退到兑换专区容器
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('upgrade-glow');
    void el.offsetWidth;
    el.classList.add('upgrade-glow');
    clearTimeout(el._glowTimer);
    el._glowTimer = setTimeout(() => el.classList.remove('upgrade-glow'), 2000);
  });
}
window.goUpsellExchange = goUpsellExchange;

(function () {
  const closeX = $('upsellCloseX');
  if (closeX) closeX.onclick = closeUpsellModal;
  const cancel = $('upsellCancel');
  if (cancel) cancel.onclick = closeUpsellModal; // "再想想"：关闭，停留原位
  const confirm = $('upsellConfirm');
  if (confirm) confirm.onclick = function () { goUpsellExchange(confirm.dataset.target || 'premium'); };
})();

/* 会员卡片"基础版/进阶版全部功能"展开/收起 */
function toggleInherit(btn) {
  const item = btn.closest('.vplan-inherit-item');
  if (item) item.classList.toggle('open');
}
window.toggleInherit = toggleInherit;

/* 鼎恒币兑换月卡"权益详情"展开/收起（默认折叠，与人民币月卡权益一致） */
function toggleEzBenefit(btn) {
  const card = btn.closest('.ez-card');
  if (card) card.classList.toggle('benefit-open');
}
window.toggleEzBenefit = toggleEzBenefit;

/* 移动端侧边栏开关 */
function openSidebar() { $('sidebar').classList.add('open'); $('scrim').classList.add('show'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('scrim').classList.remove('show'); }
$('menuToggle').onclick = openSidebar;
$('scrim').onclick = closeSidebar;

/* ===================== 新手开张引导（开张四步曲） =====================
   菜品 / 装修：后端查库实时判定；预览 / 逛商城：动作上报标记。
   全部完成后自动调用 claim-gift 领取 500 鼎恒币（后端幂等防重），弹庆祝框。
   "不再显示"按店铺记忆在 localStorage。 */
const OB_HIDE_KEY = 'ob_hidden_' + SHOP_ID;
let _obData = null;        // 最近一次后端返回的任务状态
let _obClaiming = false;   // 领奖防并发

const OB_TASKS = [
  {
    key: 'storeInfo', icon: '🏪', text: '完善门店信息', btn: '去完善',
    go() { openStoreInfoModal({ force: true }); }
  },
  {
    key: 'dish', icon: '🍜', text: '上传第一道菜', btn: '去完成',
    go() { switchTab('dishes'); setTimeout(() => { const b = $('addDishBtn'); if (b) b.click(); }, 150); }
  },
  {
    key: 'decorate', icon: '🎨', text: '装修你的店铺', btn: '去完成',
    go() { switchTab('decorate'); }
  },
  {
    key: 'preview', icon: '👀', text: '预览你的点餐页', btn: '去预览',
    go() { openCustomerPreview(); reportOnboardStep('preview'); }
  },
  {
    key: 'mall', icon: '🛒', text: '逛逛采购商城', btn: '去逛逛',
    go() { switchTab('mall'); reportOnboardStep('mall'); }
  }
];

async function loadOnboarding() {
  try {
    const res = await api('/api/admin/onboarding');
    if (!res.success || !res.data) return;
    const prevTasks = _obData ? _obData.tasks : null;
    _obData = res.data;
    renderOnboarding(prevTasks);
    // 门店资料完善引导：新商家未弹过→强制弹窗；老商家已弹过未完善→黄条提醒
    handleStoreInfoStatus(_obData.storeInfo);
    // 全部完成且未发奖：自动领奖（后端幂等，重复调用不会重复发币）
    if (_obData.allDone && !_obData.giftClaimed && !_obClaiming) {
      claimOnboardingGift();
    }
  } catch (e) { /* 引导模块异常不阻塞后台主流程 */ }
}

function renderOnboarding(prevTasks) {
  const card = $('onboardCard');
  if (!card || !_obData) return;
  // 手动"不再显示"或五步全部完成且奖已到账 → 卡片自动消失
  const hidden = localStorage.getItem(OB_HIDE_KEY) === '1';
  const finished = _obData.allDone && _obData.giftClaimed;
  if (hidden || finished) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  // 金色欢迎语：首月赠送进阶版生效期间显示
  const giftLine = $('obGiftLine');
  if (giftLine) giftLine.style.display = (_obData.trial && _obData.trial.active) ? 'block' : 'none';

  const tasks = _obData.tasks || {};
  const doneCount = OB_TASKS.filter(t => tasks[t.key]).length;
  $('obCount').textContent = doneCount + '/' + OB_TASKS.length;

  $('obTaskList').innerHTML = OB_TASKS.map((t, i) => {
    const done = !!tasks[t.key];
    const justDone = done && prevTasks && prevTasks[t.key] === false;
    return `<div class="ob-task ${done ? 'done' : ''} ${justDone ? 'just-done' : ''}" data-i="${i}">
      <span class="ob-check"></span>
      <span class="ob-task-icon">${t.icon}</span>
      <span class="ob-task-text">${t.text}</span>
      <button class="ob-go" type="button" data-go="${i}">${t.btn}</button>
      <span class="ob-done-tag">已完成</span>
    </div>`;
  }).join('');

  // 刚完成项：对勾处飘小礼花
  OB_TASKS.forEach((t, i) => {
    if (tasks[t.key] && prevTasks && prevTasks[t.key] === false) {
      const row = $('obTaskList').querySelector(`.ob-task[data-i="${i}"]`);
      if (row) {
        row.style.position = 'relative';
        const burst = document.createElement('span');
        burst.className = 'ob-burst';
        burst.textContent = '🎉';
        burst.style.left = '4px';
        burst.style.top = '0';
        row.appendChild(burst);
        setTimeout(() => burst.remove(), 1100);
      }
    }
  });

  $('obTaskList').querySelectorAll('.ob-go').forEach(btn => {
    btn.onclick = () => {
      const t = OB_TASKS[Number(btn.dataset.go)];
      if (t) t.go();
    };
  });
}

// 动作上报（preview / mall），已完成则不重复请求
async function reportOnboardStep(step) {
  if (_obData && _obData.tasks && _obData.tasks[step === 'preview' ? 'preview' : 'mall']) return;
  try {
    const res = await api('/api/admin/onboarding/step', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step })
    });
    if (res.success) loadOnboarding();
  } catch (e) { /* 忽略 */ }
}

// 领取 500 鼎恒币开张礼（全部完成后自动调用；后端幂等防重复发放）
async function claimOnboardingGift() {
  if (_obClaiming) return;
  _obClaiming = true;
  try {
    const res = await api('/api/admin/onboarding/claim-gift', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (res.success) {
      if (!res.data.alreadyClaimed) showObCelebrate();
      _obData.giftClaimed = true;
      renderOnboarding(_obData.tasks);
    } else if (res.message && res.message !== 'network') {
      toast(res.message, true);
    }
  } catch (e) { /* 忽略，下次进入会重试 */ } finally {
    _obClaiming = false;
  }
}

function showObCelebrate() {
  const m = $('obCelebrateModal');
  if (m) m.classList.add('show');
}
function closeObCelebrate() {
  const m = $('obCelebrateModal');
  if (m) m.classList.remove('show');
}
$('obHideBtn').onclick = () => {
  localStorage.setItem(OB_HIDE_KEY, '1');
  $('onboardCard').style.display = 'none';
  toast('新手任务已隐藏，祝生意兴隆！');
};
$('obCelebrateOk').onclick = closeObCelebrate;
(function () {
  const m = $('obCelebrateModal');
  if (m) m.addEventListener('click', (e) => { if (e.target === m) closeObCelebrate(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeObCelebrate(); });
})();

/* ===================== 门店资料完善引导弹窗 =====================
   新商家首次登录强制弹窗（不可跳过）；老商家跳过后顶部常驻黄色提醒条。
   弹窗内：地址输入 + 一键定位(navigator.geolocation) + 门头照上传 + 街景照上传。
   （收货方式/期望时段已移至「店铺设置」可选项，默认"按供应商安排"）
   保存走 PUT /api/settings，成功后 POST /api/admin/store-info/complete 标记完成。
   老商家"稍后填写"走 POST /api/admin/store-info/skip 仅标记 firstPrompted。 */
let _siExistingStoreFront = '';
let _siExistingStreetView = '';
let _siForced = false;  // 是否为强制弹窗（新商家不可跳过）

function handleStoreInfoStatus(storeInfo) {
  if (!storeInfo) return;
  if (storeInfo.completed) {
    // 已完善：隐藏黄条与弹窗
    const bar = $('storeInfoBar');
    if (bar) bar.style.display = 'none';
    closeStoreInfoModal();
    return;
  }
  if (!storeInfo.firstPrompted && storeInfo.isNewMerchant) {
    // 新商家首次登录：强制弹窗（不可跳过）
    openStoreInfoModal({ force: true });
  } else if (!storeInfo.firstPrompted) {
    // 老商家首次见到引导：弹窗可跳过（跳过后黄条常驻）
    openStoreInfoModal({ force: false });
  } else {
    // 已跳过未完善：常驻黄条提醒
    const bar = $('storeInfoBar');
    if (bar) bar.style.display = 'flex';
    closeStoreInfoModal();
  }
}

// 打开弹窗：force=true 时隐藏"稍后填写"按钮
async function openStoreInfoModal(opts) {
  opts = opts || {};
  _siForced = !!opts.force;
  const modal = $('storeInfoModal');
  if (!modal) return;
  // 回填已有数据
  try {
    const res = await api('/api/settings');
    const s = res.data || {};
    $('siAddress').value = s.shopAddress || '';
    _siExistingStoreFront = s.storeFrontPhoto || '';
    _siExistingStreetView = s.streetViewPhoto || '';
    if (_siExistingStoreFront) {
      $('siStoreFrontPreview').src = _siExistingStoreFront;
      $('siStoreFrontPreview').style.display = 'block';
    }
    if (_siExistingStreetView) {
      $('siStreetViewPreview').src = _siExistingStreetView;
      $('siStreetViewPreview').style.display = 'block';
    }
    // 定位状态回显
    if (s.shopLongitude != null && s.shopLatitude != null) {
      const hint = $('siLocateHint');
      hint.textContent = '已定位：经度 ' + s.shopLongitude + '，纬度 ' + s.shopLatitude;
      hint.className = 'si-hint success';
      $('siAddress').dataset.lng = s.shopLongitude;
      $('siAddress').dataset.lat = s.shopLatitude;
    }
  } catch (e) { /* 回填失败不阻塞弹窗 */ }
  // 强制模式隐藏"稍后填写"
  $('siSkipBtn').style.display = _siForced ? 'none' : '';
  modal.classList.add('show');
}

function closeStoreInfoModal() {
  const modal = $('storeInfoModal');
  if (modal) modal.classList.remove('show');
}

// 一键定位：调用浏览器 navigator.geolocation
$('siLocateBtn').onclick = function () {
  if (!navigator.geolocation) {
    const hint = $('siLocateHint');
    hint.textContent = '浏览器不支持定位，请手动输入地址';
    hint.className = 'si-hint error';
    return;
  }
  const btn = this;
  btn.classList.add('locating');
  btn.textContent = '📍 定位中…';
  const hint = $('siLocateHint');
  hint.textContent = '正在获取定位…';
  hint.className = 'si-hint';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove('locating');
      btn.textContent = '📍 重新定位';
      const lng = pos.coords.longitude;
      const lat = pos.coords.latitude;
      $('siAddress').dataset.lng = lng;
      $('siAddress').dataset.lat = lat;
      hint.textContent = '已定位：经度 ' + lng.toFixed(6) + '，纬度 ' + lat.toFixed(6);
      hint.className = 'si-hint success';
    },
    (err) => {
      btn.classList.remove('locating');
      btn.textContent = '📍 一键定位';
      const msg = err.code === err.PERMISSION_DENIED
        ? '定位授权被拒绝，可手动输入地址（经纬度留空）'
        : '定位失败，可重试或手动输入地址';
      hint.textContent = msg;
      hint.className = 'si-hint error';
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
};

// 图片选择后即时预览
$('siStoreFront').onchange = function () {
  const f = this.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = (e) => {
    $('siStoreFrontPreview').src = e.target.result;
    $('siStoreFrontPreview').style.display = 'block';
  }; r.readAsDataURL(f);
};
$('siStreetView').onchange = function () {
  const f = this.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = (e) => {
    $('siStreetViewPreview').src = e.target.result;
    $('siStreetViewPreview').style.display = 'block';
  }; r.readAsDataURL(f);
};

// 保存并完成
$('siSaveBtn').onclick = async function () {
  const address = $('siAddress').value.trim();
  const lng = parseFloat($('siAddress').dataset.lng);
  const lat = parseFloat($('siAddress').dataset.lat);

  if (!address) { toast('请填写门店地址', true); return; }

  const btn = this;
  btn.classList.add('loading');
  btn.textContent = '保存中…';
  try {
    // 上传门头照（必传）
    let storeFrontUrl = _siExistingStoreFront;
    const sfFile = $('siStoreFront').files[0];
    if (sfFile) {
      const fd = new FormData(); fd.append('file', sfFile);
      const u = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + MERCHANT_TOKEN, 'x-shop-id': SHOP_ID },
        body: fd
      }).then(r => r.json());
      if (!u.success) { toast(u.message || '门头照上传失败', true); return; }
      storeFrontUrl = u.data.url;
    }
    if (!storeFrontUrl) { toast('请上传门头照', true); return; }

    // 上传街景照（选传）
    let streetViewUrl = _siExistingStreetView;
    const svFile = $('siStreetView').files[0];
    if (svFile) {
      const fd = new FormData(); fd.append('file', svFile);
      const u = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + MERCHANT_TOKEN, 'x-shop-id': SHOP_ID },
        body: fd
      }).then(r => r.json());
      if (!u.success) { toast(u.message || '街景照上传失败', true); return; }
      streetViewUrl = u.data.url;
    }

    // 保存到 Setting（经纬度选填：手动输入未定位时为 null）
    const body = {
      shopAddress: address, storeFrontPhoto: storeFrontUrl, streetViewPhoto: streetViewUrl
    };
    if (lng && lat) { body.shopLongitude = lng; body.shopLatitude = lat; }
    const res = await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.success) { toast(res.message || '保存失败', true); return; }
    // 标记门店资料已完善
    const c = await api('/api/admin/store-info/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (c.success) {
      toast('门店资料已完善');
      closeStoreInfoModal();
      $('storeInfoBar').style.display = 'none';
      loadOnboarding();  // 刷新新手任务状态
    } else {
      toast(c.message || '标记完成失败，资料已保存', true);
    }
  } catch (e) {
    toast('网络错误', true);
  } finally {
    btn.classList.remove('loading');
    btn.textContent = '保存并完成';
  }
};

// 稍后填写（仅老商家可跳过）
$('siSkipBtn').onclick = async function () {
  if (_siForced) return;  // 强制模式不可跳过
  try {
    const res = await api('/api/admin/store-info/skip', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (res.success) {
      closeStoreInfoModal();
      $('storeInfoBar').style.display = 'flex';
      toast('可稍后在「店铺设置」中补全');
    }
  } catch (e) { /* 忽略 */ }
};

// 黄色提醒条按钮
$('sibCompleteBtn').onclick = () => openStoreInfoModal({ force: false });
$('sibHideBtn').onclick = () => { $('storeInfoBar').style.display = 'none'; };

/* ===================== 菜单管理 ===================== */
async function loadCategories() {
  const res = await api('/api/categories');
  categories = res.data || [];
  return categories;
}

// 菜单管理：低库存菜品提醒（缺货即补货触点；无配方/库存数据时隐藏，不打扰）
async function loadLowStockBanner() {
  const banner = $('lowStockBanner');
  if (!banner) return;
  try {
    const res = await api('/api/admin/low-stock-dishes?limit=6');
    const d = (res && res.success && res.data) || {};
    if (!d.hasBom || !(d.items || []).length) { banner.style.display = 'none'; return; }
    const urgent = (d.items || []).filter(x => x.portionsLeft <= 5);
    const items = urgent.length ? urgent : d.items.slice(0, 3);
    banner.style.display = 'block';
    const sub = $('lowStockSub');
    if (sub) sub.textContent = `${items.length} 道菜即将售罄`;
    const body = $('lowStockBody');
    if (body) {
      body.innerHTML = items.map(x => `
        <div style="padding:8px 12px;border:1px solid #fde68a;background:#fffbeb;border-radius:10px;font-size:13px;">
          <b>${esc(x.dishName)}</b> 仅可做 <b style="color:#d97706;">${x.portionsLeft}</b> 份
          <div style="color:#9ca3af;font-size:12px;margin-top:2px;">瓶颈：${esc(x.bottleneck.name)}（库存 ${esc(String(x.bottleneck.have))}）</div>
        </div>`).join('') +
        `<button class="btn-add" type="button" style="align-self:center;" onclick="switchTab('mall')">去采购商城补货</button>`;
    }
  } catch (e) {
    banner.style.display = 'none';
  }
}

async function loadDishes() {
  const res = await api('/api/dishes');
  const body = $('dishesBody');
  const cardsBox = $('dishesCards');
  const dishes = res.data || [];
  // 新手任务：菜品数量实时影响"上传第一道菜"状态
  try { loadOnboarding(); } catch (e) {}
  if (!dishes.length) {
    if (body) body.innerHTML = `<tr><td colspan="5" class="empty">暂无菜品，点击右上角“新增菜品”添加</td></tr>`;
    if (cardsBox) cardsBox.innerHTML = `<div class="empty" style="padding:40px 16px;text-align:center;color:#9ca3af;">暂无菜品，点击右上角“新增菜品”添加</div>`;
    return;
  }
  // 电脑端表格行
  if (body) {
    body.innerHTML = dishes.map(d => `
      <tr>
        <td>
          <div class="name-cell">
            ${d.image ? `<img class="dish-thumb" src="${esc(d.image)}" alt="" onerror="this.outerHTML='<span class=&quot;thumb-ph&quot;>🍜</span>'">` : `<span class="thumb-ph">🍜</span>`}
            <div>
              <div class="nm">${esc(d.name)}</div>
              <div class="desc">${esc(d.description || '—')}</div>
            </div>
          </div>
        </td>
        <td>¥${Number(d.price).toFixed(2)}</td>
        <td>${esc(d.category)}</td>
        <td><span class="badge ${d.isAvailable ? 'b-green' : 'b-gray'}">${d.isAvailable ? '上架' : '下架'}</span></td>
        <td>
          <div class="row-actions">
            <button class="btn btn-green" data-act="bom" data-dish="${esc(d.name)}">配方</button>
            <button class="btn btn-blue" data-act="edit" data-id="${esc(d._id)}">编辑</button>
            <button class="btn ${d.isAvailable ? 'btn-gray' : 'btn-orange'}" data-act="toggle" data-id="${esc(d._id)}" data-avail="${d.isAvailable ? 0 : 1}">${d.isAvailable ? '下架' : '上架'}</button>
            <button class="btn btn-red" data-act="del" data-id="${esc(d._id)}">删除</button>
          </div>
        </td>
      </tr>
    `).join('');
    body.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.act, id = btn.dataset.id;
        if (act === 'edit') openDishModal(id);
        else if (act === 'del') deleteDish(id);
        else if (act === 'toggle') toggleDish(id, btn.dataset.avail === '1');
        else if (act === 'bom') openBomModal(btn.dataset.dish);
      };
    });
  }
  // 手机端卡片
  if (cardsBox) {
    cardsBox.innerHTML = dishes.map(d => `
      <div class="dish-card-m">
        <div class="dcm-top">
          ${d.image ? `<img class="dcm-img" src="${esc(d.image)}" alt="" onerror="this.outerHTML='<span class=&quot;dcm-ph&quot;>🍜</span>'">` : `<span class="dcm-ph">🍜</span>`}
          <div class="dcm-info">
            <div class="dcm-name">${esc(d.name)}</div>
            ${d.description ? `<div class="dcm-desc">${esc(d.description)}</div>` : ''}
            <div class="dcm-meta">
              <span class="dcm-price">¥${Number(d.price).toFixed(2)}</span>
              <span class="dcm-cat">${esc(d.category)}</span>
              <span class="badge ${d.isAvailable ? 'b-green' : 'b-gray'} dcm-status">${d.isAvailable ? '上架' : '下架'}</span>
            </div>
          </div>
        </div>
        <div class="dcm-actions">
          <button class="btn btn-green" data-act="bom" data-dish="${esc(d.name)}">配方</button>
          <button class="btn btn-blue" data-act="edit" data-id="${esc(d._id)}">编辑</button>
          <button class="btn ${d.isAvailable ? 'btn-gray' : 'btn-orange'}" data-act="toggle" data-id="${esc(d._id)}" data-avail="${d.isAvailable ? 0 : 1}">${d.isAvailable ? '下架' : '上架'}</button>
          <button class="btn btn-red" data-act="del" data-id="${esc(d._id)}">删除</button>
        </div>
      </div>
    `).join('');
    cardsBox.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.act, id = btn.dataset.id;
        if (act === 'edit') openDishModal(id);
        else if (act === 'del') deleteDish(id);
        else if (act === 'toggle') toggleDish(id, btn.dataset.avail === '1');
        else if (act === 'bom') openBomModal(btn.dataset.dish);
      };
    });
  }
}

async function openDishModal(id) {
  await loadCategories();
  const sel = $('dishCategory');
  sel.innerHTML = categories.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('') || `<option value="默认">默认</option>`;

  if (id) {
    $('dishModalTitle').textContent = '编辑菜品';
    const res = await api('/api/dishes');
    const d = (res.data || []).find(x => x._id === id);
    if (!d) { toast('菜品不存在', true); return; }
    // 若菜品分类不在分类列表中，补一个选项，避免保存时被覆盖
    if (d.category && ![...sel.options].some(o => o.value === d.category)) {
      const opt = document.createElement('option');
      opt.value = d.category; opt.textContent = d.category;
      sel.appendChild(opt);
    }
    $('dishId').value = d._id;
    $('dishName').value = d.name || '';
    $('dishPrice').value = d.price ?? '';
    $('dishImage').value = d.image || '';
    $('dishDesc').value = d.description || '';
    sel.value = d.category;
    updateDishImgPreview();
  } else {
    $('dishModalTitle').textContent = '新增菜品';
    $('dishId').value = '';
    $('dishName').value = '';
    $('dishPrice').value = '';
    $('dishImage').value = '';
    $('dishDesc').value = '';
    updateDishImgPreview();
  }
  $('dishModal').classList.add('show');
  setTimeout(() => $('dishName').focus(), 50);
}

$('addDishBtn').onclick = () => openDishModal(null);
$('dishCloseBtn').onclick = closeDishModal;
$('dishCancelBtn').onclick = closeDishModal;
function closeDishModal() { $('dishModal').classList.remove('show'); }
$('dishModal').addEventListener('click', (e) => { if (e.target.id === 'dishModal') closeDishModal(); });

/* ---------- 菜品食材配方（BOM）管理 ---------- */
let _bomDishName = '';
let _bomItems = [];
let _bomAllProducts = [];

async function openBomModal(dishName) {
  if (!dishName) { toast('菜品名缺失', true); return; }
  _bomDishName = dishName;
  _bomItems = [];
  $('bomDishName').value = dishName;
  $('bomDishLabel').textContent = dishName;
  $('bomProductQty').value = '';

  // 加载供应商品列表（供选择食材）
  try {
    const res = await api('/api/supply-products?status=上架');
    _bomAllProducts = (res.data || []).filter(p => p && p.name);
  } catch (e) {
    _bomAllProducts = [];
  }
  renderBomProductSelect();

  // 加载该菜品已有配方
  try {
    const res = await api('/api/admin/bom');
    const list = res.data || [];
    const existing = list.find(b => b.dishName === dishName);
    if (existing && existing.items) {
      _bomItems = existing.items.map(it => ({
        productId: it.productId && it.productId._id ? it.productId._id : it.productId,
        quantity: it.quantity,
        name: it.productId && it.productId.name ? it.productId.name : '食材',
        unit: it.productId && it.productId.unit ? it.productId.unit : ''
      }));
    }
  } catch (e) {
    _bomItems = [];
  }
  renderBomItems();
  $('bomModal').classList.add('show');
}

function renderBomProductSelect() {
  const sel = $('bomProductSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">选择食材…</option>' +
    _bomAllProducts.map(p => `<option value="${esc(p._id)}" data-name="${esc(p.name)}" data-unit="${esc(p.unit || '-')}">${esc(p.name)}（${esc(p.unit || '-')}）</option>`).join('');
}

function renderBomItems() {
  const box = $('bomItemsList');
  if (!box) return;
  if (!_bomItems.length) {
    box.innerHTML = '<div style="color:#999;font-size:13px;padding:8px 0;">暂无食材，请在下方选择食材并添加</div>';
    return;
  }
  box.innerHTML = _bomItems.map((it, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed #eee;">
      <span style="flex:1;font-size:13px;">${esc(it.name || '食材')}</span>
      <input type="number" class="form-input" style="width:100px;" value="${it.quantity}" min="0" step="0.01" data-bom-idx="${i}">
      <button class="btn btn-red" type="button" data-bom-del="${i}" style="flex:0 0 auto;">删</button>
    </div>`).join('');
  box.querySelectorAll('input[data-bom-idx]').forEach(inp => {
    inp.oninput = () => { _bomItems[Number(inp.dataset.bomIdx)].quantity = Number(inp.value) || 0; };
  });
  box.querySelectorAll('button[data-bom-del]').forEach(btn => {
    btn.onclick = () => { _bomItems.splice(Number(btn.dataset.bomDel), 1); renderBomItems(); };
  });
}

function bomAddItem() {
  const sel = $('bomProductSelect');
  const qtyEl = $('bomProductQty');
  const productId = sel.value;
  const qty = Number(qtyEl.value);
  if (!productId) { toast('请选择食材', true); return; }
  if (!(qty > 0)) { toast('请填写用量', true); return; }
  const opt = sel.options[sel.selectedIndex];
  const name = opt.dataset.name || '食材';
  const unit = opt.dataset.unit || '';
  _bomItems.push({ productId, quantity: qty, name, unit });
  qtyEl.value = '';
  sel.value = '';
  renderBomItems();
}

async function saveBom() {
  if (!_bomDishName) return;
  if (!_bomItems.length) { toast('请至少添加一个食材', true); return; }
  const items = _bomItems.map(it => ({ productId: it.productId, quantity: it.quantity }));
  const res = await api('/api/admin/bom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dishName: _bomDishName, items })
  });
  if (res.success) {
    toast('配方已保存');
    closeBomModal();
  } else {
    toast(res.message || '保存失败', true);
  }
}

function closeBomModal() { $('bomModal').classList.remove('show'); }

$('bomCloseBtn').onclick = closeBomModal;
$('bomCancelBtn').onclick = closeBomModal;
$('bomSaveBtn').onclick = saveBom;
$('bomAddItemBtn').onclick = bomAddItem;
$('bomModal').addEventListener('click', (e) => { if (e.target.id === 'bomModal') closeBomModal(); });

/* ---------- 菜品图片上传（前端压缩到 2MB 内后上传） ---------- */
function updateDishImgPreview() {
  const url = $('dishImage').value.trim();
  const img = $('dishImgPreview');
  const empty = $('dishImgEmpty');
  if (url) {
    img.src = url; img.style.display = 'block'; empty.style.display = 'none';
  } else {
    img.removeAttribute('src'); img.style.display = 'none'; empty.style.display = 'flex';
  }
}

// 压缩图片：最长边 800px，JPEG 质量 0.82；若仍超 2MB 则逐步降低质量
function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!['image/jpeg', 'image/png'].includes(file.type)) { reject(new Error('仅支持 jpg/png 格式')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 800;
        let width = img.width, height = img.height;
        if (width > MAX || height > MAX) {
          const r = Math.min(MAX / width, MAX / height);
          width = Math.round(width * r);
          height = Math.round(height * r);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        let quality = 0.82;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length * 0.75 > 2 * 1024 * 1024 && quality > 0.4) {
          quality -= 0.12;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

async function uploadDishImage(file) {
  try {
    toast('图片处理中...');
    const dataUrl = await compressImage(file);
    // dataURL 转 Blob 后以 multipart/form-data 上传
    const blob = await (await fetch(dataUrl)).blob();
    const fd = new FormData();
    fd.append('file', blob, `dish_${Date.now()}.jpg`);
    const res = await api('/api/admin/upload', { method: 'POST', body: fd });
    if (res.success && res.data && res.data.url) {
      $('dishImage').value = res.data.url;
      updateDishImgPreview();
      toast('图片已上传');
    } else {
      toast(res.message || '上传失败', true);
    }
  } catch (e) {
    toast(e.message || '上传失败', true);
  }
}

$('imgUploadBox').onclick = () => $('dishImgFile').click();
$('dishImgPickBtn').onclick = () => $('dishImgFile').click();
$('dishImgRemoveBtn').onclick = () => { $('dishImage').value = ''; updateDishImgPreview(); };
$('dishImgFile').onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) uploadDishImage(f);
  e.target.value = ''; // 允许重复选择同一文件
};

$('dishSaveBtn').onclick = async () => {
  const id = $('dishId').value;
  const body = {
    name: $('dishName').value.trim(),
    price: parseFloat($('dishPrice').value) || 0,
    category: $('dishCategory').value,
    image: $('dishImage').value.trim(),
    description: $('dishDesc').value.trim()
  };
  if (!body.name) { toast('请输入菜品名称', true); return; }
  if (!body.category) { toast('请选择分类', true); return; }

  const opts = { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const url = id ? `/api/admin/dishes/${id}` : '/api/admin/dishes';
  const res = await api(url, opts);
  if (res.success) {
    toast(id ? '已更新' : '已新增');
    closeDishModal();
    loadDishes();
  } else {
    toast(res.message || '保存失败', true);
  }
};

async function toggleDish(id, makeAvailable) {
  const res = await api(`/api/admin/dishes/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isAvailable: makeAvailable })
  });
  if (res.success) { toast(makeAvailable ? '已上架' : '已下架'); loadDishes(); }
  else toast(res.message || '操作失败', true);
}

async function deleteDish(id) {
  if (!confirm('确定删除该菜品？此操作不可恢复。')) return;
  const res = await api(`/api/admin/dishes/${id}`, { method: 'DELETE' });
  if (res.success) { toast('已删除'); loadDishes(); }
  else toast(res.message || '删除失败', true);
}

/* ===================== 桌台管理 ===================== */
async function loadTables() {
  const res = await api('/api/admin/tables');
  const list = $('tablesList');
  const tables = res.data || [];
  if (!tables.length) {
    list.innerHTML = `<div class="empty" style="grid-column:1/-1;">暂无桌台，请在上方添加</div>`;
    return;
  }
  list.innerHTML = tables.map(t => `
    <div class="table-cell ${t.status === 'occupied' ? 'occupied' : 'idle'}">
      <div class="del" data-id="${esc(t._id)}" title="删除">×</div>
      <div class="num">${esc(t.number)}</div>
      <span class="badge ${t.status === 'occupied' ? 'b-red' : 'b-green'}">${t.status === 'occupied' ? '占用' : '空闲'}</span>
    </div>
  `).join('');

  list.querySelectorAll('.del').forEach(b => b.onclick = async () => {
    if (!confirm('确定删除该桌台？')) return;
    const r = await api(`/api/admin/tables/${b.dataset.id}`, { method: 'DELETE' });
    if (r.success) { toast('已删除'); loadTables(); }
    else toast(r.message || '删除失败', true);
  });
}

$('addTableBtn').onclick = async () => {
  const num = $('newTableInput').value.trim();
  if (!num) { toast('请输入桌号', true); return; }
  const res = await api('/api/admin/tables', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: num })
  });
  if (res.success) { toast('已添加'); $('newTableInput').value = ''; loadTables(); }
  else toast(res.message || '添加失败', true);
};
$('newTableInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addTableBtn').click(); });

/* ===================== 订单管理 ===================== */
async function loadOrders() {
  const res = await api('/api/orders'); // 不传 status，返回全部，后端已按 createdAt 倒序
  const list = $('ordersList');
  const orders = res.data || [];
  if (!orders.length) {
    list.innerHTML = `<div class="empty">暂无订单</div>`;
    return;
  }
  list.innerHTML = orders.map(o => {
    const pending = o.status === 'pending';
    const itemsTxt = (o.items || []).map(i => `${esc(i.dishName)}×${i.quantity}`).join('，');
    return `
      <div class="order-row ${pending ? 'pending' : 'completed'}">
        <div class="o-main">
          <div class="o-table">桌号 ${esc(o.tableNumber)}</div>
          <div class="o-items">${itemsTxt || '—'}</div>
          <div class="o-time">${fmtTime(o.createdAt)}</div>
        </div>
        <div class="o-right">
          <div class="o-total">¥${Number(o.totalPrice).toFixed(2)}</div>
          ${pending
            ? `<span class="badge b-red">待处理</span><button class="btn btn-orange" data-id="${esc(o._id)}">完成</button>`
            : `<span class="badge b-green">已完成</span>`}
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
    const r = await api(`/api/orders/${b.dataset.id}/complete`, { method: 'PUT' });
    if (r.success) { toast('已标记完成'); loadOrders(); }
    else toast(r.message || '操作失败', true);
  });
}

/* ===================== 数据统计 ===================== */
async function loadStats() {
  const res = await api('/api/orders');
  const orders = res.data || [];

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let todayCount = 0;
  let todayRevenue = 0;
  let monthRevenue = 0;

  orders.forEach(o => {
    const t = new Date(o.createdAt).getTime();
    if (t >= startToday) {
      todayCount += 1;
      if (o.status === 'completed') todayRevenue += Number(o.totalPrice) || 0;
    }
    if (t >= startMonth && o.status === 'completed') {
      monthRevenue += Number(o.totalPrice) || 0;
    }
  });

  $('statTodayCount').innerHTML = `${todayCount}<small> 单</small>`;
  $('statTodayRevenue').textContent = todayRevenue.toFixed(2);
  $('statMonthRevenue').textContent = monthRevenue.toFixed(2);

  // 经营报表 / 顾客画像 / 损耗分析（按会员等级逐块鉴权）
  loadReports();
}

/* ===================== 经营报表 / 顾客画像 / 损耗分析 ===================== */
let _rptDays = 7;

// 权限不足时渲染锁定卡（引导升级）
function renderReportLock(container, res) {
  const levels = Array.isArray(res.needLevel) && res.needLevel.length ? res.needLevel : ['advanced'];
  const needText = levels.map(l => LEVEL_NAME[l] || l).join(' / ');
  container.innerHTML = `<div class="rpt-lock">
    <div style="font-size:32px;">🔒</div>
    <p>${esc(res.message || '升级会员解锁此功能')}（需 ${esc(needText)}）</p>
    <button onclick="goUpgrade('${esc(levels[0])}')">去升级解锁</button>
  </div>`;
}

async function loadReports() {
  await Promise.all([
    loadReportOverview(_rptDays),
    loadReportCustomers(_rptDays),
    loadReportCost(_rptDays)
  ]);
}

async function loadReportOverview(days) {
  const box = $('rptOverviewBody');
  box.innerHTML = '<div class="rpt-empty">加载中...</div>';
  const res = await api(`/api/admin/reports/overview?days=${days}`);
  if (!res.success) { renderReportLock(box, res); return; }
  const d = res.data || {};
  const list = d.byDay || [];
  const maxRev = Math.max(1, ...list.map(x => x.revenue));
  const bars = list.map(x => {
    const h = Math.round(x.revenue / maxRev * 96);
    return `<div class="rpt-bar-col" title="${esc(x.date)} ¥${Number(x.revenue).toFixed(2)} · ${x.count} 单">
      <div class="rpt-bar" style="height:${Math.max(h, 2)}px;"></div>
      <div class="rpt-bar-x">${esc(String(x.date).slice(5))}</div>
    </div>`;
  }).join('');
  const dishRows = (d.topDishes || []).length
    ? d.topDishes.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}</td><td>${x.qty}</td><td>¥${Number(x.revenue).toFixed(2)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="rpt-empty">暂无数据</td></tr>';
  const catRows = (d.categoryMix || []).length
    ? d.categoryMix.map(x => `<tr><td>${esc(x.category)}</td><td>${x.qty}</td><td>¥${Number(x.revenue).toFixed(2)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="rpt-empty">暂无数据</td></tr>';
  box.innerHTML = `
    <div class="rpt-kpis">
      <div class="rpt-kpi"><div class="k">营业额</div><div class="v">¥${Number(d.revenueTotal || 0).toFixed(2)}</div></div>
      <div class="rpt-kpi"><div class="k">订单数</div><div class="v">${d.orderCount || 0}</div></div>
      <div class="rpt-kpi"><div class="k">客单价</div><div class="v">¥${Number(d.avgTicket || 0).toFixed(2)}</div></div>
    </div>
    <div style="font-size:12px;color:#9ca3af;margin:4px 0 2px;">每日营业额趋势</div>
    <div class="rpt-bars">${bars}</div>
    <div class="rpt-two" style="margin-top:16px;">
      <div>
        <div style="font-size:12px;color:#9ca3af;margin-bottom:6px;">热销菜品 TOP10</div>
        <table class="rpt-table"><thead><tr><th>#</th><th>菜品</th><th>销量</th><th>金额</th></tr></thead><tbody>${dishRows}</tbody></table>
      </div>
      <div>
        <div style="font-size:12px;color:#9ca3af;margin-bottom:6px;">分类销售占比</div>
        <table class="rpt-table"><thead><tr><th>分类</th><th>销量</th><th>金额</th></tr></thead><tbody>${catRows}</tbody></table>
      </div>
    </div>`;
}

async function loadReportCustomers(days) {
  const box = $('rptCustomersBody');
  box.innerHTML = '<div class="rpt-empty">加载中...</div>';
  const res = await api(`/api/admin/reports/customers?days=${days}`);
  if (!res.success) { renderReportLock(box, res); return; }
  const d = res.data || {};
  if (!d.totalCustomers) {
    box.innerHTML = '<div class="rpt-empty">该区间暂无带手机号的订单数据</div>';
    return;
  }
  const rows = (d.top || []).map(c => `<tr>
    <td>${esc(c.masked)}</td><td>${c.count}</td><td>¥${Number(c.amount).toFixed(2)}</td>
    <td>¥${Number(c.avg).toFixed(2)}</td><td>${c.lastAt ? fmtTime(c.lastAt).slice(0, 10) : '—'}</td>
  </tr>`).join('');
  box.innerHTML = `
    <div class="rpt-kpis">
      <div class="rpt-kpi"><div class="k">消费顾客数</div><div class="v">${d.totalCustomers}</div></div>
      <div class="rpt-kpi"><div class="k">回头客（≥2 次）</div><div class="v">${d.repeatCustomers}</div></div>
      <div class="rpt-kpi"><div class="k">回头率</div><div class="v">${d.repeatRate}%</div></div>
    </div>
    <div style="font-size:12px;color:#9ca3af;margin-bottom:6px;">消费 TOP20 顾客（手机号脱敏）</div>
    <table class="rpt-table"><thead><tr><th>手机号</th><th>消费次数</th><th>累计金额</th><th>客单价</th><th>最近消费</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function loadReportCost(days) {
  const box = $('rptCostBody');
  box.innerHTML = '<div class="rpt-empty">加载中...</div>';
  const res = await api(`/api/admin/reports/cost?days=${days}`);
  if (!res.success) { renderReportLock(box, res); return; }
  const d = res.data || {};
  const rows = (d.purchaseByCategory || []).length
    ? d.purchaseByCategory.map(x => `<tr><td>${esc(x.category)}</td><td>¥${Number(x.amount).toFixed(2)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="rpt-empty">暂无采购数据</td></tr>';
  box.innerHTML = `
    <div class="rpt-kpis">
      <div class="rpt-kpi"><div class="k">采购投入</div><div class="v">¥${Number(d.purchaseAmount || 0).toFixed(2)}</div></div>
      <div class="rpt-kpi"><div class="k">点餐营收</div><div class="v">¥${Number(d.salesRevenue || 0).toFixed(2)}</div></div>
      <div class="rpt-kpi"><div class="k">成本占比</div><div class="v">${d.costRatio == null ? '—' : d.costRatio + '%'}</div></div>
    </div>
    <div style="font-size:12px;color:#9ca3af;margin-bottom:6px;">采购品类结构</div>
    <table class="rpt-table"><thead><tr><th>品类</th><th>采购金额</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// 区间切换与刷新
document.querySelectorAll('#rptRange .rpt-chip').forEach(chip => {
  chip.onclick = () => {
    _rptDays = parseInt(chip.dataset.days, 10) || 7;
    document.querySelectorAll('#rptRange .rpt-chip').forEach(c => c.classList.toggle('active', c === chip));
    loadReports();
  };
});
$('rptRefreshBtn').onclick = loadReports;

/* ===================== 顾客储值 ===================== */
let _svAccounts = [];

// 顶部提示：当前生效的「充值送」活动
async function loadSvBonusTip() {
  try {
    const res = await api('/api/marketing');
    const now = Date.now();
    const active = (res.data || []).filter(m =>
      m.type === 'rechargeBonus' && m.enabled &&
      (!m.startTime || new Date(m.startTime) <= now) &&
      (!m.endTime || new Date(m.endTime) >= now)
    );
    const tip = $('svBonusTip');
    if (active.length) {
      tip.style.display = 'block';
      tip.textContent = '当前充值送：' + active.map(m => `充 ¥${m.recharge} 送 ¥${m.bonus}`).join('；') + '（充值命中时自动入账）';
    } else {
      tip.style.display = 'none';
    }
  } catch (e) { /* 忽略 */ }
}

async function loadStoredValue() {
  const tbody = $('svTbody');
  tbody.innerHTML = '<tr><td colspan="7" class="sv-empty">加载中...</td></tr>';
  loadSvBonusTip();
  const kw = $('svSearch').value.trim();
  const res = await api('/api/stored-value/accounts' + (kw ? '?keyword=' + encodeURIComponent(kw) : ''));
  if (!res.success) {
    tbody.innerHTML = `<tr><td colspan="7" class="sv-empty">加载失败：${esc(res.message || '未知错误')}</td></tr>`;
    return;
  }
  _svAccounts = res.data || [];
  $('svTotalBalance').innerHTML = `账户合计余额 <b>¥${Number(res.totalBalance || 0).toFixed(2)}</b>`;
  if (!_svAccounts.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="sv-empty">暂无储值账户，先在上方登记充值</td></tr>';
    return;
  }
  tbody.innerHTML = _svAccounts.map(a => `<tr>
    <td>${esc(a.phone)}</td>
    <td>${esc(a.customerName || '—')}</td>
    <td style="font-weight:700;color:#059669;">¥${Number(a.balance || 0).toFixed(2)}</td>
    <td>¥${Number(a.totalRecharged || 0).toFixed(2)}</td>
    <td>¥${Number(a.totalBonus || 0).toFixed(2)}</td>
    <td>${fmtTime(a.updatedAt)}</td>
    <td><button class="btn-ghost" data-phone="${esc(a.phone)}">查看流水</button></td>
  </tr>`).join('');
  tbody.querySelectorAll('button[data-phone]').forEach(b => {
    b.onclick = () => showStoredValueHistory(b.dataset.phone);
  });
}

async function submitStoredValueRecharge() {
  const phone = $('svPhone').value.trim();
  const amount = parseFloat($('svAmount').value);
  const customerName = $('svName').value.trim();
  if (!/^1\d{10}$/.test(phone)) { toast('请输入正确的 11 位手机号', true); $('svPhone').focus(); return; }
  if (!(amount > 0)) { toast('请输入大于 0 的充值金额', true); $('svAmount').focus(); return; }

  const btn = $('svRechargeBtn');
  btn.disabled = true;
  btn.textContent = '入账中...';
  const res = await api('/api/stored-value/recharge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, amount, customerName })
  });
  btn.disabled = false;
  btn.textContent = '确认充值入账';
  if (res.success) {
    toast(res.message || '充值成功');
    $('svPhone').value = '';
    $('svName').value = '';
    $('svAmount').value = '';
    loadStoredValue();
  } else {
    toast(res.message || '充值失败', true);
  }
}

async function showStoredValueHistory(phone) {
  $('svHistoryModal').classList.add('show');
  const box = $('svHistoryBody');
  box.innerHTML = '<div class="cb-tip" style="text-align:center;">加载中...</div>';
  const res = await api('/api/stored-value/accounts/' + encodeURIComponent(phone) + '/history');
  if (!res.success) {
    box.innerHTML = `<div class="cb-tip" style="text-align:center;">加载失败：${esc(res.message || '未知错误')}</div>`;
    return;
  }
  const d = res.data || {};
  const TYPE = { recharge: '充值', bonus: '赠送', consume: '消费' };
  const rows = (d.history || []).map(h => `<div class="cb-order-item">
    <div class="cb-order-head">
      <span class="cb-order-no">${TYPE[h.type] || esc(h.type)}</span>
      <span style="font-weight:700;color:${Number(h.amount) >= 0 ? '#059669' : '#dc2626'};">${Number(h.amount) >= 0 ? '+' : ''}${Number(h.amount).toFixed(2)}</span>
    </div>
    <div class="cb-order-meta"><span>${esc(h.note || '')}</span><span>余额 ¥${Number(h.balance).toFixed(2)}</span></div>
    <div class="cb-order-meta"><span>${fmtTime(h.time)}</span></div>
  </div>`).join('');
  box.innerHTML = `<div style="font-size:13px;color:#6b7280;margin-bottom:8px;">${esc(d.phone)}${d.customerName ? ' · ' + esc(d.customerName) : ''} · 当前余额 <b style="color:var(--accent);">¥${Number(d.balance).toFixed(2)}</b></div>`
    + (rows || '<div class="cb-tip" style="text-align:center;">暂无流水</div>');
}

function closeSvHistory() { $('svHistoryModal').classList.remove('show'); }

$('svRechargeBtn').onclick = submitStoredValueRecharge;
$('svSearchBtn').onclick = loadStoredValue;
$('svSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadStoredValue(); });
window.closeSvHistory = closeSvHistory;

/* ===================== 店铺设置 ===================== */
// 控制"打印机"和"微信通知"子字段显示/隐藏
function bindSettingsToggles() {
  const printerChk = $('setEnablePrinter');
  const wechatChk = $('setEnableWechat');
  const printerFields = $('printerFields');
  const wechatFields = $('wechatFields');
  if (printerChk) printerChk.onchange = () => printerFields.classList.toggle('show', printerChk.checked);
  if (wechatChk) wechatChk.onchange = () => wechatFields.classList.toggle('show', wechatChk.checked);
}

async function loadSettings() {
  const res = await api('/api/settings');
  const s = res.data;
  if (!s) return;
  $('setShopName').value = s.shopName || '';
  $('setEnableVoice').checked = !!s.enableVoice;
  $('setEnableBigscreen').checked = !!s.enableBigscreen;
  $('setEnablePrinter').checked = !!s.enablePrinter;
  $('setEnableWechat').checked = !!s.enableWechat;
  $('setPrinterSN').value = s.printerSN || '';
  $('setPrinterKey').value = s.printerKey || '';
  $('setNotifyPhone').value = s.notifyPhone || '';
  $('setPrinterApiUrl').value = s.printerApiUrl || '';
  $('setNotifyWebhookUrl').value = s.notifyWebhookUrl || '';
  $('setSmsApiUrl').value = s.smsApiUrl || '';
  $('setSmsApiKey').value = s.smsApiKey || '';
  $('setVoiceApiUrl').value = s.voiceApiUrl || '';
  $('setVoiceApiKey').value = s.voiceApiKey || '';
  $('setWechatApiUrl').value = s.wechatApiUrl || '';
  $('setWechatApiKey').value = s.wechatApiKey || '';
  $('setWechatTemplateId').value = s.wechatTemplateId || '';
  $('setWechatToUser').value = s.wechatToUser || '';
  $('printerFields').classList.toggle('show', !!s.enablePrinter);
  $('wechatFields').classList.toggle('show', !!s.enableWechat);
  // 门店定位与收货
  $('setShopLng').value = s.shopLongitude ?? '';
  $('setShopLat').value = s.shopLatitude ?? '';
  $('setShopAddr').value = s.shopAddress || '';
  $('setReceiveMethod').value = s.receiveMethod || 'supplier_arranged';
  $('setRecvStart').value = s.expectedReceiveStart || '';
  $('setRecvEnd').value = s.expectedReceiveEnd || '';
  if (s.storeFrontPhoto) { $('storeFrontPreview').src = s.storeFrontPhoto; $('storeFrontPreview').style.display = 'block'; }
  else { $('storeFrontPreview').style.display = 'none'; }
  if (s.streetViewPhoto) { $('streetViewPreview').src = s.streetViewPhoto; $('streetViewPreview').style.display = 'block'; }
  else { $('streetViewPreview').style.display = 'none'; }
  _existingStoreFront = s.storeFrontPhoto || '';
  _existingStreetView = s.streetViewPhoto || '';
  initShopMap();
}

/* ===================== 门店地图选点（高德地图 JS API） ===================== */
let _amapPromise = null;
let _mapConfigCache = null;
let _shopMap = null;
let _shopMarker = null;
let _amapGeocoder = null;
let _amapPlaceSearch = null;

// 动态加载高德地图脚本（只加载一次）
function loadAMapScript(key, securityCode) {
  if (window.AMap) return Promise.resolve(true);
  if (_amapPromise) return _amapPromise;
  _amapPromise = new Promise((resolve, reject) => {
    if (securityCode) window._AMapSecurityConfig = { securityJsCode: securityCode };
    const s = document.createElement('script');
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.PlaceSearch,AMap.Geocoder,AMap.AutoComplete`;
    s.onload = () => resolve(true);
    s.onerror = () => { _amapPromise = null; reject(new Error('高德地图脚本加载失败')); };
    document.head.appendChild(s);
  });
  return _amapPromise;
}

// 读取后端下发的地图配置（含浏览器端公开 Key）
async function getMapConfig() {
  if (_mapConfigCache) return _mapConfigCache;
  const res = await api('/api/config/map');
  _mapConfigCache = (res && res.data) || { amapKey: '', amapSecurityCode: '' };
  return _mapConfigCache;
}

// 写入经纬度（沿用门店保存逻辑读取的输入框）
function setShopLngLat(lng, lat) {
  $('setShopLng').value = Number(lng).toFixed(6);
  $('setShopLat').value = Number(lat).toFixed(6);
}

// 逆地理编码回填详细地址（仅在地址为空时回填，避免覆盖商家手填内容）
function reverseFillAddress(lng, lat) {
  const addrInput = $('setShopAddr');
  if (!addrInput || addrInput.value.trim() || !_amapGeocoder) return;
  _amapGeocoder.getAddress([lng, lat], (status, result) => {
    if (status === 'complete' && result && result.regeocode) {
      addrInput.value = result.regeocode.formattedAddress || '';
    }
  });
}

// 初始化地图选点：有 Key 用地图，无 Key / 加载失败退化为经纬度手输
async function initShopMap() {
  const mapWrap = $('mapPickerWrap');
  const manualWrap = $('lngLatManualWrap');
  if (!mapWrap || !manualWrap) return;
  let cfg;
  try { cfg = await getMapConfig(); } catch (e) { cfg = { amapKey: '' }; }
  if (!cfg.amapKey) {
    mapWrap.style.display = 'none';
    manualWrap.style.display = 'flex';
    return;
  }
  try {
    await loadAMapScript(cfg.amapKey, cfg.amapSecurityCode);
  } catch (e) {
    mapWrap.style.display = 'none';
    manualWrap.style.display = 'flex';
    if ($('mapFallbackHint')) $('mapFallbackHint').textContent = '高德地图加载失败，暂可手输经纬度';
    return;
  }
  mapWrap.style.display = 'block';
  manualWrap.style.display = 'none';
  // 隐藏「未配置 Key」的兜底提示（Key 已生效，地图已加载）
  if ($('mapFallbackHint')) $('mapFallbackHint').style.display = 'none';

  const lng = parseFloat($('setShopLng').value);
  const lat = parseFloat($('setShopLat').value);
  const hasPos = isFinite(lng) && isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
  const center = hasPos ? [lng, lat] : [116.397428, 39.90923]; // 未设置时默认北京

  if (_shopMap) {
    _shopMap.setZoomAndCenter(hasPos ? 16 : 11, center);
    _shopMarker.setPosition(center);
    return;
  }

  _shopMap = new AMap.Map('shopMap', { zoom: hasPos ? 16 : 11, center, resizeEnable: true });
  _shopMarker = new AMap.Marker({ position: center, draggable: true, cursor: 'move' });
  _shopMarker.setMap(_shopMap);
  _amapGeocoder = new AMap.Geocoder();
  _amapPlaceSearch = new AMap.PlaceSearch({ map: _shopMap, autoFitView: true });

  // 标记拖动 / 地图点击 → 更新经纬度并回填地址
  _shopMarker.on('dragend', () => {
    const p = _shopMarker.getPosition();
    setShopLngLat(p.getLng(), p.getLat());
    reverseFillAddress(p.getLng(), p.getLat());
  });
  _shopMap.on('click', (e) => {
    _shopMarker.setPosition(e.lnglat);
    setShopLngLat(e.lnglat.getLng(), e.lnglat.getLat());
    reverseFillAddress(e.lnglat.getLng(), e.lnglat.getLat());
  });

  // 搜索框：输入联想选择 + 回车检索
  if (AMap.AutoComplete) {
    const ac = new AMap.AutoComplete({ input: 'mapSearchInput' });
    ac.on('select', (e) => {
      if (e && e.poi && e.poi.location) {
        const p = e.poi.location;
        _shopMap.setZoomAndCenter(16, p);
        _shopMarker.setPosition(p);
        setShopLngLat(p.getLng(), p.getLat());
      }
    });
  }
  $('mapSearchInput').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const kw = $('mapSearchInput').value.trim();
    if (!kw) return;
    _amapPlaceSearch.search(kw, (status, result) => {
      if (status === 'complete' && result && result.poiList && result.poiList.pois.length) {
        const p = result.poiList.pois[0].location;
        _shopMap.setZoomAndCenter(16, p);
        _shopMarker.setPosition(p);
        setShopLngLat(p.getLng(), p.getLat());
      } else {
        toast('未找到该地址，请在地图上手动选点', true);
      }
    });
  });
}

/* ===================== 店铺装修（独立栏目） ===================== */
let _decoState = { theme: 'classic', shopNameFont: 'modern', layout: 'list', bannerImage: '', logoImage: '', promoPoster: '', promoPosterSize: 'small', shopName: '鼎恒餐饮' };
let _decoSelected = { theme: null, shopNameFont: null, layout: null }; // 选中态（未应用），null 表示未选中
// 门店定位与收货：已保存的门头照/街景照 URL（无新上传时保留原值）
let _existingStoreFront = '';
let _existingStreetView = '';

const POSTER_SIZES = [
  { id: 'small',  name: '小横幅（矮）', desc: '矮横条，不遮挡菜单' },
  { id: 'medium', name: '小海报（中）', desc: '适中高度，图文均衡' },
  { id: 'large',  name: '大海报（高）', desc: '大图展示，视觉冲击强' }
];

async function loadDecorate() {
  const [res] = await Promise.all([api('/api/settings'), fetchMemberLevel()]);
  const s = res.data || {};
  _decoState = {
    theme: THEME_LIST_DECO.includes(s.theme) ? s.theme : 'classic',
    shopNameFont: ['modern', 'serif', 'round', 'hand'].includes(s.shopNameFont) ? s.shopNameFont : 'modern',
    layout: ['list', 'large', 'grid'].includes(s.layout) ? s.layout : 'list',
    bannerImage: s.bannerImage || '',
    logoImage: s.logoImage || '',
    promoPoster: s.promoPoster || '',
    promoPosterSize: ['small', 'medium', 'large'].includes(s.promoPosterSize) ? s.promoPosterSize : 'small',
    shopName: s.shopName || '鼎恒餐饮'
  };
  // 选中态：null 表示未选中（点击卡片时填入字段值，预览/应用按钮浮现于该卡片下方）
  _decoSelected = { theme: null, shopNameFont: null, layout: null };
  renderThemeGrid(_decoState.theme);
  renderDecoLock();
  setDecoPreview($('bannerPreview'), _decoState.bannerImage, '未设置 · 使用主题默认');
  setDecoPreview($('logoPreview'), _decoState.logoImage, '未设置 · 使用主题默认');
  setDecoPreview($('posterPreview'), _decoState.promoPoster, '未设置 · 显示文字轮播');
  renderFontGrid(_decoState.shopNameFont);
  renderLayoutGrid(_decoState.layout);
  renderPosterSizeRow();
}

const THEME_LIST_DECO = ['classic', 'minimal', 'dark', 'green', 'redgold'];

$('saveSettingsBtn').onclick = async () => {
  const body = {
    shopName: $('setShopName').value.trim(),
    enableVoice: $('setEnableVoice').checked,
    enableBigscreen: $('setEnableBigscreen').checked,
    enablePrinter: $('setEnablePrinter').checked,
    enableWechat: $('setEnableWechat').checked,
    printerSN: $('setPrinterSN').value.trim(),
    printerKey: $('setPrinterKey').value.trim(),
    notifyPhone: $('setNotifyPhone').value.trim(),
    printerApiUrl: $('setPrinterApiUrl').value.trim(),
    notifyWebhookUrl: $('setNotifyWebhookUrl').value.trim(),
    smsApiUrl: $('setSmsApiUrl').value.trim(),
    smsApiKey: $('setSmsApiKey').value.trim(),
    voiceApiUrl: $('setVoiceApiUrl').value.trim(),
    voiceApiKey: $('setVoiceApiKey').value.trim(),
    wechatApiUrl: $('setWechatApiUrl').value.trim(),
    wechatApiKey: $('setWechatApiKey').value.trim(),
    wechatTemplateId: $('setWechatTemplateId').value.trim(),
    wechatToUser: $('setWechatToUser').value.trim()
  };
  if (!body.shopName) { toast('请输入店铺名称', true); return; }
  if (body.enablePrinter && !body.printerSN) { toast('请填写打印机编号', true); return; }
  if (body.enableWechat && !body.notifyPhone && !body.notifyWebhookUrl && !body.smsApiUrl && !body.voiceApiUrl && !body.wechatApiUrl) {
    toast('请至少填写一种通知渠道（微信 / 手机号 / Webhook / 短信 / 语音）', true);
    return;
  }

  // 上传门头照（如有新选文件），无则保留原 URL
  let storeFrontUrl = _existingStoreFront;
  const sfFile = $('setStoreFront').files[0];
  if (sfFile) {
    const fd = new FormData(); fd.append('file', sfFile);
    const u = await fetch('/api/admin/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + MERCHANT_TOKEN, 'x-shop-id': SHOP_ID },
      body: fd
    }).then(r => r.json());
    if (!u.success) { toast(u.message || '门头照上传失败', true); return; }
    storeFrontUrl = u.data.url;
  }
  // 上传街景照（选传）
  let streetViewUrl = _existingStreetView;
  const svFile = $('setStreetView').files[0];
  if (svFile) {
    const fd = new FormData(); fd.append('file', svFile);
    const u = await fetch('/api/admin/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + MERCHANT_TOKEN, 'x-shop-id': SHOP_ID },
      body: fd
    }).then(r => r.json());
    if (!u.success) { toast(u.message || '街景照上传失败', true); return; }
    streetViewUrl = u.data.url;
  }

  // 配送三件套字段
  body.shopLongitude = parseFloat($('setShopLng').value) || null;
  body.shopLatitude = parseFloat($('setShopLat').value) || null;
  body.shopAddress = $('setShopAddr').value.trim();
  body.storeFrontPhoto = storeFrontUrl;
  body.streetViewPhoto = streetViewUrl;
  body.receiveMethod = $('setReceiveMethod').value;
  body.expectedReceiveStart = $('setRecvStart').value || '';
  body.expectedReceiveEnd = $('setRecvEnd').value || '';

  const res = await api('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (res.success) {
    toast('保存成功');
    // 同步已保存 URL 与预览
    _existingStoreFront = storeFrontUrl;
    _existingStreetView = streetViewUrl;
    if (storeFrontUrl) { $('storeFrontPreview').src = storeFrontUrl; $('storeFrontPreview').style.display = 'block'; }
    if (streetViewUrl) { $('streetViewPreview').src = streetViewUrl; $('streetViewPreview').style.display = 'block'; }
    $('setStoreFront').value = ''; $('setStreetView').value = '';
  }
  else toast(res.message || '保存失败', true);
};

bindSettingsToggles();

/* ===================== 店铺装修 ===================== */
// 主题包定义（与 models/Setting.js theme 枚举一致）；minLevel 用于会员等级锁定
const SHOP_THEMES = [
  { id: 'classic', name: '经典橙', desc: '暖橙渐变 · 默认风格', banner: 'linear-gradient(135deg,#FFB347,#ff9a44,#f55100)', bannerText: '#fff', minLevel: 'basic' },
  { id: 'minimal', name: '简约白', desc: '黑白主色 · 苹果式大留白', banner: 'linear-gradient(180deg,#ffffff,#eef0f3)', bannerText: '#1a1a1a', minLevel: 'basic' },
  { id: 'dark',    name: '时尚暗黑', desc: '琥珀暖光 · 居酒屋/烧鸟店', banner: 'linear-gradient(160deg,#1B1613,#2A2218)', bannerText: '#F5EFE6', minLevel: 'advanced' },
  { id: 'green',   name: '清新绿', desc: '暖绿圆角 · 轻食/茶饮', banner: 'linear-gradient(135deg,#7CCB8E,#3CB371)', bannerText: '#fff', minLevel: 'advanced' },
  { id: 'redgold', name: '国潮红金', desc: '红金老字号 · 酒楼', banner: 'linear-gradient(135deg,#B03A2E,#7B241C)', bannerText: '#FFE9B0', minLevel: 'advanced' }
];
let _memberLevel = 'basic'; // 当前商家会员等级

// 拉取会员等级（与鼎恒币中心同一接口）
async function fetchMemberLevel() {
  try {
    const res = await api(`/api/coin/status/${SHOP_ID}`);
    _memberLevel = (res.data && res.data.memberLevel) || 'basic';
  } catch (e) {
    _memberLevel = 'basic';
  }
  return _memberLevel;
}

function renderThemeGrid(currentTheme) {
  const rank = LEVEL_RANK[_memberLevel] ?? 0;
  const grid = $('themeGrid');
  if (!grid) return;
  const selected = _decoSelected.theme;
  grid.innerHTML = SHOP_THEMES.map(t => {
    const locked = LEVEL_RANK[t.minLevel] > rank;
    const active = t.id === currentTheme;
    const isSelected = t.id === selected;
    const actionHtml = isSelected
      ? `<div class="deco-actions show">
           <span class="da-tip">${active ? '当前已应用，可重新预览' : '已选中（未应用）。点预览看效果，应用后生效'}</span>
           <button class="btn-preview" onclick="previewDeco('theme','${t.id}')">预览</button>
           <button class="btn-apply" onclick="applyDeco('theme','${t.id}')">应用</button>
         </div>`
      : '';
    return `<div class="theme-card ${active ? 'active' : ''} ${isSelected ? 'selected' : ''}" data-theme="${t.id}" data-locked="${locked ? 1 : 0}">
      <div class="tc-banner" style="background:${t.banner};color:${t.bannerText};"><span class="tc-logo">🍽</span>${esc(t.name)}</div>
      <div class="tc-body"><div class="tc-name">${esc(t.name)}</div><div class="tc-desc">${esc(t.desc)}</div></div>
      ${active ? '<span class="tc-check">✓</span>' : (locked ? '<span class="tc-lock">🔒</span>' : '')}
      ${actionHtml}
    </div>`;
  }).join('');
  grid.querySelectorAll('.theme-card').forEach(card => {
    card.onclick = () => handleThemeClick(card.dataset.theme, card.dataset.locked === '1');
  });
}

function handleThemeClick(themeId, locked) {
  if (locked) {
    toast('升级会员解锁全部店铺风格 →', true);
    goUpgrade('advanced');
    return;
  }
  // 点击同一卡片再次点击取消选中
  _decoSelected.theme = (_decoSelected.theme === themeId) ? null : themeId;
  renderThemeGrid(_decoState.theme);
}

// 通用：选中字段 + 重渲染对应 grid（不立即保存）
function selectDeco(field, value) {
  _decoSelected[field] = (_decoSelected[field] === value) ? null : value;
  if (field === 'theme') renderThemeGrid(_decoState.theme);
  else if (field === 'shopNameFont') renderFontGrid(_decoState.shopNameFont);
  else if (field === 'layout') renderLayoutGrid(_decoState.layout);
}

// 预览：已应用设置 + 当前选中字段叠加；其余未选中字段维持已应用
async function previewDeco(field, value) {
  // 构造叠加 setting（被点击的字段用 value，其余用 _decoState 已应用值，再加 _decoSelected 中其它选中字段
  const merged = Object.assign({}, _decoState, { [field]: value });
  // 其它字段的选中值也叠加进去（如先选了字体再点主题预览，字体一并生效）
  Object.keys(_decoSelected).forEach(k => {
    if (_decoSelected[k] && k !== field) merged[k] = _decoSelected[k];
  });
  // 在 admin 内以手机框 iframe 打开（embed=1，关闭由本页接管）
  openCustomerPreview(merged);
}

/* ---------- 装修预览手机框（iframe 嵌入真实点餐页） ----------
   统一入口：店铺装修「预览」按钮 + 店铺运营「预览点餐页」均走这里。
   关闭仅两种方式：点 ✕ 返回按钮 或 按 Esc 键（不拦截 F12 等开发者工具按键）。 */
let _customerPreviewEscHandler = null;
function openCustomerPreview(overrides) {
  const merged = Object.assign({}, _decoState || {}, overrides || {});
  const qs = new URLSearchParams({
    shopId: SHOP_ID,
    preview: '1',
    embed: '1',
    theme: merged.theme || '',
    shopNameFont: merged.shopNameFont || '',
    layout: merged.layout || ''
  });
  if (merged.bannerImage) qs.set('bannerImage', merged.bannerImage);
  if (merged.logoImage) qs.set('logoImage', merged.logoImage);
  if (merged.shopName) qs.set('shopName', merged.shopName);
  const frame = $('customerPreviewFrame');
  if (frame) frame.src = 'customer.html?' + qs.toString();
  const modal = $('customerPreviewModal');
  if (modal) {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }
  // 绑定 Esc 关闭（仅本页生效，不影响 iframe 内的 F12）
  if (_customerPreviewEscHandler) document.removeEventListener('keydown', _customerPreviewEscHandler);
  _customerPreviewEscHandler = (e) => { if (e.key === 'Escape') closeCustomerPreview(); };
  document.addEventListener('keydown', _customerPreviewEscHandler);
  // 新手任务：预览过点餐页即完成"预览你的点餐页"
  try { reportOnboardStep('preview'); } catch (e) {}
}
function closeCustomerPreview() {
  const modal = $('customerPreviewModal');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
  // 清空 iframe src，停止后台加载/轮询
  const frame = $('customerPreviewFrame');
  if (frame) frame.src = 'about:blank';
  if (_customerPreviewEscHandler) {
    document.removeEventListener('keydown', _customerPreviewEscHandler);
    _customerPreviewEscHandler = null;
  }
}
(function () {
  const btn = $('customerPreviewClose');
  if (btn) btn.onclick = closeCustomerPreview;
  // 点击遮罩不关闭（仅 ✕ 与 Esc 可关闭，避免误触）
})();
window.openCustomerPreview = openCustomerPreview;
window.closeCustomerPreview = closeCustomerPreview;

// 应用：保存选中字段到 Setting 并生效
async function applyDeco(field, value) {
  const res = await api('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [field]: value })
  });
  if (res.success) {
    const label = field === 'theme' ? '主题'
      : field === 'shopNameFont' ? '字体'
      : '排版';
    toast(label + '已应用，顾客端实时生效');
    _decoState[field] = value;
    _decoSelected[field] = null;
    if (field === 'theme') renderThemeGrid(_decoState.theme);
    else if (field === 'shopNameFont') renderFontGrid(_decoState.shopNameFont);
    else if (field === 'layout') renderLayoutGrid(_decoState.layout);
    // 新手任务：主题/字体/排版被修改即完成"装修你的店铺"
    try { loadOnboarding(); } catch (e) {}
  } else if (res.needUpgrade) {
    toast(res.message || '升级会员解锁全部店铺风格 →', true);
    goUpgrade('advanced');
  } else {
    toast(res.message || '设置失败', true);
  }
}

// 装修图片预览
function setDecoPreview(el, url, emptyText) {
  if (!el) return;
  el.innerHTML = url ? `<img src="${esc(url)}" alt="">` : `<span>${esc(emptyText || '未设置')}</span>`;
}

// 根据会员等级锁定/解锁自定义图片区（进阶版及以上可用）
const DECO_UPGRADE_TIP = '开通会员，上传你店的专属头图与 logo，让顾客记住你的店';
function renderDecoLock() {
  const isAdvanced = (LEVEL_RANK[_memberLevel] ?? 0) >= LEVEL_RANK.advanced;
  ['decoBanner', 'decoLogo', 'decoPoster'].forEach(id => {
    const box = $(id);
    if (box) box.classList.toggle('locked', !isAdvanced);
  });
  ['bannerLock', 'logoLock', 'posterLock'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = isAdvanced ? 'none' : 'inline-block';
  });
}

// 装修图片字段映射：kind → Setting 字段 / 预览元素
const DECO_IMAGE_FIELDS = {
  banner: { field: 'bannerImage', preview: 'bannerPreview' },
  logo:   { field: 'logoImage',   preview: 'logoPreview' },
  poster: { field: 'promoPoster', preview: 'posterPreview' }
};

// 通用图片上传（进阶版及以上校验在前）：kind = banner / logo / poster
async function uploadDecoImage(file, kind) {
  if ((LEVEL_RANK[_memberLevel] ?? 0) < LEVEL_RANK.advanced) {
    toast(DECO_UPGRADE_TIP, true);
    goUpgrade('advanced');
    return;
  }
  const map = DECO_IMAGE_FIELDS[kind];
  if (!map) return;
  try {
    toast('图片处理中...');
    const dataUrl = await compressImage(file);
    const blob = await (await fetch(dataUrl)).blob();
    const fd = new FormData();
    fd.append('file', blob, `deco_${kind}_${Date.now()}.jpg`);
    const up = await api('/api/admin/upload', { method: 'POST', body: fd });
    if (!up.success || !up.data || !up.data.url) {
      toast(up.message || '上传失败', true);
      return;
    }
    const res = await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [map.field]: up.data.url })
    });
    if (res.success) {
      toast(kind === 'poster' ? '海报已上传，顾客端实时生效' : '已更新，顾客端实时生效');
      _decoState[map.field] = up.data.url;
      setDecoPreview($(map.preview), up.data.url);
      // 新手任务：上传头图 / LOGO / 海报也算完成店铺装修
      try { loadOnboarding(); } catch (e) {}
    } else if (res.needUpgrade) {
      toast(res.message || DECO_UPGRADE_TIP, true);
      goUpgrade('advanced');
    } else {
      toast(res.message || '保存失败', true);
    }
  } catch (e) {
    toast(e.message || '上传失败', true);
  }
}

// 恢复默认（置空字段，不限会员等级）
async function clearDecoImage(field, previewId, emptyText) {
  const res = await api('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [field]: '' })
  });
  if (res.success) {
    toast(field === 'promoPoster' ? '已移除海报，恢复优惠文字轮播' : '已恢复主题默认');
    _decoState[field] = '';
    setDecoPreview($(previewId), '', emptyText || '未设置 · 使用主题默认');
  } else {
    toast(res.message || '操作失败', true);
  }
}

$('uploadBannerBtn').onclick = () => $('bannerFile').click();
$('uploadLogoBtn').onclick = () => $('logoFile').click();
$('bannerFile').onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) uploadDecoImage(f, 'banner');
  e.target.value = '';
};
$('logoFile').onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) uploadDecoImage(f, 'logo');
  e.target.value = '';
};
$('clearBannerBtn').onclick = () => clearDecoImage('bannerImage', 'bannerPreview');
$('clearLogoBtn').onclick = () => clearDecoImage('logoImage', 'logoPreview');

/* ---------- 优惠海报（上传后点餐页顶部优惠区以海报为主） ---------- */
$('uploadPosterBtn').onclick = () => $('posterFile').click();
$('posterFile').onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) uploadDecoImage(f, 'poster');
  e.target.value = '';
};
$('clearPosterBtn').onclick = () => clearDecoImage('promoPoster', 'posterPreview', '未设置 · 显示文字轮播');

// 海报尺寸三档切换（点选即刻生效，尺寸切换不限会员等级）
function renderPosterSizeRow() {
  const row = $('posterSizeRow');
  if (!row) return;
  row.querySelectorAll('.psize-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === _decoState.promoPosterSize);
  });
}
$('posterSizeRow').addEventListener('click', async (e) => {
  const btn = e.target.closest('.psize-btn');
  if (!btn || btn.dataset.size === _decoState.promoPosterSize) return;
  const size = btn.dataset.size;
  const res = await api('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promoPosterSize: size })
  });
  if (res.success) {
    _decoState.promoPosterSize = size;
    renderPosterSizeRow();
    toast('海报尺寸已更新，顾客端实时生效');
  } else {
    toast(res.message || '操作失败', true);
  }
});

/* ---------- 店名字体（系统字体栈，与 customer.js / models/Setting.js 保持一致） ---------- */
const NAME_FONTS = [
  { id: 'modern', name: '现代黑体', desc: '系统默认 · 大多数店铺', stack: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif' },
  { id: 'serif',  name: '雅致宋体', desc: '酒楼 / 茶楼 / 老字号', stack: '"Noto Serif SC", "Songti SC", "SimSun", serif' },
  { id: 'round',  name: '圆润体',   desc: '茶饮 / 甜品 / 年轻店铺', stack: '"Yuanti SC", "YouYuan", "幼圆", "PingFang SC", sans-serif' },
  { id: 'hand',   name: '手写风格', desc: '小馆子 / 私房菜',       stack: '"Kaiti SC", "STKaiti", "KaiTi", "楷体", cursive' }
];

/* ---------- 菜单排版（与 customer.js / models/Setting.js 保持一致） ---------- */
const MENU_LAYOUTS = [
  { id: 'list',  name: '经典列表', desc: '左图右文 · 信息均衡' },
  { id: 'large', name: '大图模式', desc: '大图诱人 · 烧烤/火锅' },
  { id: 'grid',  name: '双列网格', desc: '一屏多菜 · 快餐/面馆' }
];

function fontSampleText() {
  return _decoState.shopName || '鼎恒餐饮';
}

function renderFontGrid(currentId) {
  const grid = $('fontGrid');
  if (!grid) return;
  const sample = esc(fontSampleText());
  const selected = _decoSelected.shopNameFont;
  grid.innerHTML = NAME_FONTS.map(f => {
    const active = f.id === currentId;
    const isSelected = f.id === selected;
    const actionHtml = isSelected
      ? `<div class="deco-actions show">
           <span class="da-tip">${active ? '当前已应用，可重新预览' : '已选中（未应用）。点预览看效果，应用后生效'}</span>
           <button class="btn-preview" onclick="previewDeco('shopNameFont','${f.id}')">预览</button>
           <button class="btn-apply" onclick="applyDeco('shopNameFont','${f.id}')">应用</button>
         </div>`
      : '';
    return `<div class="opt-card ${active ? 'active' : ''} ${isSelected ? 'selected' : ''}" data-id="${f.id}">
      <div class="oc-name">${esc(f.name)}</div>
      <div class="oc-desc">${esc(f.desc)}</div>
      <div class="oc-sample" style='font-family:${f.stack}'>${sample}</div>
      ${active ? '<span class="oc-check">✓</span>' : ''}
      ${actionHtml}
    </div>`;
  }).join('');
  grid.querySelectorAll('.opt-card').forEach(card => {
    card.onclick = () => selectDeco('shopNameFont', card.dataset.id);
  });
}

// 排版小预览图（CSS 示意，非真实截图）
function layoutPreviewHtml(id) {
  if (id === 'large') {
    return `<div class="lc-prev" style="flex-direction:column;gap:5px;">
      <span class="pl-big"></span>
      <span class="pl-line" style="width:72%;"></span>
      <span class="pl-line" style="width:45%;"></span>
    </div>`;
  }
  if (id === 'grid') {
    const col = `<span class="pl-col"><span class="pl-sq"></span><span class="pl-line"></span><span class="pl-line" style="width:60%;"></span></span>`;
    return `<div class="lc-prev">${col}${col}</div>`;
  }
  const row = `<span class="pl-row"><span class="pl-thumb"></span><span class="pl-rows"><span class="pl-line"></span><span class="pl-line" style="width:55%;"></span></span></span>`;
  return `<div class="lc-prev" style="flex-direction:column;gap:6px;">${row}${row}</div>`;
}

function renderLayoutGrid(currentId) {
  const grid = $('layoutGrid');
  if (!grid) return;
  const selected = _decoSelected.layout;
  grid.innerHTML = MENU_LAYOUTS.map(l => {
    const active = l.id === currentId;
    const isSelected = l.id === selected;
    const actionHtml = isSelected
      ? `<div class="deco-actions show">
           <span class="da-tip">${active ? '当前已应用，可重新预览' : '已选中（未应用）。点预览看效果，应用后生效'}</span>
           <button class="btn-preview" onclick="previewDeco('layout','${l.id}')">预览</button>
           <button class="btn-apply" onclick="applyDeco('layout','${l.id}')">应用</button>
         </div>`
      : '';
    return `<div class="opt-card ${active ? 'active' : ''} ${isSelected ? 'selected' : ''}" data-id="${l.id}">
      ${layoutPreviewHtml(l.id)}
      <div class="oc-name">${esc(l.name)}</div>
      <div class="oc-desc">${esc(l.desc)}</div>
      ${active ? '<span class="oc-check">✓</span>' : ''}
      ${actionHtml}
    </div>`;
  }).join('');
  grid.querySelectorAll('.opt-card').forEach(card => {
    card.onclick = () => selectDeco('layout', card.dataset.id);
  });
}

/* ===================== 鼎恒币中心（双产品线） ===================== */
// 点餐线：basic/advanced/premium；采购线：free/plus/pro。两条线各自独立、互不比较。
const LEVEL_NAME = {
  basic: '点餐免费版', advanced: '点餐进阶版', premium: '点餐尊享版',
  free: '采购免费版', plus: '采购省钱卡', pro: '采购省钱卡Pro'
};
const LEVEL_RANK = { basic: 0, advanced: 1, premium: 2 };      // 点餐线秩
const PURCHASE_RANK = { free: 0, plus: 1, pro: 2 };             // 采购线秩
const LEVEL_COUPON_MAX = { basic: 'purchase_30', advanced: 'purchase_100', premium: 'purchase_200' };
// 采购返币率（币/元）：与后端 dhConfig.PURCHASE_COIN_RATE 一致
const COIN_RATE = { free: 0.5, plus: 1, pro: 1 };
// 券所需采购等级：后端 coupons.needLevel(basic/advanced/premium) → 采购线(free/plus/pro)
const COUPON_NEED_PURCHASE = { basic: 'free', advanced: 'plus', premium: 'pro' };

// 兑换/续费按钮状态统一计算（双产品线）
// 高等级不可降兑 → 禁用并提示；币不足 → 禁用并显示差额；否则可续费/升级
function updateRenewBtn(btnId, targetLevel, productLine, coinNow, curLevel, curActive) {
  const btn = $(btnId);
  if (!btn) return;
  const ranks = productLine === 'purchase' ? PURCHASE_RANK : LEVEL_RANK;
  const cost = (PLAN_CFG[targetLevel] || {}).coinCost || 0;
  const curRank = ranks[curLevel] ?? 0;
  const tgtRank = ranks[targetLevel] ?? 0;
  const label = LEVEL_NAME[targetLevel] || targetLevel;
  if (tgtRank < curRank) {
    btn.disabled = true;
    btn.textContent = '当前已是更高等级';
    btn.title = '高等级无法降兑为低等级';
  } else if (coinNow < cost) {
    btn.disabled = true;
    btn.textContent = `鼎恒币不足（差 ${cost - coinNow} 币）`;
    btn.title = '';
  } else {
    btn.disabled = false;
    btn.textContent = (targetLevel === curLevel && curActive)
      ? `续费${label}`
      : (tgtRank > curRank ? `升级到${label}` : `兑换${label}`);
    btn.title = '';
  }
}

// 鼎恒币中心页面加载
let _coinCenterData = null; // 缓存，方便兑换后刷新
async function loadCoinCenter() {
  try {
    const [status, history] = await Promise.all([
      api(`/api/coin/status/${SHOP_ID}`),
      api(`/api/coin/history/${SHOP_ID}`)
    ]);

    // 顶部余额与两条产品线状态
    _coinCenterData = status.data || {};
    const d = _coinCenterData;
    const currentLevel = d.memberLevel || 'basic';          // 点餐线
    const purLevel = d.purchaseLevel || 'free';             // 采购线
    const posExpire = d.memberExpire ? new Date(d.memberExpire) : null;
    const purExpire = d.purchaseExpire ? new Date(d.purchaseExpire) : null;
    const posActive = d.membershipActive !== false;
    const purActive = d.purchaseActive !== false;
    $('coinBalance').textContent = d.dinghengCoin ?? 0;
    $('coinTotalEarned').textContent = d.totalEarnedCoin ?? 0;
    // 顶部会员位以"采购线"为主展示（采购为核心），点餐线状态挂在 title 提示
    $('coinMemberLevel').textContent = `🛒 ${LEVEL_NAME[purLevel] || '采购免费版'}`;
    $('coinMemberExpire').textContent = (purActive && purExpire)
      ? '采购线到期 ' + fmtTime(d.purchaseExpire).slice(0, 10)
      : (purActive ? '采购线长期有效' : '采购线已过期');
    const coinMemberBox = $('coinMemberLevel');
    if (coinMemberBox) {
      coinMemberBox.title = `点餐线：${LEVEL_NAME[currentLevel] || ''}` +
        ((posActive && posExpire) ? `（到期 ${fmtTime(d.memberExpire).slice(0, 10)}）` : '（长期有效）');
    }

    // 四条兑换按钮状态（采购线 plus/pro + 点餐线 advanced/premium）
    const coinNow = d.dinghengCoin ?? 0;
    updateRenewBtn('coinRenewPlus', 'plus', 'purchase', coinNow, purLevel, purActive);
    updateRenewBtn('coinRenewPro', 'pro', 'purchase', coinNow, purLevel, purActive);
    updateRenewBtn('coinRenewAdvanced', 'advanced', 'pos', coinNow, currentLevel, posActive);
    updateRenewBtn('coinRenewPremium', 'premium', 'pos', coinNow, currentLevel, posActive);

    const coupons = d.coupons || [];

    // 渲染抵用券兑换网格（固定 6 张，与 dhConfig 一致）+ 2 张未开放预告卡
    // 阶梯递减：面额越大，每元抵用所需鼎恒币越少（越划算）
    const couponConfigs = [
      { type: 'purchase_10', faceValue: 10, coinCost: 800, minOrder: 300, needLevel: 'basic' },
      { type: 'purchase_20', faceValue: 20, coinCost: 1500, minOrder: 500, needLevel: 'basic' },
      { type: 'purchase_30', faceValue: 30, coinCost: 2100, minOrder: 800, needLevel: 'basic' },
      { type: 'purchase_50', faceValue: 50, coinCost: 3200, minOrder: 1200, needLevel: 'advanced' },
      { type: 'purchase_100', faceValue: 100, coinCost: 6000, minOrder: 2500, needLevel: 'advanced' },
      { type: 'purchase_200', faceValue: 200, coinCost: 11000, minOrder: 4000, needLevel: 'premium' }
    ];
    // 未开放预告券（暂未开放，仅展示不可兑换；金卡，金色锁定样式）
    const upcomingConfigs = [
      { faceValue: 300, coinCost: 15000, minOrder: 6000 },
      { faceValue: 500, coinCost: 24000, minOrder: 10000 }
    ];
    const normalHtml = couponConfigs.map(c => {
      // 券属采购线权益：按采购线等级判定（后端 coupons.needLevel 为 basic/advanced/premium）
      const needPurchase = COUPON_NEED_PURCHASE[c.needLevel] || 'free';
      const locked = (PURCHASE_RANK[purLevel] ?? 0) < (PURCHASE_RANK[needPurchase] ?? 0);
      const notEnough = (d.dinghengCoin ?? 0) < c.coinCost;
      const canExchange = !locked && !notEnough;
      return `
        <div class="coupon-item ${locked ? 'locked' : ''}">
          <div class="coupon-face">¥${c.faceValue}<small> 抵</small></div>
          <div class="coupon-cost">需 <span>${c.coinCost} DH</span></div>
          <div class="coupon-condition">满 ¥${c.minOrder} 可用 · ${LEVEL_NAME[needPurchase]}可兑</div>
          ${locked
            ? `<div class="coupon-locked-tip">${LEVEL_NAME[needPurchase]}可兑换</div><button class="btn-add" onclick="goUpgrade('${needPurchase}')">升级解锁</button>`
            : `<button class="btn-add" ${canExchange ? '' : 'disabled'} onclick="exchangeCoupon('${c.type}')">${canExchange ? '立即兑换' : '鼎恒币不足'}</button>`}
        </div>
      `;
    }).join('');
    const upcomingHtml = upcomingConfigs.map(c => `
      <div class="coupon-item coupon-upcoming" aria-disabled="true">
        <div class="coupon-upcoming-badge">🔒 即将开放</div>
        <div class="coupon-face">¥${c.faceValue}<small> 抵</small></div>
        <div class="coupon-cost">需 <span>${c.coinCost} DH</span></div>
        <div class="coupon-condition">满 ¥${c.minOrder} 可用</div>
        <button class="btn btn-gray" disabled>未开放</button>
      </div>
    `).join('');
    const upcomingSection = `
      <div class="coupon-gold-row">
        ${upcomingHtml}
        <div class="coupon-upcoming-foot">平台商家采购规模达标后开放，敬请期待</div>
      </div>
    `;
    $('couponGrid').innerHTML = normalHtml + upcomingSection;

    // 币兑增值包货架
    renderAddonGrid(d);

    // 我的抵用券表格
    const couponsBody = $('couponsBody');
    if (!coupons.length) {
      couponsBody.innerHTML = `<tr><td colspan="4" class="empty">暂无抵用券</td></tr>`;
    } else {
      couponsBody.innerHTML = coupons.map(c => {
        const expire = new Date(c.expireDate);
        const daysLeft = Math.ceil((expire - new Date()) / 86400000);
        const statusText = daysLeft <= 7 ? `<span class="b-orange">剩 ${daysLeft} 天</span>` : '<span class="b-green">可用</span>';
        return `
          <tr>
            <td><b>¥${c.faceValue}</b></td>
            <td>满 ¥${c.minOrder}</td>
            <td>${fmtTime(c.expireDate).slice(0, 10)}</td>
            <td>${statusText}</td>
          </tr>
        `;
      }).join('');
    }

    // 鼎恒币流水
    const historyList = history.data || [];
    const histBody = $('coinHistoryBody');
    if (!historyList.length) {
      histBody.innerHTML = `<tr><td colspan="5" class="empty">暂无流水记录</td></tr>`;
    } else {
      const typeMap = {
        purchase_reward: '采购返币',
        redeem_coupon: '兑换抵用券',
        redeem_membership: '兑换会员',
        admin_grant: '管理员发放',
        consume: '消费扣减',
        expire: '过期扣除'
      };
      histBody.innerHTML = historyList.map(h => {
        const amount = h.amount || 0;
        const isPos = amount > 0;
        const amountCls = isPos ? 'b-green' : 'b-red';
        const amountText = (isPos ? '+' : '') + amount + ' DH';
        return `
          <tr>
            <td>${fmtTime(h.createdAt)}</td>
            <td><span class="badge b-gray">${typeMap[h.type] || h.type}</span></td>
            <td><span class="badge ${amountCls}">${amountText}</span></td>
            <td>${h.balanceAfter ?? '—'}</td>
            <td>${esc(h.description || '—')}</td>
          </tr>
        `;
      }).join('');
    }
  } catch (e) {
    console.error(e);
    toast('加载鼎恒币数据失败', true);
  }
}

// 兑换抵用券
async function exchangeCoupon(couponType) {
  if (!confirm('确定兑换该抵用券？鼎恒币将立即扣减。')) return;
  const res = await api('/api/coin/exchange-coupon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopId: SHOP_ID, couponType })
  });
  if (res.success) {
    toast('兑换成功！');
    loadCoinCenter();
  } else {
    toast(res.message || '兑换失败', true);
  }
}

// 兑换会员（双产品线）：先弹明细确认框，数字实时按后端同口径计算（不预先写死差价）
// 升级折算规则与后端 routes/coin.js 一致：剩余天数 × 当前档每日返币额 抵扣差价
// 采购线：plus 100 币/天（3000/30）、pro 167 币/天（5000/30）
// 点餐线：advanced 50 币/天（1500/30）、premium 80 币/天（2400/30）
const EXCH_DAILY_COIN = { free: 0, plus: 100, pro: 167, basic: 0, advanced: 50, premium: 80 };
async function exchangeMembership(targetLevel, productLine) {
  try {
    const line = productLine === 'purchase' ? 'purchase' : 'pos';
    const res = await api(`/api/coin/status/${SHOP_ID}`);
    const d = res.data || {};
    const ranks = line === 'purchase' ? PURCHASE_RANK : LEVEL_RANK;
    const curLevel = line === 'purchase' ? (d.purchaseLevel || 'free') : (d.memberLevel || 'basic');
    const expireRaw = line === 'purchase' ? d.purchaseExpire : d.memberExpire;
    // 降级一律拒绝（同一产品线内高等级不可降兑）
    if ((ranks[targetLevel] ?? 0) < (ranks[curLevel] ?? 0)) {
      toast('当前已是更高等级，无法降兑', true);
      return;
    }
    const coin = Number(d.dinghengCoin) || 0;
    const expire = expireRaw ? new Date(expireRaw) : null;
    const isActive = expire && expire > new Date();
    const daysLeft = isActive ? Math.max(0, Math.ceil((expire - new Date()) / 86400000)) : 0;

    const cfg = PLAN_CFG[targetLevel];
    const price = cfg.coinCost;
    let offset = 0;
    let payCoin = price;
    // 升级（同线内低档→高档）且当前有效期内：剩余天数 × 当前档每日返币额 抵扣差价
    const isUpgrade = (ranks[targetLevel] ?? 0) > (ranks[curLevel] ?? 0);
    if (isUpgrade && isActive) {
      offset = daysLeft * (EXCH_DAILY_COIN[curLevel] || 0);
      payCoin = Math.max(0, price - offset);
    }
    const after = coin - payCoin;
    const isRenewal = (curLevel === targetLevel && isActive);
    const lineName = line === 'purchase' ? '采购线' : '点餐线';

    // 填充明细字段
    $('exchCurLevel').textContent = `[${lineName}] ${LEVEL_NAME[curLevel] || ''}`;
    if (isRenewal) {
      const afterDays = daysLeft + 30;
      $('exchDaysLeft').innerHTML =
        `当前剩余 ${daysLeft} 天 → 兑换后 ${afterDays} 天` +
        `（<b style="color:#f97316;">+30 天</b>）`;
    } else {
      $('exchDaysLeft').textContent = isActive ? (daysLeft + ' 天') : '未生效/已过期';
    }
    $('exchTargetLevel').textContent = `[${lineName}] ${LEVEL_NAME[targetLevel] || ''}`;
    $('exchMethod').textContent = isRenewal
      ? '续费（在现有有效期上延长 30 天）'
      : (isUpgrade ? '升级（剩余价值折算抵扣差价）' : '新开通（有效期 30 天）');
    $('exchPrice').textContent = `${price} 币`;
    $('exchOffset').innerHTML = offset > 0
      ? `剩余 ${daysLeft} 天 × ${EXCH_DAILY_COIN[curLevel] || 0} 币/天 = 抵扣 <b>${offset}</b> 币`
      : '无';
    $('exchPayCoin').textContent = payCoin;
    $('exchCurBalance').textContent = `${coin} 币`;
    $('exchAfterBalance').innerHTML = after < 0
      ? `${after} 币（余额不足）`
      : `${after} 币`;

    const confirmBtn = $('exchConfirmBtn');
    confirmBtn.disabled = after < 0;
    confirmBtn.textContent = after < 0 ? '鼎恒币不足' : '确认兑换';
    confirmBtn.onclick = () => doExchangeMembership(targetLevel, line);

    $('exchangeConfirmModal').classList.add('show');
  } catch (e) {
    console.error(e);
    toast('获取会员信息失败', true);
  }
}
function closeExchangeConfirm() {
  $('exchangeConfirmModal').classList.remove('show');
}
// 实际提交兑换（明细确认后调用）
async function doExchangeMembership(targetLevel, productLine) {
  const confirmBtn = $('exchConfirmBtn');
  confirmBtn.disabled = true;
  confirmBtn.textContent = '兑换中...';
  try {
    const res = await api('/api/coin/exchange-membership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: SHOP_ID,
        targetLevel,
        productLine: productLine === 'purchase' ? 'purchase' : 'pos'
      })
    });
    if (res.success) {
      closeExchangeConfirm();
      toast(res.data && res.data.message ? res.data.message : '操作成功！');
      loadCoinCenter();
      loadMemberCenter(); // 若停留在会员中心页，同步刷新余额与等级
    } else {
      toast(res.message || '兑换失败', true);
      confirmBtn.disabled = false;
      confirmBtn.textContent = '确认兑换';
    }
  } catch (e) {
    toast(e.message || '兑换失败', true);
    confirmBtn.disabled = false;
    confirmBtn.textContent = '确认兑换';
  }
}
window.exchangeMembership = exchangeMembership;
window.closeExchangeConfirm = closeExchangeConfirm;
window.exchangeCoupon = exchangeCoupon;

/* ===================== 会员中心 ===================== */
// 会员销售页：两线状态卡片 + 鼎恒币兑换专区 + 两条产品线卡片
// 价格/币成本与后端 utils/dhConfig.js 的 POS_PRICING / PURCHASE_PRICING 保持一致
const PLAN_CFG = {
  // 采购线
  plus: { price: 99, coinCost: 3000, productLine: 'purchase' },
  pro: { price: 199, coinCost: 5000, productLine: 'purchase' },
  // 点餐线
  advanced: { price: 39, coinCost: 1500, productLine: 'pos' },
  premium: { price: 79, coinCost: 2400, productLine: 'pos' },
  // 免费档（不可兑换，仅兼容引用）
  basic: { price: 0, coinCost: 0, productLine: 'pos' },
  free: { price: 0, coinCost: 0, productLine: 'purchase' }
};

async function loadMemberCenter() {
  try {
    const res = await api(`/api/coin/status/${SHOP_ID}`);
    const d = res.data || {};
    const level = d.memberLevel || 'basic';                 // 点餐线
    const purLevel = d.purchaseLevel || 'free';             // 采购线
    const posActive = d.membershipActive !== false;
    const purActive = d.purchaseActive !== false;
    const posExpire = d.memberExpire ? new Date(d.memberExpire) : null;
    const purExpire = d.purchaseExpire ? new Date(d.purchaseExpire) : null;
    const purDaysLeft = purExpire ? Math.max(0, Math.ceil((purExpire - new Date()) / 86400000)) : null;

    // 顶部状态卡片：以采购线为主（采购为核心），点餐线状态挂在 title 提示
    $('msLevel').textContent = `🛒 ${LEVEL_NAME[purLevel] || '采购免费版'}`;
    $('msExpire').textContent = (purActive && purExpire) ? fmtTime(d.purchaseExpire).slice(0, 10) : '长期有效';
    $('msDaysLeft').textContent = (purActive && purExpire) ? purDaysLeft + ' 天' : '长期有效';
    const msLevelEl = $('msLevel');
    if (msLevelEl) {
      msLevelEl.title = `点餐线：${LEVEL_NAME[level] || ''}` +
        ((posActive && posExpire) ? `（到期 ${fmtTime(d.memberExpire).slice(0, 10)}）` : '（长期有效）');
    }

    // 体验期倒计时胶囊（新商家赠送 30 天进阶 + 省钱卡体验）
    const isTrial = (d.memberIsTrial === true || d.purchaseIsTrial === true) && !!purExpire;
    $('msTrialPill').style.display = isTrial ? 'flex' : 'none';
    if (isTrial) $('msTrialDays').textContent = purDaysLeft;

    // 兑换专区：余额 + 四条兑换按钮状态（采购线优先）
    const coin = d.dinghengCoin ?? 0;
    $('ezCoinBalance').textContent = coin;
    $('ezCoinBalance').dataset.loaded = '1'; // 标记已加载，供 waitForCoinLoaded 检测
    updateRenewBtn('ezBtnPlus', 'plus', 'purchase', coin, purLevel, purActive);
    updateRenewBtn('ezBtnPro', 'pro', 'purchase', coin, purLevel, purActive);
    updateRenewBtn('ezBtnAdvanced', 'advanced', 'pos', coin, level, posActive);
    updateRenewBtn('ezBtnPremium', 'premium', 'pos', coin, level, posActive);
  } catch (e) {
    console.error(e);
    toast('加载会员数据失败', true);
  }
}

// 币兑增值包货架（阶段3）：限时功能包，小额币兑换，不影响会员等级
function renderAddonGrid(d) {
  const grid = $('addonGrid');
  if (!grid) return;
  const addons = (d && d.addons) || [];
  const active = (d && d.activeAddons) || [];
  const coin = Number(d && d.dinghengCoin) || 0;
  if (!addons.length) {
    grid.innerHTML = '<div class="empty">暂无可兑换的增值包</div>';
    return;
  }
  const activeMap = {};
  active.forEach(a => { activeMap[a.addonKey] = a.expireAt; });
  grid.innerHTML = addons.map(a => {
    const notEnough = coin < a.coinPrice;
    const exp = activeMap[a.key];
    const tip = exp
      ? `<div style="font-size:12px;color:#16a34a;margin:4px 0;">已生效 · 至 ${fmtTime(exp).slice(0, 10)}</div>`
      : '';
    return `<div class="ez-card">
      <div class="ez-badge">${a.productLine === 'purchase' ? '🛒 采购' : '🍴 点餐'}</div>
      <div class="ez-name">${esc(a.name)}</div>
      <div class="ez-coin">鼎恒币兑换仅需</div>
      <div class="ez-coin-num">${a.coinPrice}<small> 币</small></div>
      <div class="ez-tip">${esc(a.desc || '')} · ${a.days} 天</div>
      ${tip}
      <button class="ez-btn" ${notEnough ? 'disabled' : ''} onclick="exchangeAddon('${esc(a.key)}')">${notEnough ? '鼎恒币不足' : (exp ? '续兑叠加' : '立即兑换')}</button>
    </div>`;
  }).join('');
}

// 兑换增值包
async function exchangeAddon(addonKey) {
  try {
    const res = await api('/api/coin/exchange-addon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addonKey })
    });
    if (res.success) {
      toast((res.data && res.data.message) || '兑换成功！');
      loadCoinCenter();
      loadMemberCenter();
    } else {
      toast(res.message || '兑换失败', true);
    }
  } catch (e) {
    toast(e.message || '兑换失败', true);
  }
}
window.exchangeAddon = exchangeAddon;

/* ===================== 会员现金购卡（线下收款 + 客服确认开通） ===================== */
// 服务电话：与后端 routes/membership.js SERVICE_PHONE 保持一致
const MEMBER_SERVICE_PHONE = '400-888-6666';
let _cashBuyLevel = 'advanced';
let _cashBuyMonths = 1;
let _cashPayMethod = 'cash';        // cash 线下转账 / wechat 微信扫码
let _wechatPayEnabled = null;       // 后端是否已配置微信支付（null=未查询）
let _payPollTimer = null;
let _payPollOrderId = null;

// 查询微信支付是否可用（未配置则隐藏微信入口）
async function fetchWechatPayEnabled() {
  if (_wechatPayEnabled !== null) return _wechatPayEnabled;
  try {
    const r = await api('/api/membership/pay-config');
    _wechatPayEnabled = !!(r && r.data && r.data.wechatPayEnabled);
  } catch (e) { _wechatPayEnabled = false; }
  return _wechatPayEnabled;
}

function renderCashTotal() {
  const price = (PLAN_CFG[_cashBuyLevel] || {}).price || 0;
  $('cbTotal').textContent = '¥' + (price * _cashBuyMonths).toFixed(2);
}

// 切换支付方式（影响按钮文案与提示）
function setCashPayMethod(m) {
  _cashPayMethod = (m === 'wechat') ? 'wechat' : 'cash';
  document.querySelectorAll('#cbPayMethods .cb-month-chip').forEach(c => c.classList.toggle('active', c.dataset.pay === _cashPayMethod));
  if ($('cbSubmitTip')) {
    $('cbSubmitTip').textContent = (_cashPayMethod === 'wechat')
      ? '提交后生成微信支付二维码，扫码支付成功后会员立即生效。'
      : '提交后订单进入待支付状态，请按客服指引完成付款；客服确认收款后会员立即生效。';
  }
  const btn = $('cbSubmitBtn');
  if (btn) btn.textContent = (_cashPayMethod === 'wechat') ? '生成支付二维码' : '提交订单';
}

// 打开购卡弹窗（level: advanced / premium）
async function openCashBuy(level) {
  const cfg = PLAN_CFG[level];
  if (!cfg) { toast('会员等级无效', true); return; }
  _cashBuyLevel = level;
  _cashBuyMonths = 1;
  $('cbLevel').textContent = LEVEL_NAME[level];
  $('cbUnitPrice').textContent = `¥${cfg.price}/月`;
  $('cbNote').value = '';
  document.querySelectorAll('#cbMonths .cb-month-chip').forEach(c => c.classList.toggle('active', c.dataset.m === '1'));
  renderCashTotal();
  // 微信支付可用时展示入口（默认选中微信），否则仅线下转账
  const wechatOn = await fetchWechatPayEnabled();
  $('cbPayWechat').style.display = wechatOn ? '' : 'none';
  setCashPayMethod(wechatOn ? 'wechat' : 'cash');
  $('cashBuyForm').style.display = '';
  $('cashBuyResult').style.display = 'none';
  $('cashBuyWechat').style.display = 'none';
  $('cbSubmitBtn').disabled = false;
  $('cashBuyModal').classList.add('show');
}

function closeCashBuy() { stopWechatPoll(); $('cashBuyModal').classList.remove('show'); }
function closeWechatPay() { stopWechatPoll(); $('cashBuyModal').classList.remove('show'); }

// 月数选择
document.querySelectorAll('#cbMonths .cb-month-chip').forEach(chip => {
  chip.onclick = () => {
    _cashBuyMonths = parseInt(chip.dataset.m, 10) || 1;
    document.querySelectorAll('#cbMonths .cb-month-chip').forEach(c => c.classList.toggle('active', c === chip));
    renderCashTotal();
  };
});

// 支付方式选择
document.querySelectorAll('#cbPayMethods .cb-month-chip').forEach(chip => {
  chip.onclick = () => setCashPayMethod(chip.dataset.pay);
});

// 提交购卡：微信扫码 或 线下转账
async function submitCashOrder() {
  const btn = $('cbSubmitBtn');
  btn.disabled = true;
  btn.textContent = '提交中...';

  if (_cashPayMethod === 'wechat') {
    const res = await api('/api/membership/wechat-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: _cashBuyLevel,
        productLine: (PLAN_CFG[_cashBuyLevel] || {}).productLine || 'pos',
        months: _cashBuyMonths,
        buyerNote: $('cbNote').value.trim()
      })
    });
    if (res.success && res.codeUrl) {
      showWechatQr(res.data, res.codeUrl);
    } else {
      toast(res.message || '微信下单失败', true);
      btn.disabled = false;
      setCashPayMethod('wechat');
    }
    return;
  }

  // 线下转账（原流程）
  const res = await api('/api/membership/cash-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      level: _cashBuyLevel,
      productLine: (PLAN_CFG[_cashBuyLevel] || {}).productLine || 'pos',
      months: _cashBuyMonths,
      buyerNote: $('cbNote').value.trim()
    })
  });
  if (res.success && res.data) {
    $('cbResultNo').textContent = res.data.orderNo || '-';
    $('cbResultPhone').textContent = res.servicePhone || MEMBER_SERVICE_PHONE;
    $('cashBuyForm').style.display = 'none';
    $('cashBuyResult').style.display = '';
  } else {
    toast(res.message || '提交失败', true);
    btn.disabled = false;
    btn.textContent = '提交订单';
  }
}
$('cbSubmitBtn').onclick = submitCashOrder;

// 展示微信支付二维码并轮询支付结果
function showWechatQr(order, codeUrl) {
  $('cashBuyForm').style.display = 'none';
  $('cashBuyResult').style.display = 'none';
  $('cashBuyWechat').style.display = '';
  $('cbQrTotal').textContent = '¥' + Number((order && order.amountRmb) || 0).toFixed(2);
  $('cbQrImg').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(codeUrl);
  $('cbQrStatus').textContent = '等待支付…';
  startWechatPoll(order._id);
}

function startWechatPoll(orderId) {
  stopWechatPoll();
  _payPollOrderId = orderId;
  const tick = async () => {
    if (_payPollOrderId !== orderId) return;
    const r = await api('/api/membership/wechat-orders/' + orderId + '/status');
    if (_payPollOrderId !== orderId) return;
    if (r && r.success && r.data) {
      if (r.data.payStatus === 'paid') {
        stopWechatPoll();
        $('cbQrStatus').textContent = '✅ 支付成功，会员已开通';
        toast('支付成功，会员已开通');
        try { loadCoinCenter(); } catch (e) {}
        try { loadMemberCenter(); } catch (e) {}
        return;
      }
      if (r.data.payStatus === 'closed' || r.data.status === 'cancelled') {
        stopWechatPoll();
        $('cbQrStatus').textContent = '订单已关闭，请重新下单';
        return;
      }
    }
    _payPollTimer = setTimeout(tick, 3000);
  };
  _payPollTimer = setTimeout(tick, 3000);
}

function stopWechatPoll() {
  if (_payPollTimer) { clearTimeout(_payPollTimer); _payPollTimer = null; }
  _payPollOrderId = null;
}

// 我的购卡订单
function openCashOrders() {
  closeCashBuy();
  $('cashOrdersModal').classList.add('show');
  loadCashOrders();
}
function closeCashOrders() { $('cashOrdersModal').classList.remove('show'); }

async function loadCashOrders() {
  const box = $('cashOrderList');
  box.innerHTML = '<div class="cb-tip" style="text-align:center;">加载中...</div>';
  const res = await api('/api/membership/cash-orders');
  if (!res.success) {
    box.innerHTML = `<div class="cb-tip" style="text-align:center;">加载失败：${esc(res.message || '未知错误')}</div>`;
    return;
  }
  const list = res.data || [];
  if (!list.length) {
    box.innerHTML = '<div class="cb-tip" style="text-align:center;">暂无购卡订单</div>';
    return;
  }
  const STATUS = { pending: '待支付', paid: '已开通', cancelled: '已取消' };
  const CHANNEL = { cash: '线下转账', wechat: '微信支付' };
  box.innerHTML = list.map(o => {
    const refunded = o.refundStatus === 'refunded' || o.payStatus === 'refunded';
    const statusText = refunded ? '已退款' : (STATUS[o.status] || esc(o.status));
    const canCancel = o.status === 'pending';
    const canRefund = o.payChannel === 'wechat' && o.payStatus === 'paid' && !refunded;
    return `
    <div class="cb-order-item">
      <div class="cb-order-head">
        <span class="cb-order-no">${esc(o.orderNo)}</span>
        <span class="cb-status ${refunded ? 'cancelled' : esc(o.status)}">${statusText}</span>
      </div>
      <div class="cb-order-meta"><span>${CHANNEL[o.payChannel] || '线下转账'} · ${esc(LEVEL_NAME[o.level] || o.level)} · ${o.months} 个月</span><span>¥${Number(o.amountRmb || 0).toFixed(2)}</span></div>
      <div class="cb-order-meta"><span>下单 ${fmtTime(o.createdAt)}</span>${o.paidAt ? `<span>开通 ${fmtTime(o.paidAt)}</span>` : ''}</div>
      ${o.payChannel === 'wechat' && o.splitStatus === 'done' ? '<div class="cb-order-meta"><span>已云分账（平台抽佣 + 供应商）</span></div>' : ''}
      ${o.buyerNote ? `<div class="cb-order-meta"><span>备注：${esc(o.buyerNote)}</span></div>` : ''}
      ${canCancel ? `<button class="cb-order-cancel" data-id="${esc(String(o._id))}">取消订单</button>` : ''}
      ${canRefund ? `<button class="cb-order-cancel" data-refund="${esc(String(o._id))}">申请退款</button>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-id]').forEach(b => { b.onclick = () => cancelCashOrder(b.dataset.id); });
  box.querySelectorAll('[data-refund]').forEach(b => { b.onclick = () => refundWechatOrder(b.dataset.refund); });
}

async function cancelCashOrder(id) {
  if (!confirm('确定取消该待支付订单？')) return;
  const res = await api('/api/membership/cash-orders/' + id + '/cancel', { method: 'POST' });
  if (res.success) {
    toast('订单已取消');
    loadCashOrders();
  } else {
    toast(res.message || '取消失败', true);
  }
}

// 微信支付订单退款（已分账会先回退分账再原路退款）
async function refundWechatOrder(id) {
  if (!confirm('确定申请退款？如已云分账，将先回退分账再原路退款。')) return;
  const res = await api('/api/membership/wechat-orders/' + id + '/refund', { method: 'POST' });
  if (res.success) {
    toast('退款已发起');
    loadCashOrders();
  } else {
    toast(res.message || '退款失败', true);
  }
}

/* ===================== 权益对比（双产品线，与后端 dhConfig 保持一致） ===================== */
// 采购线：free / plus / pro
const PURCHASE_BENEFIT_ROWS = [
  { label: '月费', vals: ['免费', '¥99/月', '¥199/月'] },
  { label: '鼎恒币兑换', vals: ['—', '3000 币', '5000 币'] },
  { label: '采购返币', vals: ['2 元=1 币', '1 元=1 币', '1 元=1 币'] },
  { label: '可兑采购券面额', vals: ['10-30 元', '10-100 元', '10-200 元'] },
  { label: '采购商城 / 下单收货', vals: [true, true, true] },
  { label: '基础补货建议', vals: [true, true, true] },
  { label: '30 天智能补货预测', vals: [false, true, true] },
  { label: '采购价监控', vals: [false, true, true] },
  { label: '比价 / 降价提醒', vals: [false, false, true] },
  { label: '优先配送', vals: [false, false, true] }
];
// 点餐线：basic / advanced / premium
const POS_BENEFIT_ROWS = [
  { label: '月费', vals: ['免费', '¥39/月', '¥79/月'] },
  { label: '鼎恒币兑换', vals: ['—', '1500 币', '2400 币'] },
  { label: '扫码点餐 / 菜单 / 桌台 / 订单', vals: [true, true, true] },
  { label: '后厨语音看单 / 大屏展示', vals: [true, true, true] },
  { label: '基础装修', vals: [true, true, true] },
  { label: '顾客积分系统', vals: [true, true, true] },
  { label: '基础营业统计', vals: [true, true, true] },
  { label: '满减活动', vals: [false, true, true] },
  { label: '经营报表', vals: [false, true, true] },
  { label: '高级装修（主题 / 头图 LOGO）', vals: [false, true, true] },
  { label: '顾客储值', vals: [false, true, true] },
  { label: '分类折扣 / 充值送', vals: [false, false, true] },
  { label: '顾客画像 / 损耗分析', vals: [false, false, true] },
  { label: '高级营销工具', vals: [false, false, true] }
];

function openBenefitCompare() {
  const cell = (v) => v === true
    ? '<span class="bc-yes">✓</span>'
    : (v === false ? '<span class="bc-no">—</span>' : `<span class="bc-val">${esc(v)}</span>`);
  const renderTable = (rows, heads) => {
    const head = `<tr><th>权益</th><th>${heads[0]}</th><th class="hl">${heads[1]}</th><th class="hl">${heads[2]}</th></tr>`;
    const body = rows.map(r => `<tr><td>${esc(r.label)}</td>${r.vals.map(cell).join('')}</tr>`).join('');
    return `<table class="bc-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  };
  const purchaseTable = '<div class="bc-section-title">🛒 采购省钱卡（采购为核心）</div>' +
    renderTable(PURCHASE_BENEFIT_ROWS, ['采购免费版', '采购省钱卡', '采购省钱卡Pro']);
  const posTable = '<div class="bc-section-title" style="margin-top:18px;">🍴 扫码点餐（独立产品线）</div>' +
    renderTable(POS_BENEFIT_ROWS, ['点餐免费版', '点餐进阶版', '点餐尊享版']);
  $('benefitCompareBody').innerHTML = purchaseTable + posTable;
  $('benefitCompareModal').classList.add('show');
}
function closeBenefitCompare() { $('benefitCompareModal').classList.remove('show'); }

window.openCashBuy = openCashBuy;
window.closeCashBuy = closeCashBuy;
window.openCashOrders = openCashOrders;
window.closeCashOrders = closeCashOrders;
window.openBenefitCompare = openBenefitCompare;
window.closeBenefitCompare = closeBenefitCompare;

// 底部"会员兑换记录"→ 跳到鼎恒币中心流水
function goCoinHistory() {
  switchTab('coin');
}
window.goCoinHistory = goCoinHistory;

/* ===================== 采购商城 ===================== */
// 两段式架构：供应商店铺列表 → 进入店铺 → 店内选购 → 结算
// 购物车只统计当前这家供应商的商品，切换店铺自动清空，绝不跨供应商混加
let _mallSuppliers = [];      // 供应商店铺列表
let _mallCurrentStore = null; // 当前进入的供应商对象
let _mallProducts = [];       // 当前店铺的商品
let _mallAllProducts = [];    // 全平台上架商品缓存（用于跨店铺关键词搜索商品名）
let _mallCategory = 'all';    // 当前分类筛选
let _mallCart = [];           // 当前店铺采购车 [{ productId, name, unit, quantity, unitPrice, category, coinMultiplier }]
let _mallPendingQty = {};     // 商品卡片「本次拟加入数量」映射 productId → N（与采购车数量解耦，加入后重置为 1）
let _mallCoupons = [];        // 当前商家可用抵用券（status=unused 且未过期）
let _mallMemberLevel = 'basic'; // 当前商家会员等级（用于横幅差异化文案）
let _mallSearchKey = '';      // 店铺列表搜索关键词
let _mallStoreCat = 'all';    // 店铺列表品类筛选标签
let _mallSearchTimer = null;  // 搜索防抖计时器（300ms）

// 供应商名兜底（取不到显示"平台直供"，绝不出现 undefined/????）
function getStoreName(s) {
  if (!s) return '平台直供';
  return (s.name && String(s.name).trim()) || '平台直供';
}
// 店铺首字（用于 logo 图标）
function storeInitial(name) {
  const ch = String(name || '').trim().charAt(0);
  return ch || '供';
}
// 主营品类文案
function storeCatsText(s) {
  const cats = s && Array.isArray(s.categories) ? s.categories : [];
  if (!cats.length) return '综合供应商';
  return cats.join(' · ');
}
// 起送价（老数据缺字段时兜底 300，绝不出现 undefined）
function storeMinOrder(s) {
  const v = Number(s && s.minOrderAmount);
  return v > 0 ? v : 300;
}
// 券是否可用（未使用 + 未过期）
function couponUsable(c) {
  return c && c.status === 'unused' && c.expireDate && new Date(c.expireDate) > new Date();
}

// 商城入口：拉取供应商列表 + 全平台上架商品 + 商家可用券，默认显示店铺列表层
let _mallLoaded = false;
async function loadMall(force = false) {
  // 已加载过则直接复用缓存，秒开（商品/供应商数据量较大，避免重复请求）
  if (_mallLoaded && !force) return;
  try {
    const [supRes, prodRes, statusRes] = await Promise.all([
      api('/api/suppliers'),
      api('/api/supply-products?status=上架'),
      api(`/api/coin/status/${SHOP_ID}`)
    ]);
    _mallSuppliers = (supRes.data || []).filter(s => s && s.name);
    _mallAllProducts = (prodRes.data || []).filter(p => p && p.name);
    _mallCoupons = ((statusRes.data && statusRes.data.coupons) || []).filter(couponUsable);
    _mallMemberLevel = (statusRes.data && statusRes.data.memberLevel) || 'basic';
    _mallCurrentStore = null;
    _mallCart = [];
    _mallPendingQty = {};
    _mallCategory = 'all';
    _mallSearchKey = '';
    _mallStoreCat = 'all';
    _mallLoaded = true;
    renderMallCoinBanner();
    renderMallProgressGuide();
    renderMallStoreCatTabs();
    renderStoreList();
    showStoreListView();
  } catch (e) {
    console.error(e);
    toast('加载采购商城失败', true);
  }
}

// 本月采购已得鼎恒币 + 从未采购空状态引导卡（引导卡可关闭，localStorage 按店铺记忆）
async function renderMallProgressGuide() {
  const box = $('mallProgress');
  const guide = $('mallGuide');
  const guideKey = 'guide_dismiss_' + SHOP_ID + '_mall';
  if (guide && !guide._bound) {
    guide._bound = true;
    guide.querySelector('.guide-close').onclick = () => {
      localStorage.setItem(guideKey, '1');
      guide.style.display = 'none';
    };
  }
  try {
    const res = await api(`/api/coin/month-progress/${SHOP_ID}`);
    if (!res.success || !res.data) { if (box) box.style.display = 'none'; return; }
    const d = res.data;
    if (box) {
      box.style.display = 'block';
      $('mpEarned').textContent = d.monthEarned || 0;
      // 动态展示当前采购线档位的实际得币率（免费版 0.5 / 省钱卡·Pro 1.0）
      const rateEl = $('mpRate');
      if (rateEl) {
        const rate = COIN_RATE[_mallMemberLevel] ?? 0.5;
        rateEl.textContent = `当前 1 元 = ${rate} 鼎恒币 · `;
      }
    }
    // 空状态引导：从未采购且未手动关闭时展示；有采购记录后自动消失
    if (guide) {
      guide.style.display = (!d.hasPurchased && localStorage.getItem(guideKey) !== '1') ? 'flex' : 'none';
    }
  } catch (e) {
    if (box) box.style.display = 'none';
  }
}

// 顶部鼎恒币激励横幅：统一展示（按规则只保留指定文案，不出现"1元=1币"绝对表述）
function renderMallCoinBanner() {
  const head = `🎁 采购即得鼎恒币：每笔消费都可获得鼎恒币，币可兑采购抵用券、兑会员月卡`;
  const el = $('mallCoinBanner');
  el.innerHTML = head;
  el.classList.remove('basic');
}

// 店铺列表品类筛选标签栏 + 搜索框绑定（300ms 防抖，回车立即触发）
function renderMallStoreCatTabs() {
  const tabs = [
    { label: '全部', dc: 'all' },
    { label: '蔬菜', dc: '蔬菜' },
    { label: '肉类', dc: '肉类' },
    { label: '冻品', dc: '冻品' },
    { label: '海鲜', dc: '海鲜' },
    { label: '粮油酱料', dc: '粮油酱料' },
    { label: '一次性用品', dc: '一次性用品' }
  ];
  $('mallCatTabs').innerHTML = tabs.map(t => `
    <button class="mall-cat-tab ${t.dc === _mallStoreCat ? 'active' : ''}" onclick="setMallStoreCat('${t.dc}')">${t.label}</button>
  `).join('');
  const si = $('mallSearchInput');
  si.value = _mallSearchKey;
  si.oninput = (e) => {
    _mallSearchKey = e.target.value.trim();
    // 300ms 防抖：输入过程中不频繁触发，停止输入后统一搜索一次
    if (_mallSearchTimer) clearTimeout(_mallSearchTimer);
    _mallSearchTimer = setTimeout(renderStoreList, 300);
  };
  // 回车立即触发搜索（取消防抖等待）
  si.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (_mallSearchTimer) { clearTimeout(_mallSearchTimer); _mallSearchTimer = null; }
      _mallSearchKey = si.value.trim();
      renderStoreList();
    }
  };
}
function setMallStoreCat(cat) {
  _mallStoreCat = cat || 'all';
  renderMallStoreCatTabs();
  renderStoreList();
}

function showStoreListView() {
  $('mallStoreList').style.display = 'block';
  $('mallStoreDetail').style.display = 'none';
}
function showStoreDetailView() {
  $('mallStoreList').style.display = 'none';
  $('mallStoreDetail').style.display = 'block';
}

// 品类徽章配色（按品类返回彩色小徽章样式）
const CAT_BADGE_COLORS = {
  '蔬菜':   { bg: '#dcfce7', fg: '#15803d' },
  '肉类':   { bg: '#fee2e2', fg: '#b91c1c' },
  '冻品':   { bg: '#e0f2fe', fg: '#0369a1' },
  '海鲜':   { bg: '#cffafe', fg: '#0e7490' },
  '粮油酱料': { bg: '#fef3c7', fg: '#b45309' },
  '一次性用品': { bg: '#f3e8ff', fg: '#7c3aed' }
};
function catBadgeStyle(cat) {
  const c = CAT_BADGE_COLORS[cat] || { bg: '#f3f4f6', fg: '#4b5563' };
  return `background:${c.bg};color:${c.fg};`;
}

// 渲染供应商店铺列表（支持搜索：店名 + 商品名 + 品类筛选）
function renderStoreList() {
  const grid = $('storeGrid');
  if (!_mallSuppliers.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">暂无供应商店铺</div>`;
    return;
  }
  const key = _mallSearchKey.toLowerCase();
  // 品类筛选标签仅作用于店铺列表（商品结果按关键词匹配，不受品类标签影响）
  const matchCat = (s) => {
    if (_mallStoreCat === 'all') return true;
    const cats = Array.isArray(s.categories) ? s.categories : [];
    return cats.includes(_mallStoreCat);
  };

  // 匹配店铺：店名或主营品类含关键词 + 品类筛选
  const matchStore = (s) => {
    if (!key) return true;
    const cats = Array.isArray(s.categories) ? s.categories : [];
    return String(s.name || '').toLowerCase().includes(key)
      || cats.some(c => String(c).toLowerCase().includes(key));
  };
  const matchedStores = _mallSuppliers.filter(s => matchStore(s) && matchCat(s));

  // 匹配商品：商品名含关键词（跨全部店铺，搜索商品时一并展示）
  let matchedProducts = [];
  if (key) {
    matchedProducts = _mallAllProducts.filter(p => {
      const nameOk = String(p.name || '').toLowerCase().includes(key);
      const descOk = p.description && String(p.description).toLowerCase().includes(key);
      return nameOk || descOk;
    });
  }

  // 无关键词：仅显示品类筛选后的店铺列表
  if (!key) {
    if (!matchedStores.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">该分类下暂无供应商店铺</div>`;
      return;
    }
    grid.innerHTML = matchedStores.map(s => storeCardHtml(s)).join('');
    return;
  }

  // 有关键词：商品结果 + 店铺结果
  let html = '';
  if (matchedProducts.length) {
    html += `
      <div class="mall-result-section" style="grid-column:1/-1;">
        <div class="mall-result-title">📦 匹配商品 <span class="mall-result-count">${matchedProducts.length}</span></div>
        <div class="mall-product-result-grid">
          ${matchedProducts.map(p => mallSearchProductCardHtml(p)).join('')}
        </div>
      </div>`;
  }
  if (matchedStores.length) {
    html += `
      <div class="mall-result-section" style="grid-column:1/-1;">
        <div class="mall-result-title">🏪 匹配店铺 <span class="mall-result-count">${matchedStores.length}</span></div>
        <div class="store-grid">
          ${matchedStores.map(s => storeCardHtml(s)).join('')}
        </div>
      </div>`;
  }
  if (!matchedProducts.length && !matchedStores.length) {
    html = `<div class="empty" style="grid-column:1/-1;">没有匹配的「${esc(_mallSearchKey)}」店铺或商品</div>`;
  }
  grid.innerHTML = html;
}

// 店铺卡片 HTML（抽取为函数，供搜索结果与列表复用）
function storeCardHtml(s) {
  const minOrder = storeMinOrder(s);
  const cats = Array.isArray(s.categories) ? s.categories.slice(0, 4) : [];
  const catBadges = cats.length
    ? cats.map(c => `<span class="store-cat-badge" style="${catBadgeStyle(c)}">${esc(c)}</span>`).join('')
    : `<span class="store-cat-badge" style="${catBadgeStyle('')}">综合供应商</span>`;
  return `
    <div class="store-card" onclick="enterStore('${esc(String(s._id))}')">
      <div class="store-logo">${esc(storeInitial(s.name))}</div>
      <div class="store-info">
        <div class="store-name">${esc(s.name)}</div>
        <div class="store-cats">${catBadges}</div>
        <div class="store-meta">
          <span class="store-minorder">¥${minOrder} 起送</span>
          <span class="store-enter">进入店铺 ›</span>
        </div>
      </div>
    </div>
  `;
}

// 搜索结果商品卡片：显示商品名、价格、所属店铺（可点进店）、品类、得币倍率徽章、加购按钮
function mallSearchProductCardHtml(p) {
  const sup = p.supplierId;
  const supplierName = (sup && typeof sup === 'object' && sup.name) ? sup.name : (typeof sup === 'string' ? sup : '未知店铺');
  const supplierId = (sup && typeof sup === 'object' && sup._id) ? sup._id : (typeof sup === 'string' ? sup : '');
  const qtyVal = _mallPendingQty[p._id] || 1;
  const unit = p.unit || '个';
  const mult = Number(p.coinMultiplier);
  const multVal = (!isNaN(mult) && mult > 0) ? mult : 1;
  const coinBadge = multVal > 1
    ? `<span class="coin-boost">🪙 ${multVal} 倍得币</span>`
    : `<span class="coin-boost coin-boost-normal">🪙 1 倍得币</span>`;
  const catBadge = p.category
    ? `<span class="store-cat-badge" style="${catBadgeStyle(p.category)}">${esc(p.category)}</span>`
    : '';
  return `
    <div class="product-card mall-product-result">
      <div class="product-img">${p.image ? `<img src="${esc(p.image)}" alt="" onerror="this.parentElement.innerHTML='📦'">` : '📦'}</div>
      <div class="product-body">
        <div class="product-name">${esc(p.name)}</div>
        <div class="product-store-link">
          <span class="product-store-label">所属店铺：</span>
          <a class="product-store-name" onclick="enterStore('${esc(String(supplierId))}');event.stopPropagation();">${esc(supplierName)} ›</a>
        </div>
        <div class="product-tags">${catBadge}${coinBadge}</div>
        <div class="product-price">¥${Number(p.salePrice != null ? p.salePrice : p.unitPrice).toFixed(2)}<small> 售价 / ${esc(unit)}</small></div>
        <div class="product-actions">
          <div class="qty-ctrl">
            <button onclick="adjustQty('${p._id}', -1)">−</button>
            <input type="number" min="1" value="${qtyVal}" data-pid="${p._id}" oninput="setQty('${p._id}', this.value)">
            <button onclick="adjustQty('${p._id}', 1)">+</button>
          </div>
          <button class="btn-cart" data-add="${p._id}" onclick="searchAddToCart('${p._id}','${esc(String(supplierId))}')">加入采购车</button>
        </div>
      </div>
    </div>
  `;
}

// 搜索结果加购：若不在该店铺则先切换店铺（采购车按店铺隔离，切换会清空旧车），再加入采购车
async function searchAddToCart(productId, supplierId) {
  if (!supplierId) { toast('店铺信息缺失', true); return; }
  if (!_mallCurrentStore || String(_mallCurrentStore._id) !== String(supplierId)) {
    await enterStore(supplierId);
  }
  addToCart(productId);
}

// 进入某家供应商店铺（同 section 切换，不跳转新页面）
async function enterStore(supplierId) {
  const s = _mallSuppliers.find(x => String(x._id) === String(supplierId));
  if (!s) { toast('店铺不存在', true); return; }
  _mallCurrentStore = s;
  _mallCart = [];
  _mallPendingQty = {};
  _mallCategory = 'all';
  $('mallStoreName').textContent = s.name;
  $('mallProductsTitle').textContent = s.name + ' · 店铺商品';
  $('cartStoreName').textContent = s.name;
  if ($('mCartStoreName')) $('mCartStoreName').textContent = s.name;
  // 渲染供应商配送时段公告（留空则隐藏）
  const noticeBox = $('mallDeliveryNotice');
  if (noticeBox) {
    const text = (s.deliveryNotice || '').trim();
    if (text) {
      noticeBox.innerHTML = `<span class="mdn-label">配送说明：</span>${esc(text)}`;
      noticeBox.style.display = 'flex';
    } else {
      noticeBox.innerHTML = '';
      noticeBox.style.display = 'none';
    }
  }
  renderMallCatNav();
  try {
    const res = await api(`/api/supply-products?status=上架&supplierId=${encodeURIComponent(supplierId)}`);
    _mallProducts = res.data || [];
  } catch (e) {
    _mallProducts = [];
  }
  renderStoreProducts();
  renderCart();
  showStoreDetailView();
}

// 返回店铺列表（清空当前店铺采购车）
function backToStoreList() {
  _mallCurrentStore = null;
  _mallCart = [];
  _mallPendingQty = {};
  _mallSelectedCouponId = '';
  _mallProducts = [];
  const noticeBox = $('mallDeliveryNotice');
  if (noticeBox) { noticeBox.innerHTML = ''; noticeBox.style.display = 'none'; }
  closeMallCartDrawer();
  updateMallFloatBar(0, 0, 0, false);
  showStoreListView();
}
$('mallBackToList').onclick = backToStoreList;

// 左侧分类导航
function renderMallCatNav() {
  const cats = [
    { label: '全部', dc: 'all' },
    { label: '蔬菜', dc: '蔬菜' },
    { label: '肉类', dc: '肉类' },
    { label: '冻品', dc: '冻品' },
    { label: '海鲜', dc: '海鲜' },
    { label: '粮油酱料', dc: '粮油酱料' },
    { label: '一次性用品', dc: '一次性用品' }
  ];
  $('mallCatNav').innerHTML = cats.map(c => `
    <button class="mall-cat-btn ${c.dc === _mallCategory ? 'active' : ''}" onclick="setMallCategory('${c.dc}')">${c.label}</button>
  `).join('');
}
function setMallCategory(cat) {
  _mallCategory = cat || 'all';
  renderMallCatNav();
  renderStoreProducts();
}

// 中间商品网格（按当前分类过滤，分类只影响展示不影响价格/起送价）
// 双档次蔬菜支持：按商品名 + 档次排序，使同名蔬菜的实惠/精品档相邻展示并带档次标签
function renderStoreProducts() {
  const grid = $('productGrid');
  const raw = _mallCategory === 'all'
    ? _mallProducts
    : _mallProducts.filter(p => p.category === _mallCategory);
  // 排序：先按商品名升序，再按档次（standard 实惠档 < premium 精品档），使同名双档蔬菜相邻
  const gradeRank = g => (g === 'standard' ? 0 : (g === 'premium' ? 1 : 2));
  const list = raw.slice().sort((a, b) => {
    const nameCmp = String(a.name || '').localeCompare(String(b.name || ''), 'zh');
    if (nameCmp !== 0) return nameCmp;
    return gradeRank(a.grade) - gradeRank(b.grade);
  });
  if (!list.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">${_mallCategory === 'all' ? '该店铺暂无上架商品' : `「${_mallCategory}」分类下暂无商品`}</div>`;
    return;
  }
  grid.innerHTML = list.map(p => {
    const qtyVal = _mallPendingQty[p._id] || 1;
    const unit = p.unit || '个';
    const desc = p.description ? `<div class="product-supplier">${esc(p.description)}</div>` : '';
    // 双档次蔬菜标签：实惠档/精品档
    const gradeTag = p.grade === 'standard'
      ? `<span class="mall-grade-tag standard">实惠</span>`
      : (p.grade === 'premium' ? `<span class="mall-grade-tag premium">精品</span>` : '');
    // 保鲜期冻结提示：商品价格更新中时禁用加入采购车
    const frozen = !!p.priceFrozen;
    const cartBtn = frozen
      ? `<button class="btn-cart btn-cart-frozen" disabled>价格更新中</button>`
      : `<button class="btn-cart" data-add="${p._id}" onclick="addToCart('${p._id}')">加入采购车</button>`;
    // 品类得币倍率标注：接口返回 coinMultiplier（未配置默认 1）；>1 高亮激励，=1 普通展示
    const coinMult = Number(p.coinMultiplier);
    const multVal = (!isNaN(coinMult) && coinMult > 0) ? coinMult : 1;
    const coinBadge = multVal > 1
      ? `<div class="coin-boost">🪙 该品类 ${multVal} 倍得币</div>`
      : `<div class="coin-boost coin-boost-normal">🪙 该品类 1 倍得币</div>`;
    return `
      <div class="product-card${frozen ? ' product-card-frozen' : ''}">
        <div class="product-img">${p.image ? `<img src="${esc(p.image)}" alt="" onerror="this.parentElement.innerHTML='📦'">` : '📦'}</div>
        <div class="product-body">
          <div class="product-name">${esc(p.name)}${gradeTag}</div>
          <div class="product-category">规格：${esc(unit)}${p.category ? ' · ' + esc(p.category) : ''}</div>
          ${coinBadge}
          <div class="product-price">¥${Number(p.salePrice != null ? p.salePrice : p.unitPrice).toFixed(2)}<small> 售价</small></div>
          ${desc}
          <div class="product-actions">
            <div class="qty-ctrl">
              <button onclick="adjustQty('${p._id}', -1)"${frozen ? ' disabled' : ''}>−</button>
              <input type="number" min="1" value="${qtyVal}" data-pid="${p._id}" oninput="setQty('${p._id}', this.value)"${frozen ? ' disabled' : ''}>
              <button onclick="adjustQty('${p._id}', 1)"${frozen ? ' disabled' : ''}>+</button>
            </div>
            ${cartBtn}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// 数量加减器：仅调整商品卡片「本次拟加入数量」，不直接改采购车（加入动作由 addToCart 完成）
function adjustQty(productId, delta) {
  const cur = Number(_mallPendingQty[productId]) || 1;
  let qty = cur + delta;
  if (qty < 1) qty = 1;
  _mallPendingQty[productId] = qty;
  const input = document.querySelector(`input[data-pid="${productId}"]`);
  if (input) input.value = qty;
}
// 手动输入数量：仅记录「本次拟加入数量」，0/负数/非数字一律按 1 处理
// 不在输入过程中改写 DOM，避免与用户正在输入的内容冲突；归一在加入时完成
function setQty(productId, val) {
  const n = parseInt(val);
  const qty = (isNaN(n) || n < 1) ? 1 : n;
  _mallPendingQty[productId] = qty;
}

// 加入采购车：读取商品卡片「本次数量」N，新商品入车 N 件，已在车则 +N；
// 非法值（0/负/非数字）按 1 处理；加入后数量选择器重置为 1，按钮短暂显示「✓已加」
function addToCart(productId) {
  const p = _mallProducts.find(x => x._id === productId);
  if (!p) return;
  const input = document.querySelector(`input[data-pid="${productId}"]`);
  let n = parseInt(input ? input.value : _mallPendingQty[productId]);
  if (isNaN(n) || n < 1) n = 1;
  const mult = Number(p.coinMultiplier);
  const coinMultiplier = (!isNaN(mult) && mult > 0) ? mult : 1;
  const idx = _mallCart.findIndex(c => c.productId === productId);
  if (idx >= 0) {
    _mallCart[idx].quantity += n;                    // 已在车：在现有基础上增加 N 件
    _mallCart[idx].coinMultiplier = coinMultiplier;  // 同步最新倍率（开发者可能改过规则）
    _mallCart[idx].category = p.category || _mallCart[idx].category || '';
  } else {
    _mallCart.push({
      productId: p._id,
      name: p.name,
      unit: p.unit || '个',
      quantity: n,
      // 商家按平台卖价计价（卖价由平台手动定价；未定价时后端按供货价处理）
      unitPrice: p.salePrice != null ? p.salePrice : p.unitPrice,
      category: p.category || '',
      coinMultiplier
    });
  }
  // 重置该商品数量选择器为 1
  _mallPendingQty[productId] = 1;
  if (input) input.value = 1;
  // 按钮短暂反馈「✓已加」
  const btn = document.querySelector(`button[data-add="${productId}"]`);
  if (btn) {
    btn.textContent = '✓已加';
    btn.classList.add('just-added');
    clearTimeout(btn._addTimer);
    btn._addTimer = setTimeout(() => {
      btn.textContent = '加入采购车';
      btn.classList.remove('just-added');
    }, 1200);
  }
  renderCart();
}

function removeFromCart(productId) {
  _mallCart = _mallCart.filter(c => c.productId !== productId);
  renderStoreProducts();
  renderCart();
}

// 采购车所选券 id（桌面/手机两端共享同一选中态，renderCart 据此重建下拉并回填）
let _mallSelectedCouponId = '';

// 渲染采购车：商品列表 + 小计 + 起送价提示 + 抵用券下拉（门槛校验）+ 折扣 + 应付 + 提交按钮状态
// 同时更新桌面端采购车与手机端悬浮栏/抽屉（双端共享一份计算结果，避免口径分叉）
function renderCart() {
  const store = _mallCurrentStore;
  const minOrder = store ? storeMinOrder(store) : 300;
  const couponSelect = $('cartCouponSelect');
  const mCouponSelect = $('mCartCouponSelect');

  // 空车：两端统一清空
  if (!_mallCart.length) {
    _setTextAll(['cartEmpty', 'mCartEmpty'], 'block');
    _setHtmlAll(['cartList', 'mCartList'], '');
    _setDisplayAll(['cartCouponSection', 'mCartCouponSection'], 'none');
    _setDisplayAll(['cartDiscountRow', 'mCartDiscountRow'], 'none');
    _setDisplayAll(['cartMinOrder', 'mCartMinOrder'], 'none');
    _setDisplayAll(['cartCoinTotal', 'mCartCoinTotal'], 'none');
    _setDisplayAll(['cartCoinHint', 'mCartCoinHint'], 'none');
    _setTextAll(['cartSubtotal', 'mCartSubtotal'], '0.00');
    _setTextAll(['cartTotal', 'mCartTotal'], '0.00');
    _setBtnAll(['submitPurchaseBtn', 'mSubmitPurchaseBtn'], true, '采购车为空');
    updateMallFloatBar(0, 0, 0, false);
    return;
  }
  _setDisplayAll(['cartEmpty', 'mCartEmpty'], 'none');

  // 小计
  const subtotal = _mallCart.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  _setTextAll(['cartSubtotal', 'mCartSubtotal'], subtotal.toFixed(2));

  // 起送价提示（两端同步）
  const minOrderEls = [$('cartMinOrder'), $('mCartMinOrder')];
  minOrderEls.forEach(el => {
    if (!el) return;
    if (subtotal < minOrder) {
      el.style.display = 'block';
      el.className = 'cart-minorder lack';
      el.textContent = `还差 ¥${(minOrder - subtotal).toFixed(2)} 起送，继续选购`;
    } else {
      el.style.display = 'block';
      el.className = 'cart-minorder ok';
      el.textContent = `已满 ¥${minOrder} 起送`;
    }
  });

  // 抵用券：按 面额|门槛 分组计数；满足门槛可选，不满足灰显且不可选
  const groups = {};
  _mallCoupons.forEach(c => {
    const key = `${c.faceValue}|${c.minOrder}`;
    if (!groups[key]) groups[key] = { faceValue: c.faceValue, minOrder: c.minOrder, items: [] };
    groups[key].items.push(c);
  });
  const groupList = Object.values(groups).map(g => {
    g.items.sort((a, b) => new Date(a.expireDate) - new Date(b.expireDate));
    g.first = g.items[0];
    return g;
  });
  groupList.sort((a, b) => a.faceValue - b.faceValue);

  // 构建两端下拉的 option 列表（保持同步）
  const buildCouponOptions = () => {
    const opts = [`<option value="">不使用抵用券</option>`];
    groupList.forEach(g => {
      const eligible = subtotal >= g.minOrder;
      if (eligible) {
        opts.push(`<option value="${g.first._id}" data-face="${g.faceValue}">¥${g.faceValue} 券（满 ¥${g.minOrder} 可用）- 剩 ${g.items.length} 张</option>`);
      } else {
        const diff = (g.minOrder - subtotal).toFixed(2);
        opts.push(`<option value="" disabled>¥${g.faceValue} 券（还差 ¥${diff} 可用）</option>`);
      }
    });
    return opts.join('');
  };
  if (groupList.length > 0) {
    _setDisplayAll(['cartCouponSection', 'mCartCouponSection'], 'block');
    [couponSelect, mCouponSelect].forEach(sel => {
      if (!sel) return;
      sel.innerHTML = buildCouponOptions();
      // 保留之前选中的券（若仍可选）；否则置空
      if (_mallSelectedCouponId && [...sel.options].some(o => o.value === _mallSelectedCouponId)) {
        sel.value = _mallSelectedCouponId;
      } else {
        sel.value = '';
        _mallSelectedCouponId = '';
      }
      sel.onchange = () => {
        _mallSelectedCouponId = sel.value;
        renderCart();
      };
    });
  } else {
    _setDisplayAll(['cartCouponSection', 'mCartCouponSection'], 'none');
    [couponSelect, mCouponSelect].forEach(sel => { if (sel) sel.onchange = null; });
  }

  // 折扣与实付（按共享选中态计算）
  let discount = 0;
  if (groupList.length > 0 && _mallSelectedCouponId) {
    const opt = couponSelect && couponSelect.querySelector(`option[value="${_mallSelectedCouponId}"]`);
    if (opt) discount = Number(opt.getAttribute('data-face') || 0);
  }
  const actual = Math.max(0, subtotal - discount);
  _setDisplayAll(['cartDiscountRow', 'mCartDiscountRow'], discount > 0 ? 'flex' : 'none');
  _setTextAll(['cartDiscount', 'mCartDiscount'], discount.toFixed(2));
  _setTextAll(['cartTotal', 'mCartTotal'], actual.toFixed(2));

  // 预估鼎恒币：按实付金额计算，券抵扣额按各行金额占比分摊到各行
  // 与后端 confirm-receive 发币口径完全一致：每行实付金额 × 会员返币率 × 品类倍率，汇总后向下取整
  const coinRate = COIN_RATE[_mallMemberLevel] ?? 0.5;
  const payRatio = subtotal > 0 ? (actual / subtotal) : 0;
  const lineWeighted = _mallCart.map(c => {
    const lineAmt = c.quantity * c.unitPrice;
    const mult = Number(c.coinMultiplier) > 0 ? Number(c.coinMultiplier) : 1;
    return { lineAmt, mult, weighted: lineAmt * payRatio * coinRate * mult };
  });
  const totalCoin = Math.floor(lineWeighted.reduce((s, x) => s + x.weighted, 0));
  const lineCoins = lineWeighted.map(x => Math.floor(x.weighted));
  let remainder = totalCoin - lineCoins.reduce((s, x) => s + x, 0);
  if (remainder > 0) {
    const fracs = lineWeighted
      .map((x, i) => ({ i, frac: x.weighted - Math.floor(x.weighted) }))
      .sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < remainder && k < fracs.length; k++) lineCoins[fracs[k].i]++;
  }
  const cartItemsHtml = _mallCart.map((c, i) => {
    const lineAmt = c.quantity * c.unitPrice;
    const lineCoin = lineCoins[i];
    return `
    <div class="cart-item">
      <div class="cart-item-info">
        <div class="cart-item-name">${esc(c.name)}</div>
        <div class="cart-item-meta">${c.quantity} ${esc(c.unit)} × ¥${Number(c.unitPrice).toFixed(2)}</div>
        <div class="cart-item-coin">🪙 预计可得 ${lineCoin} 鼎恒币</div>
      </div>
      <div class="cart-item-price">¥${lineAmt.toFixed(2)}</div>
      <button class="cart-item-del" onclick="removeFromCart('${c.productId}')">×</button>
    </div>
    `;
  }).join('');
  _setHtmlAll(['cartList', 'mCartList'], cartItemsHtml);

  // 本单预计共得鼎恒币（按实付金额计算，与后端发币口径一致）
  [$('cartCoinTotal'), $('mCartCoinTotal')].forEach(el => {
    if (!el) return;
    el.style.display = totalCoin > 0 ? 'flex' : 'none';
    el.innerHTML = `本单预计共得 <b>${totalCoin}</b> 鼎恒币`;
  });
  [$('cartCoinHint'), $('mCartCoinHint')].forEach(el => {
    if (!el) return;
    el.style.display = totalCoin > 0 ? 'block' : 'none';
    el.textContent = '按实付金额计算，确认收货后自动到账';
  });

  // 提交按钮状态：未满起送价则禁用并提示差额
  const lackText = `还差 ¥${(minOrder - subtotal).toFixed(2)} 起送`;
  if (subtotal < minOrder) {
    _setBtnAll(['submitPurchaseBtn', 'mSubmitPurchaseBtn'], true, lackText);
  } else {
    _setBtnAll(['submitPurchaseBtn', 'mSubmitPurchaseBtn'], false, '提交采购订单');
  }

  // 手机端悬浮栏：总件数、实付、预估币、显隐
  const itemCount = _mallCart.reduce((s, i) => s + i.quantity, 0);
  updateMallFloatBar(itemCount, actual, totalCoin, true);
}

// 双端同步辅助：批量设置元素文本/HTML/display/按钮态
function _setTextAll(ids, text) { ids.forEach(id => { const el = $(id); if (el) el.textContent = text; }); }
function _setHtmlAll(ids, html) { ids.forEach(id => { const el = $(id); if (el) el.innerHTML = html; }); }
function _setDisplayAll(ids, display) { ids.forEach(id => { const el = $(id); if (el) el.style.display = display; }); }
function _setBtnAll(ids, disabled, text) {
  ids.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.disabled = disabled;
    el.textContent = text;
  });
}

// 手机端悬浮结算栏：更新件数 / 合计 / 预估币 / 显隐（无车或空车时隐藏，避免遮挡商品）
function updateMallFloatBar(itemCount, total, coin, show) {
  const bar = $('mFloatBar');
  if (!bar) return;
  const visible = show && itemCount > 0;
  bar.style.display = visible ? 'flex' : 'none';
  bar.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (!visible) return;
  const c = $('mFloatCount'); if (c) c.textContent = itemCount;
  const t = $('mFloatTotal'); if (t) t.textContent = total.toFixed(2);
  const cn = $('mFloatCoin'); if (cn) cn.textContent = coin;
}

// 手机端采购车抽屉开关
function openMallCartDrawer() {
  const drawer = $('mCartDrawer');
  const mask = $('mCartDrawerMask');
  if (drawer) drawer.classList.add('open');
  if (mask) mask.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeMallCartDrawer() {
  const drawer = $('mCartDrawer');
  const mask = $('mCartDrawerMask');
  if (drawer) drawer.classList.remove('open');
  if (mask) mask.classList.remove('open');
  document.body.style.overflow = '';
}
(function () {
  const btn = $('mFloatCheckoutBtn');
  if (btn) btn.onclick = openMallCartDrawer;
  const close = $('mCartDrawerClose');
  if (close) close.onclick = closeMallCartDrawer;
  const mask = $('mCartDrawerMask');
  if (mask) mask.onclick = closeMallCartDrawer;
  // 抽屉内提交按钮绑定同一提交逻辑
  const mSubmit = $('mSubmitPurchaseBtn');
  if (mSubmit) mSubmit.onclick = submitMallOrder;
})();

// 提交采购订单（shopId 由后端从 JWT 取；couponId 随单提交，后端同事务核销）
// 桌面端 submitPurchaseBtn 与手机端 mSubmitPurchaseBtn 共用此函数
// 囤货保护：后端预检若返回 STOCKPILE_WARNING，弹窗提示商家选择"修改"或"坚持下单"
async function submitMallOrder() {
  if (!_mallCurrentStore) { toast('请先选择供应商店铺', true); return; }
  if (!_mallCart.length) { toast('采购车为空', true); return; }
  const store = _mallCurrentStore;
  const minOrder = storeMinOrder(store);
  const subtotal = _mallCart.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  if (subtotal < minOrder) { toast(`未满 ¥${minOrder} 起送价`, true); return; }

  const supplierId = store._id;
  const items = _mallCart.map(c => ({
    productId: c.productId,
    quantity: c.quantity,
    // 金额由后端按商品「供货价 / 平台卖价」权威计算，前端单价仅作参考展示
    unitPrice: c.unitPrice
  }));
  const couponId = _mallSelectedCouponId || '';

  const body = { supplierId, items };
  if (couponId) body.couponId = couponId;

  const orderRes = await api('/api/purchase-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  // 囤货保护：预检返回 STOCKPILE_WARNING 时弹窗提醒，商家可选"坚持下单"(force=true)或"修改"
  if (!orderRes.success && orderRes.code === 'STOCKPILE_WARNING') {
    const w = orderRes.data || {};
    const stockpile = w.stockpileWarnings || [];
    const drops = w.priceDropWarnings || [];
    let msg = '';
    if (stockpile.length) {
      msg += '⚠️ 量异常：\n' + stockpile.map(s =>
        `「${s.name}」本次 ${s.quantity} 超过近7日总量 ${s.history7DayTotal}（${s.ratio}倍）`).join('\n') + '\n\n';
    }
    if (drops.length) {
      msg += '📉 跌价预警：\n' + drops.map(d =>
        `「${d.name}」售价 ¥${d.unitPrice} 低于近7日均价 ¥${d.avg7Day}（跌 ${d.dropRatio}%）`).join('\n');
    }
    msg += '\n请确认是否有误。点击"确定"坚持下单，"取消"返回修改。';
    if (confirm(msg)) {
      // 商家坚持下单：带 force=true 重新提交
      const forceRes = await api('/api/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId, items, couponId: couponId || undefined, force: true })
      });
      if (!forceRes.success) { toast(forceRes.message || '下单失败', true); return; }
      toast('采购订单已提交（已标注异常提醒供应商）');
    } else {
      toast('已取消，请修改后重新提交', true);
      return;
    }
  } else if (!orderRes.success) {
    toast(orderRes.message || '下单失败', true);
    return;
  } else {
    toast('采购订单已提交！');
  }

  _mallCart = [];
  _mallSelectedCouponId = '';
  closeMallCartDrawer();
  backToStoreList();
  // 提交后刷新可用券缓存（用掉了一张）
  try {
    const st = await api(`/api/coin/status/${SHOP_ID}`);
    _mallCoupons = ((st.data && st.data.coupons) || []).filter(couponUsable);
  } catch (e) { /* ignore */ }
  switchTab('purchase'); // 跳转到采购订单查看
}
// 桌面端提交按钮绑定
(function () {
  const btn = $('submitPurchaseBtn');
  if (btn) btn.onclick = submitMallOrder;
})();
window.submitMallOrder = submitMallOrder;
window.openMallCartDrawer = openMallCartDrawer;
window.closeMallCartDrawer = closeMallCartDrawer;

/* ===================== 采购订单 ===================== */
let _purchaseFilterStatus = '';

async function loadPurchaseOrders() {
  // 后端按 JWT 中的 shopId 过滤当前商家订单，无需前端再传 shopId
  const statusParam = _purchaseFilterStatus ? `?status=${encodeURIComponent(_purchaseFilterStatus)}` : '';
  const res = await api(`/api/purchase-orders${statusParam}`);
  const body = $('purchaseOrdersBody');
  const cardList = $('purchaseCardList');
  const orders = res.data || [];
  // 商家主动查看订单 = 已知悉当前状态，更新红点轮询基线并清零角标
  if (typeof _recordPurchaseSnapshot === 'function' && orders.length) {
    _lastPurchaseSnapshot = _recordPurchaseSnapshot(orders);
  }
  _purchaseBadgeSeen = true;
  updatePurchaseBadge(false);
  if (!orders.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">暂无采购订单</td></tr>`;
    if (cardList) cardList.innerHTML = `<div class="empty">暂无采购订单</div>`;
    return;
  }
  // 后端已 populate supplierId 为对象（含 name），直接取；兼容旧字符串 id
  const badgeCls = {
    '待确认': 'b-gray', '已确认': 'b-blue', '已发货': 'b-orange', '已完成': 'b-green'
  };
  // 商品行文案：已过秤行追加实称重量
  const itemLine = (i) => {
    const w = Number(i.actualWeight || 0);
    return w > 0
      ? `${esc(i.name)}×${i.quantity}<small style="color:#b45309;">（实称${w.toFixed(2)}kg）</small>`
      : `${esc(i.name)}×${i.quantity}`;
  };
  // 桌面端表格行
  body.innerHTML = orders.map(o => {
    const sup = o.supplierId;
    const supplierName = (sup && typeof sup === 'object' && sup.name) ? sup.name : (typeof sup === 'string' ? sup : '未知供应商');
    // 供应商配送公告（如有则在供应商名下小字展示）
    const deliveryNotice = (sup && typeof sup === 'object' && sup.deliveryNotice) ? sup.deliveryNotice.trim() : '';
    const noticeHtml = deliveryNotice
      ? `<div style="font-size:11px;color:#92660c;background:#fff8e6;border:1px solid #fcd97b;border-radius:6px;padding:3px 6px;margin-top:3px;line-height:1.4;max-width:220px;"><b>🚚 配送说明：</b>${esc(deliveryNotice)}</div>`
      : '';
    const itemsText = (o.items || []).slice(0, 2).map(itemLine).join('，') + (o.items?.length > 2 ? '…' : '');
    const bc = badgeCls[o.status] || 'b-gray';
    const sortTag = o.sorted ? '<span class="badge b-green" style="margin-left:4px;font-size:11px;">已分拣</span>' : '';
    const actionHtml = o.status === '已发货'
      ? `<button class="btn btn-orange" data-id="${o._id}">确认收货</button>`
      : (o.status === '已完成' ? `<span style="color:#16a34a;">✓ 已返 ${o.rewardCoin || 0} DH</span>` : '—');

    return `
      <tr>
        <td><b>${esc(o.orderNo || o._id)}</b><br><small style="color:#9ca3af;">${fmtTime(o.createdAt)}</small></td>
        <td>${esc(supplierName)}${noticeHtml}</td>
        <td title="${esc((o.items || []).map(i => `${i.name}×${i.quantity}${i.actualWeight ? '（实称' + i.actualWeight + 'kg）' : ''}`).join('，'))}">${itemsText}</td>
        <td>¥${Number(o.totalAmount).toFixed(2)}</td>
        <td><span class="badge ${bc}">${o.status}</span>${sortTag}</td>
        <td>${o.status === '已完成' ? (o.rewardCoin || 0) + ' DH' : '—'}</td>
        <td>${actionHtml}</td>
      </tr>
    `;
  }).join('');

  // 手机端卡片列表（替代表格，无横向滑动）
  if (cardList) {
    cardList.innerHTML = orders.map(o => {
      const sup = o.supplierId;
      const supplierName = (sup && typeof sup === 'object' && sup.name) ? sup.name : (typeof sup === 'string' ? sup : '未知供应商');
      // 供应商配送公告（如有则展示在供应商名行下小字）
      const deliveryNotice = (sup && typeof sup === 'object' && sup.deliveryNotice) ? sup.deliveryNotice.trim() : '';
      const noticeHtml = deliveryNotice
        ? `<div class="pcard-amount" style="font-size:11px;color:#92660c;background:#fff8e6;border:1px solid #fcd97b;border-radius:6px;padding:4px 6px;margin-top:3px;line-height:1.4;"><b>🚚 配送说明：</b>${esc(deliveryNotice)}</div>`
        : '';
      const itemsCount = (o.items || []).length;
      const itemsSummary = (o.items || []).slice(0, 3).map(itemLine).join('，') + (itemsCount > 3 ? ` 等 ${itemsCount} 项` : '');
      const bc = badgeCls[o.status] || 'b-gray';
      const totalAmt = Number(o.totalAmount || 0);
      const discount = Number(o.discountAmount || 0);
      const actualPay = Number(o.actualPayAmount || totalAmt);
      const rewardCoin = o.rewardCoin || 0;
      // 已分拣则实付按实称重算，标注提示
      const weighedCount = (o.items || []).filter(i => i.weighed).length;
      const sortedTip = weighedCount > 0 ? `<span class="pcard-amount"><small style="color:#b45309;">${weighedCount}项已实称</small></span>` : '';
      // 卡片操作按钮：已发货显示「确认收货」，已完成显示返币，其他状态显示占位
      const actionHtml = o.status === '已发货'
        ? `<button class="btn btn-orange" data-id="${o._id}">确认收货</button>`
        : (o.status === '已完成' ? `<span class="pcard-coin-done">✓ 已返 ${rewardCoin} DH</span>` : '');
      return `
        <div class="pcard">
          <div class="pcard-head">
            <div>
              <div class="pcard-no">${esc(o.orderNo || o._id)}</div>
              <div class="pcard-time">${fmtTime(o.createdAt)}</div>
            </div>
            <span class="pcard-status badge ${bc}">${o.status}</span>
          </div>
          <div class="pcard-supplier">供应商：<b>${esc(supplierName)}</b></div>
          ${noticeHtml}
          <div class="pcard-items">${itemsSummary || '无商品'}</div>
          <div class="pcard-amounts">
            <span class="pcard-amount">总额 <b>¥${totalAmt.toFixed(2)}</b></span>
            ${discount > 0 ? `<span class="pcard-amount discount">券抵扣 <b>-¥${discount.toFixed(2)}</b></span>` : ''}
            <span class="pcard-amount pay">实付 <b>¥${actualPay.toFixed(2)}</b></span>
            ${o.status === '已完成' ? `<span class="pcard-amount coin">返币 <b>${rewardCoin} DH</b></span>` : ''}
            ${sortedTip}
          </div>
          ${actionHtml ? `<div class="pcard-actions">${actionHtml}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // 绑定「确认收货」按钮（桌面表格 + 手机卡片，统一绑定）
  const confirmHandler = async (btn) => {
    if (!confirm('确认收到该订单货物？收货后鼎恒币将立即发放。')) return;
    const r = await api(`/api/purchase-orders/${btn.dataset.id}/confirm-receive`, { method: 'POST' });
    if (r.success) {
      const coin = r.rewardCoin || 0;
      toast(`收货成功！已返 ${coin} DH`);
      loadPurchaseOrders();
    } else {
      toast(r.message || '操作失败', true);
    }
  };
  // 桌面端表格内按钮
  body.querySelectorAll('button[data-id]').forEach(btn => { btn.onclick = () => confirmHandler(btn); });
  // 手机端卡片内按钮（卡片容器内同样用 data-id 标识）
  if (cardList) {
    cardList.querySelectorAll('button[data-id]').forEach(btn => { btn.onclick = () => confirmHandler(btn); });
  }
}

// 状态筛选标签
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    _purchaseFilterStatus = tab.dataset.status;
    loadPurchaseOrders();
  };
});

/* ===================== 采购订单状态变化红点提醒 =====================
   商家后台每 15 秒轮询采购订单，检测供应商发起的状态变化（已确认/已发货/已送达）。
   发货 = status 切换到"已发货"；送达 = deliveryPhotoUrl 写入（status 仍"已发货"）。
   任一变化即在「采购订单」导航加红点；用户点击进入栏目后清零。 */
let _lastPurchaseSnapshot = null;  // Map<orderId, status + '|' + (deliveredAt ? '1' : '0')>
let _purchaseBadgeSeen = true;     // 是否已查看（true=不显示红点）

function updatePurchaseBadge(shouldShow) {
  const badge = document.getElementById('navPurchaseBadge');
  if (!badge) return;
  if (shouldShow && !_purchaseBadgeSeen) {
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// 首次加载订单时建立快照基线，避免误报
function _recordPurchaseSnapshot(orders) {
  const map = {};
  orders.forEach(o => {
    map[String(o._id)] = (o.status || '') + '|' + (o.deliveredAt ? '1' : '0');
  });
  return map;
}

async function pollPurchaseStatusChanges() {
  try {
    const res = await api('/api/purchase-orders');
    if (!res.success || !Array.isArray(res.data)) return;
    const cur = _recordPurchaseSnapshot(res.data);
    if (_lastPurchaseSnapshot === null) {
      _lastPurchaseSnapshot = cur;
      return;
    }
    let changed = false;
    for (const id in cur) {
      const prev = _lastPurchaseSnapshot[id];
      if (prev === undefined) {
        // 新订单（首次出现）也算变化
        if (res.data.find(o => String(o._id) === id)) {
          // 新订单：只有当状态不是"待确认"时才提醒（待确认是商家自己刚下的）
          const o = res.data.find(o => String(o._id) === id);
          if (o && o.status !== '待确认') changed = true;
        }
      } else if (prev !== cur[id]) {
        // 状态变化或送达照片写入
        const newStatus = cur[id].split('|')[0];
        // 商家自己确认收货（已收货/已完成）不算提醒
        if (newStatus !== '已收货' && newStatus !== '已完成') changed = true;
      }
    }
    if (changed) {
      _purchaseBadgeSeen = false;
      updatePurchaseBadge(true);
      // 同步刷新订单列表，让用户立即看到新状态（即便未点击）
      loadPurchaseOrders();
    }
    _lastPurchaseSnapshot = cur;
  } catch (e) {
    // 网络错误静默，下次再试
  }
}
setInterval(pollPurchaseStatusChanges, 15000);

// 点击「采购订单」导航：清红点（用户主动查看）
(function () {
  const navPurchase = document.getElementById('navPurchase');
  if (navPurchase) {
    navPurchase.addEventListener('click', () => {
      _purchaseBadgeSeen = true;
      updatePurchaseBadge(false);
    });
  }
})();

/* ===================== 智能补货（采购核心：预测 + 提醒） ===================== */

let _smartReplenishData = [];   // 补货提醒（采购频率 + 库存预警）
let _smartForecastData = [];    // 预测补货（点餐销量预测）
let _smartForecastLocked = false; // 采购线未达省钱卡(plus) → 30 天预测锁定
let _smartForecastPreview = [];   // 锁定时后端返回的真实前 3 条预览（前端模糊展示）

async function loadSmartReplenish() {
  const listEl = $('smartReplenishList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="empty">正在分析采购与销量数据…</div>';
  try {
    const [srRes, fcRes] = await Promise.all([
      api('/api/admin/smart-replenish/suggestions'),
      api('/api/admin/smart-replenish/forecast')
    ]);
    _smartReplenishData = (srRes && srRes.success && srRes.data && srRes.data.suggestions) || [];
    const fd = (fcRes && fcRes.success && fcRes.data) || {};
    _smartForecastLocked = fd.locked === true;
    _smartForecastData = fd.forecastItems || [];
    _smartForecastPreview = fd.previewSample || [];
    renderSmartReplenish();
  } catch (e) {
    console.error('智能补货加载失败', e);
    toast('智能补货加载失败', true);
    listEl.innerHTML = '<div class="empty">加载失败，请重试</div>';
  }
}

function groupBySupplier(items) {
  const groups = new Map();
  items.forEach((s) => {
    const key = String(s.supplierId || 'unknown');
    if (!groups.has(key)) {
      groups.set(key, { supplierId: s.supplierId, supplierName: s.supplierName || '未知供应商', items: [] });
    }
    groups.get(key).items.push(s);
  });
  return [...groups.values()];
}

function renderSrTable(g, type) {
  let html = `<div class="sr-group">`;
  html += `<div class="sr-group-head"><b>${esc(g.supplierName)}</b><span>${g.items.length} 项</span></div>`;
  if (type === 'forecast') {
    html += `<div class="table-wrap"><table class="data"><thead><tr><th>食材</th><th>品类</th><th>预测需求</th><th>当前库存</th><th>建议采购</th></tr></thead><tbody>`;
    g.items.forEach((s) => {
      html += `<tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.category)}</td>
        <td>${s.predictedDemand} ${esc(s.unit)}</td>
        <td>${s.currentInventory} ${esc(s.unit)}</td>
        <td><b>${s.suggestedQuantity}</b> ${esc(s.unit)}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  } else {
    html += `<div class="table-wrap"><table class="data"><thead><tr><th>食材</th><th>品类</th><th>补货原因</th><th>建议量</th><th>参考价</th></tr></thead><tbody>`;
    g.items.forEach((s) => {
      html += `<tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.category)}</td>
        <td>${esc(s.reason || '')}</td>
        <td><b>${s.suggestedQuantity}</b> ${esc(s.unit)}</td>
        <td>¥${Number(s.latestPrice).toFixed(2)}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  }
  html += `<div class="sr-group-foot"><button class="btn-add" type="button" data-sr-order="${esc(g.supplierId)}" data-sr-type="${type}">一键转采购单</button><span class="sr-foot-hint">按建议量生成该供应商的采购订单</span></div>`;
  html += `</div>`;
  return html;
}

function renderSmartReplenish() {
  const listEl = $('smartReplenishList');
  if (!listEl) return;

  const forecast = _smartForecastData;
  const suggestions = _smartReplenishData;

  let html = '';
  html += `<div class="sr-section-title">📈 预测补货（未来 7 天销量预测）</div>`;
  if (_smartForecastLocked) {
    // 采购线未达省钱卡(plus)：用真实前 3 条预览做模糊展示 + 升级引导（不弹屏、不编造数据）
    const preview = _smartForecastPreview;
    if (preview.length) {
      html += `<div class="sr-group" style="position:relative;">
        <div style="filter:blur(4px);pointer-events:none;user-select:none;">
          ${renderSrTable({ supplierId: preview[0].supplierId, supplierName: preview[0].supplierName || '预测预览', items: preview }, 'forecast')}
        </div>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(255,255,255,.78);border-radius:14px;">
          <div style="font-weight:700;color:#1f2937;">🔒 30 天智能补货预测是「采购省钱卡」权益</div>
          <div style="font-size:13px;color:#6b7280;">开通后提前知道该进什么货、进多少，备货不压货</div>
          <button class="btn-add" type="button" onclick="goUpgrade('plus')">升级采购省钱卡解锁</button>
        </div>
      </div>`;
    } else {
      html += `<div class="empty" style="margin-bottom:24px;">🔒 30 天智能补货预测是「采购省钱卡」权益 ·
        <a href="javascript:void(0)" onclick="goUpgrade('plus')">升级解锁</a></div>`;
    }
  } else if (forecast.length) {
    groupBySupplier(forecast).forEach((g) => { html += renderSrTable(g, 'forecast'); });
  } else {
    html += `<div class="empty" style="margin-bottom:24px;">暂无销量数据或未配置菜品配方，无法预测</div>`;
  }

  html += `<div class="sr-section-title">🔔 补货提醒（采购频率 + 库存预警）</div>`;
  if (suggestions.length) {
    groupBySupplier(suggestions).forEach((g) => { html += renderSrTable(g, 'suggestions'); });
  } else {
    html += `<div class="empty">暂无需要补货的食材 🎉</div>`;
  }

  listEl.innerHTML = html;
  listEl.querySelectorAll('[data-sr-order]').forEach((btn) => {
    btn.onclick = () => submitSmartReplenish(btn.dataset.srOrder, btn.dataset.srType);
  });
}

async function submitSmartReplenish(supplierId, type) {
  const source = type === 'forecast' ? _smartForecastData : _smartReplenishData;
  const items = source
    .filter((s) => String(s.supplierId) === String(supplierId))
    .map((s) => ({ productId: s.productId, quantity: s.suggestedQuantity }));
  if (!items.length) { toast('该供应商无可下单商品', true); return; }

  const body = { supplierId, items };
  const res = await api('/api/purchase-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.success && res.code === 'STOCKPILE_WARNING') {
    const w = res.data || {};
    const stockpile = w.stockpileWarnings || [];
    const drops = w.priceDropWarnings || [];
    let msg = '';
    if (stockpile.length) msg += '⚠️ 量异常：\n' + stockpile.map(x => `「${x.name}」本次 ${x.quantity} 超过近7日总量 ${x.history7DayTotal}`).join('\n') + '\n\n';
    if (drops.length) msg += '📉 跌价预警：\n' + drops.map(x => `「${x.name}」售价低于近7日均价`).join('\n');
    msg += '\n点击"确定"坚持下单，"取消"返回修改。';
    if (confirm(msg)) {
      const forceRes = await api('/api/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId, items, force: true })
      });
      if (!forceRes.success) { toast(forceRes.message || '下单失败', true); return; }
      toast('采购订单已提交（已标注异常提醒供应商）');
    } else {
      toast('已取消，请修改后重新提交', true);
      return;
    }
  } else if (!res.success) {
    toast(res.message || '下单失败', true);
    return;
  } else {
    toast('采购订单已提交！');
  }
  loadSmartReplenish();
}

// 刷新按钮绑定
(function () {
  const btn = $('smartReplenishRefresh');
  if (btn) btn.onclick = loadSmartReplenish;
})();

/* ===================== 采购监控（防回扣） ===================== */
// 数据全部来自 /api/admin/procurement-monitor/*（shopId 由 JWT 隔离）；
// 明细查询复用 /api/purchase-orders?status=已完成。阈值与后端一致：>均价20% warning，>30% danger。

let _procCharts = { trend: null, cat: null, sup: null };
let _procTrends = [];          // price-trends 缓存（商品下拉数据源）
let _procHistoryRows = [];     // 明细扁平行缓存 [{date, name, supplierName, price, quantity, total, orderNo}]
let _procHistoryAvg = {};      // 明细行着色用：name|supplierId → 均价
let _procSearchBound = false;
let _procSearchTimer = null;
const PROC_PALETTE = ['#ff6b35', '#1a88ff', '#16a34a', '#f59e0b', '#8b5cf6', '#06b6d4', '#ef4444', '#64748b', '#ec4899', '#84cc16', '#a855f7', '#14b8a6'];

function fmtMoney(n) {
  return (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function procChartOk() { return typeof Chart !== 'undefined'; }

function destroyProcChart(key) {
  if (_procCharts[key]) { _procCharts[key].destroy(); _procCharts[key] = null; }
}

// 入口：会员防御性校验 → 并行拉取 5 个接口 → 分区块渲染
async function loadProcurement() {
  const lockedEl = $('procurementLocked');
  const panelEl = $('procurementPanel');
  const bodyEl = $('procurementBody');
  const emptyEl = $('procurementEmpty');
  try {
    // 权限控制：所有会员等级（basic/advanced/premium）可用；无会员状态防御性锁定
    const status = await api(`/api/coin/status/${SHOP_ID}`);
    const level = status && status.success && status.data ? status.data.memberLevel : '';
    if (!['basic', 'advanced', 'premium'].includes(level)) {
      if (lockedEl) lockedEl.style.display = 'block';
      if (panelEl) panelEl.style.display = 'none';
      return;
    }
    if (lockedEl) lockedEl.style.display = 'none';
    if (panelEl) panelEl.style.display = 'block';

    const [ov, alerts, trends, catRes, supRes, ordersRes] = await Promise.all([
      api('/api/admin/procurement-monitor/overview'),
      api('/api/admin/procurement-monitor/alerts'),
      api('/api/admin/procurement-monitor/price-trends'),
      api('/api/admin/procurement-monitor/category-breakdown'),
      api('/api/admin/procurement-monitor/supplier-breakdown'),
      api('/api/purchase-orders?status=' + encodeURIComponent('已完成'))
    ]);

    const ovData = (ov && ov.success && ov.data) || null;
    const orderList = (ordersRes && ordersRes.data) || [];

    // 空状态：从未完成过采购
    if (!ovData || (ovData.totalOrders === 0 && orderList.length === 0)) {
      if (emptyEl) emptyEl.style.display = 'block';
      if (bodyEl) bodyEl.style.display = 'none';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    if (bodyEl) bodyEl.style.display = 'block';

    renderProcOverview(ovData);
    renderProcAlerts((alerts && alerts.success && alerts.data) || []);
    renderProcSavings((savingsRes && savingsRes.success && savingsRes.data) || null);
    _procTrends = (trends && trends.success && trends.data) || [];
    renderProcTrendSelect();
    renderProcPies(
      (catRes && catRes.success && catRes.data) || [],
      (supRes && supRes.success && supRes.data) || []
    );
    buildProcHistoryRows(orderList);
    renderProcHistory();
    if (!_procSearchBound) {
      _procSearchBound = true;
      const si = $('procHistorySearch');
      si.oninput = () => {
        if (_procSearchTimer) clearTimeout(_procSearchTimer);
        _procSearchTimer = setTimeout(renderProcHistory, 300);
      };
    }
  } catch (e) {
    console.error('采购监控加载失败', e);
    toast('采购监控加载失败', true);
  }
}

// 区块1：顶部统计卡
function renderProcOverview(d) {
  $('procTotalAmount').textContent = fmtMoney(d.totalAmount);
  $('procOrderCount').textContent = d.totalOrders ?? 0;
  $('procSupplierCount').textContent = d.supplierCount ?? 0;

  const growth = Number(d.monthOverMonthGrowth) || 0;
  const mom = $('procMom');
  mom.classList.remove('up', 'down', 'flat');
  if (growth > 0.05) { mom.classList.add('up'); mom.textContent = `↑ 环比上涨 ${Math.abs(growth)}%`; }
  else if (growth < -0.05) { mom.classList.add('down'); mom.textContent = `↓ 环比下降 ${Math.abs(growth)}%`; }
  else { mom.classList.add('flat'); mom.textContent = growth === 0 ? '— 与上月持平' : `环比 ${growth > 0 ? '+' : ''}${growth}%`; }

  const alertCount = Number(d.alertCount) || 0;
  $('procAlertCount').textContent = alertCount;
  const card = $('procAlertCard');
  card.classList.toggle('alert-red', alertCount > 0);
  card.classList.toggle('alert-green', alertCount === 0);
}

// 区块1.5：本月省钱账单（采购价 vs 平台参考价；无数据时隐藏，不编造）
function renderProcSavings(d) {
  const block = $('procSavingsBlock');
  if (!block) return;
  if (!d || !d.hasData) { block.style.display = 'none'; return; }
  block.style.display = 'block';
  const amt = Number(d.monthSaved || 0);
  const amtEl = $('procSavingsAmount');
  if (amtEl) amtEl.textContent = amt.toFixed(2);
  const sub = $('procSavingsSub');
  if (sub) sub.textContent = `已对比 ${d.coveredItems || 0} 项有参考价的采购明细`;
  const body = $('procSavingsBody');
  if (body) {
    const rows = (d.topSaved || []).map(x => `<tr>
      <td>${esc(x.name)}</td>
      <td>¥${Number(x.paidPrice).toFixed(2)}</td>
      <td>¥${Number(x.refPrice).toFixed(2)}</td>
      <td>${x.quantity}</td>
      <td style="color:#16a34a;font-weight:700;">¥${Number(x.saved).toFixed(2)}</td>
    </tr>`).join('');
    body.innerHTML = rows || `<tr><td colspan="5" style="text-align:center;color:#9ca3af;">本月暂无可对比的省钱项</td></tr>`;
  }
  const note = $('procSavingsNote');
  if (note) note.textContent = d.note || '';
}

// 区块2：价格异常预警列表
function renderProcAlerts(alerts) {
  const wrap = $('procAlertWrap');
  const sub = $('procAlertSub');
  if (!alerts.length) {
    sub.textContent = '暂无异常';
    wrap.innerHTML = `
      <div class="proc-ok-banner">✅ 暂无异常，所有商品价格均在正常范围内
        <small>监控规则：最新采购价高于历史均价 20% 提醒（warning），超过 30% 严重预警（danger）</small>
      </div>`;
    return;
  }
  sub.textContent = `共 ${alerts.length} 条预警，请重点核查`;
  const dangerCount = alerts.filter(a => a.severity === 'danger').length;
  if (dangerCount > 0) sub.textContent = `共 ${alerts.length} 条预警（含 ${dangerCount} 条严重）`;
  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>商品名</th><th>供应商</th><th>当前价</th><th>历史均价</th><th>偏离幅度</th><th>严重程度</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${alerts.map(a => {
            const rowCls = a.severity === 'danger' ? 'alert-danger' : 'alert-warning';
            const badge = a.severity === 'danger'
              ? '<span class="badge" style="background:#fee2e2;color:#b91c1c;">🔴 严重 danger</span>'
              : '<span class="badge" style="background:#fef3c7;color:#b45309;">🟠 预警 warning</span>';
            return `
              <tr class="${rowCls}">
                <td><b>${esc(a.productName)}</b></td>
                <td>${esc(a.supplierName)}</td>
                <td>¥${a.currentPrice.toFixed(2)}</td>
                <td>¥${a.avgPrice.toFixed(2)}</td>
                <td><b style="color:var(--red);">+${a.deviationPercent}%</b></td>
                <td>${badge}</td>
                <td><span class="proc-link" data-order="${esc(a.orderNo)}">查看订单</span></td>
              </tr>
              <tr class="alert-suggestion"><td colspan="7">💡 ${esc(a.suggestion)}（订单日期 ${esc(a.date)}）</td></tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  wrap.querySelectorAll('.proc-link').forEach(el => {
    el.onclick = () => jumpPurchaseOrder(el.dataset.order);
  });
}

// 区块3：商品下拉 + 折线图
function renderProcTrendSelect() {
  const sel = $('procProductSelect');
  if (!_procTrends.length) {
    sel.innerHTML = '<option value="">暂无采购商品</option>';
    sel.disabled = true;
    $('procTrendStats').innerHTML = '<span>暂无价格数据</span>';
    destroyProcChart('trend');
    return;
  }
  sel.disabled = false;
  sel.innerHTML = _procTrends.map((t, i) => {
    const mark = t.alert ? ' 🔴' : (t.trend === 'up' ? ' ↑' : '');
    return `<option value="${i}">${esc(t.productName)}（${esc(t.supplierName)}）${mark}</option>`;
  }).join('');
  sel.onchange = () => renderProcTrendChart(Number(sel.value));
  renderProcTrendChart(0);
}

async function renderProcTrendChart(idx) {
  const t = _procTrends[idx];
  if (!t) return;
  const stats = $('procTrendStats');
  let points = t.dataPoints || [];
  let avg = t.avgPrice;
  let latestAbnormal = !!t.alert;

  // 优先用 price-history 拉近90天精确数据（含单号），失败回退趋势缓存
  try {
    const res = await api(`/api/admin/procurement-monitor/price-history?productName=${encodeURIComponent(t.productName)}&supplierId=${encodeURIComponent(t.supplierId)}&days=90`);
    if (res && res.success && res.data && res.data.points && res.data.points.length) {
      points = res.data.points;
      avg = res.data.avgPrice;
      latestAbnormal = res.data.enoughData && res.data.deviationPercent >= 20;
    }
  } catch (e) { /* 回退缓存 */ }

  if (!points.length) {
    destroyProcChart('trend');
    stats.innerHTML = '<span>该商品暂无 90 天内的采购记录</span>';
    return;
  }

  const lo = +(avg * 0.9).toFixed(2), hi = +(avg * 1.1).toFixed(2);
  stats.innerHTML = `
    <span>均价 <b>¥${avg.toFixed(2)}</b></span>
    <span>最低 <b>¥${Math.min(...points.map(p => p.price)).toFixed(2)}</b></span>
    <span>最高 <b>¥${Math.max(...points.map(p => p.price)).toFixed(2)}</b></span>
    <span>建议采购价区间 <b>¥${lo.toFixed(2)} ~ ¥${hi.toFixed(2)}</b>（均价±10%）</span>
    ${latestAbnormal ? '<span style="color:var(--red);font-weight:700;">⚠ 最新价偏高，建议核查</span>' : ''}
  `;

  if (!procChartOk()) {
    $('procTrendBox').innerHTML = '<div class="proc-chart-fallback">图表组件（Chart.js CDN）加载失败，请检查网络后刷新页面；上方统计数值仍可用。</div>';
    return;
  }
  destroyProcChart('trend');
  const labels = points.map(p => p.date);
  const prices = points.map(p => p.price);
  // 最新点异常 → 标红放大
  const pointColors = prices.map((_, i) => (latestAbnormal && i === prices.length - 1) ? '#ef4444' : '#ff6b35');
  const pointRadius = prices.map((_, i) => (latestAbnormal && i === prices.length - 1) ? 7 : 3);
  _procCharts.trend = new Chart($('procTrendCanvas'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${t.productName} 采购价`,
          data: prices,
          borderColor: '#ff6b35',
          backgroundColor: 'rgba(255,107,53,.08)',
          fill: true,
          tension: 0.25,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          pointRadius: pointRadius,
          borderWidth: 2
        },
        {
          label: '历史均价',
          data: labels.map(() => avg),
          borderColor: '#9ca3af',
          borderDash: [6, 5],
          pointRadius: 0,
          borderWidth: 1.5,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#4b5563', boxWidth: 14 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}：¥${Number(c.parsed.y).toFixed(2)}` } }
      },
      scales: {
        x: { ticks: { color: '#6b7280', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { color: 'rgba(0,0,0,.05)' } },
        y: { ticks: { color: '#6b7280', callback: (v) => '¥' + v }, grid: { color: 'rgba(0,0,0,.05)' } }
      }
    }
  });
}

// 区块4：品类 / 供应商双饼图
function renderProcPies(catData, supData) {
  const build = (key, data, nameField) => {
    destroyProcChart(key);
    const legendEl = $(key === 'cat' ? 'procCatLegend' : 'procSupLegend');
    const canvas = $(key === 'cat' ? 'procCatCanvas' : 'procSupCanvas');
    if (!data.length) {
      canvas.style.display = 'none';
      legendEl.innerHTML = '<span style="color:#9ca3af;">本月暂无采购数据</span>';
      return;
    }
    canvas.style.display = 'block';
    legendEl.innerHTML = data.map((d, i) => `
      <div class="pl-row">
        <span><span class="pl-dot" style="background:${PROC_PALETTE[i % PROC_PALETTE.length]};"></span>${esc(d[nameField])}</span>
        <span>¥${fmtMoney(d.amount)} · ${d.percent}%</span>
      </div>`).join('');
    if (!procChartOk()) {
      // CDN 加载失败时保留 canvas（下次重试仍可用），仅用图例区域提示
      legendEl.innerHTML = '<span style="color:#9ca3af;">图表组件加载失败，下方明细仍可查看</span>' + legendEl.innerHTML;
      return;
    }
    _procCharts[key] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: data.map(d => d[nameField]),
        datasets: [{
          data: data.map(d => d.amount),
          backgroundColor: data.map((_, i) => PROC_PALETTE[i % PROC_PALETTE.length]),
          borderWidth: 2,
          borderColor: '#fff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '52%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.label}：¥${fmtMoney(c.parsed)}（${data[c.dataIndex].percent}%）` } }
        }
      }
    });
  };
  build('cat', catData, 'category');
  build('sup', supData, 'supplierName');
}

// 区块5：历史采购明细（搜索 + 单价高于/低于均价20%着色）
function buildProcHistoryRows(orders) {
  const rows = [];
  const avgMap = {};
  for (const o of orders) {
    const sup = o.supplierId;
    const supplierName = (sup && typeof sup === 'object' && sup.name) ? sup.name : '未知供应商';
    const supplierId = sup && typeof sup === 'object' ? String(sup._id) : String(sup || '');
    const d = o.receiveAt || o.createdAt;
    const date = fmtTime(d).slice(0, 10);
    for (const it of (o.items || [])) {
      rows.push({
        date,
        name: it.name,
        supplierName,
        key: it.name + '|' + supplierId,
        price: Number(it.unitPrice) || 0,
        quantity: Number(it.quantity) || 0,
        total: Number(it.totalPrice) || 0,
        orderNo: o.orderNo || ''
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  // 同 商品+供应商 均价（用于着色）
  const sum = {}, cnt = {};
  rows.forEach(r => {
    sum[r.key] = (sum[r.key] || 0) + r.price;
    cnt[r.key] = (cnt[r.key] || 0) + 1;
  });
  Object.keys(sum).forEach(k => { avgMap[k] = sum[k] / cnt[k]; });
  _procHistoryRows = rows;
  _procHistoryAvg = avgMap;
}

function renderProcHistory() {
  const wrap = $('procHistoryWrap');
  const kw = ($('procHistorySearch').value || '').trim().toLowerCase();
  const rows = kw ? _procHistoryRows.filter(r => r.name.toLowerCase().includes(kw)) : _procHistoryRows;
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty">${kw ? '未找到匹配的采购记录' : '暂无已完成采购记录'}</div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="data">
      <thead>
        <tr><th>日期</th><th>商品</th><th>供应商</th><th>单价</th><th>数量</th><th>总价</th><th>订单号</th></tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const avg = _procHistoryAvg[r.key] || 0;
          // 高于均价20%标红（疑似买贵），低于均价20%标绿（拿到好价）
          const cls = avg > 0 && r.price > avg * 1.2 ? 'price-up'
            : (avg > 0 && r.price < avg * 0.8 ? 'price-down' : '');
          return `
            <tr>
              <td>${esc(r.date)}</td>
              <td><b>${esc(r.name)}</b></td>
              <td>${esc(r.supplierName)}</td>
              <td class="${cls}">¥${r.price.toFixed(2)}</td>
              <td>${r.quantity}</td>
              <td>¥${r.total.toFixed(2)}</td>
              <td><span class="proc-link" data-order="${esc(r.orderNo)}">${esc(r.orderNo)}</span></td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  wrap.querySelectorAll('.proc-link').forEach(el => {
    el.onclick = () => jumpPurchaseOrder(el.dataset.order);
  });
}

// 跳转采购订单页并高亮定位到对应订单
function jumpPurchaseOrder(orderNo) {
  if (!orderNo) return;
  _purchaseFilterStatus = '';
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', !t.dataset.status));
  switchTab('purchase');
  // 等订单列表渲染完成后滚动 + 闪烁高亮
  setTimeout(() => {
    const rows = document.querySelectorAll('#purchaseOrdersBody tr, #purchaseCardList .pcard');
    for (const r of rows) {
      if (r.textContent.includes(orderNo)) {
        r.scrollIntoView({ behavior: 'smooth', block: 'center' });
        r.classList.add('proc-flash-row');
        setTimeout(() => r.classList.remove('proc-flash-row'), 3200);
        break;
      }
    }
  }, 700);
}

/* ===================== 顾客积分 ===================== */
let _ptDishes = [];                 // 本店菜单缓存（积分换菜下拉用）
let _ptExchangeDishes = [];         // 待保存的兑换菜品列表 [{ dishId, dishName, points }]

async function loadPoints() {
  try {
    const perm = await api(`/api/member/permissions/${SHOP_ID}`);
    // 顾客积分已对基础版开放（basic/advanced/premium 可用）；
    // 未开通会员或会员过期时后端返回 customerPoints=false，前端显示锁定引导
    const unlocked = perm.data?.customerPoints === true;
    const lockedMask = $('pointsLocked');
    const panel = $('pointsPanel');

    if (!unlocked) {
      lockedMask.style.display = 'block';
      panel.style.display = 'none';
      return;
    }
    lockedMask.style.display = 'none';
    panel.style.display = 'block';

    // 并行拉取店铺积分设置 + 自家菜单（换菜下拉）
    const [setRes, dishRes] = await Promise.all([
      api('/api/settings'),
      api('/api/admin/dishes')
    ]);
    const s = (setRes && setRes.success && setRes.data) || {};
    _ptDishes = (dishRes && dishRes.data) || [];

    // 积分总开关 / 返积分比例 / 积分抵现
    $('setPointEnabled').checked = s.pointEnabled !== false;
    $('setSpendPerPoint').value = s.pointSpendPerPoint ?? 1;
    $('setPointDeductEnabled').checked = s.pointDeductEnabled !== false;
    $('setPointDeductPoints').value = s.pointDeductPoints ?? 100;
    $('setPointDeductMaxPercent').value = s.pointDeductMaxPercent ?? 20;

    // 兑换菜品列表 + 下拉填充
    _ptExchangeDishes = Array.isArray(s.pointExchangeDishes) ? s.pointExchangeDishes.map(d => ({
      dishId: String(d.dishId), dishName: d.dishName, points: d.points
    })) : [];
    renderPtExchangeList();
    const sel = $('ptDishSelect');
    if (sel) {
      sel.innerHTML = _ptDishes.length
        ? _ptDishes.map(d => `<option value="${esc(d._id)}" data-name="${esc(d.name)}">${esc(d.category ? d.category + ' · ' : '')}${esc(d.name)}（¥${Number(d.price).toFixed(0)}）</option>`).join('')
        : '<option value="">暂无菜品，请先在菜单管理添加</option>';
    }
  } catch (e) {
    console.error(e);
  }
}

// 渲染已设置的兑换菜品列表
function renderPtExchangeList() {
  const box = $('ptExchangeList');
  if (!box) return;
  if (!_ptExchangeDishes.length) {
    box.innerHTML = '<div style="font-size:12.5px;color:#9ca3af;padding:2px 0;">暂未设置，添加后顾客可在点餐页用积分换菜</div>';
    return;
  }
  box.innerHTML = _ptExchangeDishes.map((d, i) => `
    <div class="pt-ex-item">
      <span class="pt-ex-name">${esc(d.dishName)}</span>
      <span class="pt-ex-pts">${d.points} 积分</span>
      <button class="pt-ex-del" data-i="${i}" title="移除" type="button">✕</button>
    </div>
  `).join('');
  box.querySelectorAll('.pt-ex-del').forEach(btn => {
    btn.onclick = () => {
      _ptExchangeDishes.splice(Number(btn.dataset.i), 1);
      renderPtExchangeList();
    };
  });
}

// 添加兑换菜品（去重，同菜仅可添加一次）
$('ptAddDishBtn').onclick = () => {
  const sel = $('ptDishSelect');
  if (!sel || !sel.value) { toast('请先添加菜品', true); return; }
  const opt = sel.options[sel.selectedIndex];
  const dishId = sel.value;
  const dishName = opt ? opt.dataset.name : '';
  const points = Math.max(1, Math.round(Number($('ptDishPoints').value) || 0));
  if (!points) { toast('请填写所需积分', true); return; }
  if (_ptExchangeDishes.some(d => d.dishId === dishId)) { toast('该菜品已在兑换列表中', true); return; }
  if (_ptExchangeDishes.length >= 20) { toast('最多设置 20 个兑换菜品', true); return; }
  _ptExchangeDishes.push({ dishId, dishName, points });
  renderPtExchangeList();
  toast('已添加，记得点"保存积分设置"');
};

// 保存积分设置（写入后端 Setting，顾客端实时生效）
$('savePointsBtn').onclick = async () => {
  const btn = $('savePointsBtn');
  const payload = {
    pointEnabled: $('setPointEnabled').checked,
    pointSpendPerPoint: Math.max(0, Number($('setSpendPerPoint').value) || 0),
    pointDeductEnabled: $('setPointDeductEnabled').checked,
    pointDeductPoints: Math.max(1, Math.round(Number($('setPointDeductPoints').value) || 100)),
    pointDeductMaxPercent: Math.min(100, Math.max(0, Number($('setPointDeductMaxPercent').value) || 0)),
    pointExchangeDishes: _ptExchangeDishes
  };
  btn.disabled = true;
  const res = await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  btn.disabled = false;
  if (res.success) {
    toast('积分设置已保存，顾客端即时生效');
  } else if (res.needUpgrade) {
    toast(res.message || '需要升级会员', true);
  } else {
    toast(res.message || '保存失败', true);
  }
};

/* ===================== 营销活动（满减 / 折扣 / 充值送） ===================== */
// 权限：满减 = 进阶版+；折扣、充值送 = 尊享版
const MKT_TYPES = ['fullReduction', 'discount', 'rechargeBonus'];
const MKT_TYPE_NAME = { fullReduction: '满减', discount: '折扣', rechargeBonus: '充值送' };
let _mktList = [];          // 当前店铺全部活动
let _mktEditing = null;     // 当前编辑的活动对象（null=新建）

// 活动规则文本
function mktRuleText(a) {
  if (a.type === 'fullReduction') return `满 ¥${Number(a.threshold).toFixed(2)} 减 ¥${Number(a.reduce).toFixed(2)}`;
  if (a.type === 'discount') {
    const zhe = Math.round(Number(a.rate) * 10);
    return a.category ? `${esc(a.category)} ${zhe}折` : `全场 ${zhe}折`;
  }
  if (a.type === 'rechargeBonus') return `充 ¥${Number(a.recharge).toFixed(2)} 送 ¥${Number(a.bonus).toFixed(2)}`;
  return '—';
}
// 生效时间文本
function mktTimeText(a) {
  const s = a.startTime ? fmtTime(a.startTime) : '立即';
  const e = a.endTime ? fmtTime(a.endTime) : '长期';
  return `${s} ~ ${e}`;
}
// 状态判定：进行中/未开始/已结束/已停用
function mktStatus(a) {
  if (!a.enabled) return { cls: 'mkt-status-off', text: '已停用' };
  const now = Date.now();
  const start = a.startTime ? new Date(a.startTime).getTime() : 0;
  const end = a.endTime ? new Date(a.endTime).getTime() : Infinity;
  if (now < start) return { cls: 'mkt-status-future', text: '未开始' };
  if (now > end) return { cls: 'mkt-status-expired', text: '已结束' };
  return { cls: 'mkt-status-on', text: '进行中' };
}

async function loadMarketing() {
  try {
    // 拉取权限清单：marketingDiscount(满减) + marketingCategoryDiscount(折扣) + marketingRecharge(充值送)
    const perm = await api(`/api/member/permissions/${SHOP_ID}`);
    const data = perm.data || {};
    const level = data.memberLevel || 'basic';
    const canFull = data.marketingDiscount === true;                    // 满减：进阶版+
    const canDiscount = data.marketingCategoryDiscount === true;        // 折扣：尊享版
    const canRecharge = data.marketingRecharge === true;                // 充值送：尊享版

    // 基础版：全锁
    if (!canFull && !canDiscount && !canRecharge) {
      $('marketingLockedAll').style.display = 'block';
      $('marketingPanel').style.display = 'none';
      return;
    }
    $('marketingLockedAll').style.display = 'none';
    $('marketingPanel').style.display = 'block';

    // 折扣分类下拉：填充店铺分类（折扣只能选分类，无全场选项）
    try {
      await loadCategories();
      const sel = $('mktCategory');
      if (sel) {
        const cur = sel.value;
        sel.innerHTML = categories.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
        sel.value = cur;
        if (!sel.value && sel.options.length > 0) sel.selectedIndex = 0;
      }
    } catch (e) { /* 分类加载失败不阻塞 */ }

    // 折扣：非尊享版锁住
    const discountLocked = !canDiscount;
    $('discountLockedInline').style.display = discountLocked ? 'block' : 'none';
    $('discountTableWrap').style.display = discountLocked ? 'none' : 'block';
    $('mktCards-discount').style.display = discountLocked ? 'none' : 'block';
    $('mktAdd-discount').disabled = discountLocked;
    $('mktAdd-discount').style.opacity = discountLocked ? '0.5' : '1';

    // 充值送：非尊享版锁住
    const rechargeLocked = !canRecharge;
    $('rechargeLockedInline').style.display = rechargeLocked ? 'block' : 'none';
    $('rechargeTableWrap').style.display = rechargeLocked ? 'none' : 'block';
    $('mktCards-rechargeBonus').style.display = rechargeLocked ? 'none' : 'block';
    $('mktAdd-rechargeBonus').disabled = rechargeLocked;
    $('mktAdd-rechargeBonus').style.opacity = rechargeLocked ? '0.5' : '1';

    // 拉取本店活动列表
    const res = await api('/api/marketing');
    _mktList = (res.success && Array.isArray(res.data)) ? res.data : [];
    renderMarketing();

    // 空状态引导：从未创建过活动的商家（可关闭，localStorage 按店铺记忆）
    const guide = $('mktGuide');
    if (guide) {
      const guideKey = 'guide_dismiss_' + SHOP_ID + '_mkt';
      guide.style.display = (_mktList.length === 0 && localStorage.getItem(guideKey) !== '1') ? 'flex' : 'none';
      if (!guide._bound) {
        guide._bound = true;
        guide.querySelector('.guide-close').onclick = () => {
          localStorage.setItem(guideKey, '1');
          guide.style.display = 'none';
        };
      }
    }
  } catch (e) {
    console.error('loadMarketing', e);
    toast('营销活动加载失败', true);
  }
}

function renderMarketing() {
  MKT_TYPES.forEach(type => {
    const list = _mktList.filter(a => a.type === type);
    const body = $(`mktBody-${type}`);
    const cards = $(`mktCards-${type}`);
    if (!list.length) {
      if (body) body.innerHTML = `<tr><td colspan="5" class="empty">暂无${MKT_TYPE_NAME[type]}活动，点击右上角新建</td></tr>`;
      if (cards) cards.innerHTML = `<div class="empty" style="padding:30px 16px;text-align:center;color:#9ca3af;">暂无${MKT_TYPE_NAME[type]}活动</div>`;
      return;
    }
    // 桌面表格
    if (body) {
      body.innerHTML = list.map(a => {
        const st = mktStatus(a);
        return `<tr>
          <td>${esc(a.title || '—')}</td>
          <td>${mktRuleText(a)}</td>
          <td>${mktTimeText(a)}</td>
          <td><span class="${st.cls}" style="padding:2px 10px;border-radius:999px;font-size:12px;">${st.text}</span></td>
          <td><div class="row-actions">
            <label class="toggle" title="${a.enabled ? '点击停用' : '点击启用'}">
              <input type="checkbox" data-act="toggle" data-id="${esc(a._id)}" ${a.enabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
            <button class="btn btn-blue" data-act="edit" data-id="${esc(a._id)}">编辑</button>
            <button class="btn btn-red" data-act="del" data-id="${esc(a._id)}">删除</button>
          </div></td>
        </tr>`;
      }).join('');
      body.querySelectorAll('button[data-act]').forEach(btn => {
        btn.onclick = () => mktAction(btn.dataset.act, btn.dataset.id);
      });
      body.querySelectorAll('input[data-act="toggle"]').forEach(chk => {
        chk.onchange = () => mktAction('toggle', chk.dataset.id);
      });
    }
    // 手机卡片（启用开关固定在卡片右上角，与标题同一行）
    if (cards) {
      cards.innerHTML = list.map(a => {
        const st = mktStatus(a);
        return `<div class="mkt-card-m">
          <div class="mcm-head">
            <div class="mcm-title">${esc(a.title || '—')}</div>
            <label class="toggle" title="${a.enabled ? '点击停用' : '点击启用'}">
              <input type="checkbox" data-act="toggle" data-id="${esc(a._id)}" ${a.enabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
          <div class="mcm-rule">${mktRuleText(a)}</div>
          <div class="mcm-time">${mktTimeText(a)}</div>
          <span class="mcm-status ${st.cls}">${st.text}</span>
          <div class="mcm-actions">
            <button class="btn btn-blue" data-act="edit" data-id="${esc(a._id)}">编辑</button>
            <button class="btn btn-red" data-act="del" data-id="${esc(a._id)}">删除</button>
          </div>
        </div>`;
      }).join('');
      cards.querySelectorAll('button[data-act]').forEach(btn => {
        btn.onclick = () => mktAction(btn.dataset.act, btn.dataset.id);
      });
      cards.querySelectorAll('input[data-act="toggle"]').forEach(chk => {
        chk.onchange = () => mktAction('toggle', chk.dataset.id);
      });
    }
  });
}

async function mktAction(act, id) {
  const a = _mktList.find(x => x._id === id);
  if (!a) return;
  if (act === 'edit') openMktModal(a);
  else if (act === 'del') {
    if (!confirm(`确认删除活动「${a.title || mktRuleText(a)}」？`)) return;
    const res = await api(`/api/marketing/${id}`, { method: 'DELETE' });
    if (res.success) { toast('已删除'); await loadMarketing(); }
    else toast(res.message || '删除失败', true);
  } else if (act === 'toggle') {
    const res = await api(`/api/marketing/${id}/toggle`, { method: 'PATCH' });
    if (res.success) { toast(res.message || '已更新'); await loadMarketing(); }
    else {
      renderMarketing(); // 失败时回弹开关状态
      if (res.needUpgrade) { toast(res.message || '会员等级不足', true); }
      else toast(res.message || '操作失败', true);
    }
  }
}

// 弹窗：根据类型切换字段显示
function syncMktFields() {
  const type = $('mktTypeSelect').value;
  document.querySelectorAll('.mkt-fields').forEach(f => {
    f.style.display = f.dataset.type === type ? 'block' : 'none';
  });
}

function openMktModal(a) {
  _mktEditing = a || null;
  const isEdit = !!a;
  $('mktModalTitle').textContent = isEdit ? `编辑${MKT_TYPE_NAME[a.type]}活动` : '新建营销活动';
  // 类型下拉：新建时可选；编辑时锁定为该类型（避免越权改类型）
  const typeSel = $('mktTypeSelect');
  if (isEdit) {
    typeSel.value = a.type;
    typeSel.disabled = true;
  } else {
    typeSel.value = 'fullReduction';
    typeSel.disabled = false;
  }
  $('mktId').value = isEdit ? a._id : '';
  // 清空所有输入
  ['mktThreshold','mktReduce','mktRate','mktRecharge','mktBonus','mktTitle'].forEach(id => $(id).value = '');
  $('mktCategory').value = '';
  if (isEdit) {
    $('mktThreshold').value = a.threshold ?? '';
    $('mktReduce').value = a.reduce ?? '';
    $('mktRate').value = a.rate ?? '';
    $('mktCategory').value = a.category || '';
    $('mktRecharge').value = a.recharge ?? '';
    $('mktBonus').value = a.bonus ?? '';
    $('mktTitle').value = a.title || '';
    $('mktStartTime').value = a.startTime ? toLocalDT(a.startTime) : '';
    $('mktEndTime').value = a.endTime ? toLocalDT(a.endTime) : '';
    $('mktEnabled').checked = a.enabled !== false;
  } else {
    // 新建默认：满减满100减10；折扣选第一个分类95折；开始时间为当前；默认停用（需手动启用）
    $('mktThreshold').value = 100;
    $('mktReduce').value = 10;
    $('mktRate').value = 0.95;
    const catSel = $('mktCategory');
    if (catSel && catSel.options.length > 0) catSel.selectedIndex = 0;
    $('mktStartTime').value = toLocalDT(new Date());
    $('mktEndTime').value = '';
    $('mktEnabled').checked = false;
  }
  syncMktFields();
  $('mktModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeMktModal() {
  $('mktModal').classList.remove('show');
  document.body.style.overflow = '';
  _mktEditing = null;
}
// ISO → datetime-local 输入框格式
function toLocalDT(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

$('mktTypeSelect').onchange = syncMktFields;
$('mktCloseBtn').onclick = closeMktModal;
$('mktCancelBtn').onclick = closeMktModal;
['mktAdd-fullReduction','mktAdd-discount','mktAdd-rechargeBonus'].forEach(id => {
  const el = $(id);
  if (el) el.onclick = () => {
    // 新建时预设对应类型
    const type = id.replace('mktAdd-', '');
    openMktModal(null);
    $('mktTypeSelect').value = type;
    syncMktFields();
  };
});

$('mktSaveBtn').onclick = async () => {
  const type = $('mktTypeSelect').value;
  const body = {
    type,
    title: $('mktTitle').value.trim(),
    enabled: $('mktEnabled').checked,
    startTime: $('mktStartTime').value || undefined,
    endTime: $('mktEndTime').value || null
  };
  if (type === 'fullReduction') {
    body.threshold = Number($('mktThreshold').value);
    body.reduce = Number($('mktReduce').value);
  } else if (type === 'discount') {
    body.rate = Number($('mktRate').value);
    body.category = $('mktCategory').value;
  } else if (type === 'rechargeBonus') {
    body.recharge = Number($('mktRecharge').value);
    body.bonus = Number($('mktBonus').value);
  }
  const btn = $('mktSaveBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const id = $('mktId').value;
    let res;
    if (id) {
      res = await api(`/api/marketing/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      res = await api('/api/marketing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    if (res.success) { toast(res.message || '已保存'); closeMktModal(); await loadMarketing(); }
    else if (res.needUpgrade) { toast(res.message || '会员等级不足', true); }
    else toast(res.message || '保存失败', true);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
};
