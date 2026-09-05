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
  const initTab = (h && ['dishes','tables','orders','stats','decorate','settings','member','coin','mall','purchase','points','marketing'].includes(h)) ? h : 'dishes';
  try { switchTab(initTab); } catch (e) { console.error('初始化失败', e); }
  // 新手开张四步曲任务卡（首页顶部，状态实时检测）
  try { loadOnboarding(); } catch (e) { console.error('新手任务加载失败', e); }
}

/* ---------- 侧边栏导航 ---------- */
function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach(x => x.classList.toggle('active', x.id === 'pane-' + tab));
  closeSidebar();
  try {
    if (tab === 'dishes') loadDishes();
    if (tab === 'tables') loadTables();
    if (tab === 'orders') loadOrders();
    if (tab === 'stats') loadStats();
    if (tab === 'decorate') loadDecorate();
    if (tab === 'settings') loadSettings();
    if (tab === 'member') loadMemberCenter();
    if (tab === 'coin') loadCoinCenter();
    if (tab === 'mall') { loadMall(); reportOnboardStep('mall'); }
    if (tab === 'purchase') loadPurchaseOrders();
    if (tab === 'points') loadPoints();
    if (tab === 'marketing') loadMarketing();
  } catch (e) { console.error('tab load error', tab, e); }
}
document.querySelectorAll('.nav-item').forEach(t => t.onclick = () => switchTab(t.dataset.tab));

/* ---------- 升级引导统一入口 ----------
   所有"去升级/升级会员/升级尊享版"按钮统一跳会员中心并定位目标人民币卡片：
   advanced → 进阶版 ¥99/月卡片（vplanAdvanced）；premium → 尊享版 ¥199/月卡片（vplanPremium）。
   落地后目标卡片 2 秒呼吸高亮。
   若该商家鼎恒币余额达标（advanced≥3000 / premium≥5000）且本次访问未弹过，
   弹出精致小对话框引导前往鼎恒币兑换专区免费兑换（同一次访问最多弹一次）。 */
function goUpgrade(target) {
  switchTab('member');
  requestAnimationFrame(() => {
    // 1. 定位到对应人民币卡片（vplanAdvanced / vplanPremium）并 2 秒呼吸高亮
    const planCardId = target === 'premium' ? 'vplanPremium' : 'vplanAdvanced';
    const planEl = $(planCardId);
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
  const planName = target === 'premium' ? '尊享版' : '进阶版';
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
    // advanced 兑换卡片无独立 id，用按钮锚点；premium 用 ezPremiumCard
    let el = target === 'premium' ? $('ezPremiumCard') : ($('ezBtnAdvanced') && $('ezBtnAdvanced').closest('.ez-card'));
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
    // 全部完成且未发奖：自动领奖（后端幂等，重复调用不会重复发币）
    if (_obData.allDone && !_obData.giftClaimed && !_obClaiming) {
      claimOnboardingGift();
    }
  } catch (e) { /* 引导模块异常不阻塞后台主流程 */ }
}

function renderOnboarding(prevTasks) {
  const card = $('onboardCard');
  if (!card || !_obData) return;
  // 手动"不再显示"或四步全部完成且奖已到账 → 卡片自动消失
  const hidden = localStorage.getItem(OB_HIDE_KEY) === '1';
  const finished = _obData.allDone && _obData.giftClaimed;
  if (hidden || finished) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  // 金色欢迎语：首月赠送进阶版生效期间显示
  const giftLine = $('obGiftLine');
  if (giftLine) giftLine.style.display = (_obData.trial && _obData.trial.active) ? 'block' : 'none';

  const tasks = _obData.tasks || {};
  const doneCount = OB_TASKS.filter(t => tasks[t.key]).length;
  $('obCount').textContent = doneCount + '/4';

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

/* ===================== 菜单管理 ===================== */
async function loadCategories() {
  const res = await api('/api/categories');
  categories = res.data || [];
  return categories;
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
}

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
  $('printerFields').classList.toggle('show', !!s.enablePrinter);
  $('wechatFields').classList.toggle('show', !!s.enableWechat);
}

/* ===================== 店铺装修（独立栏目） ===================== */
let _decoState = { theme: 'classic', shopNameFont: 'modern', layout: 'list', bannerImage: '', logoImage: '', promoPoster: '', promoPosterSize: 'small', shopName: '鼎恒餐饮' };
let _decoSelected = { theme: null, shopNameFont: null, layout: null }; // 选中态（未应用），null 表示未选中

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
    notifyPhone: $('setNotifyPhone').value.trim()
  };
  if (!body.shopName) { toast('请输入店铺名称', true); return; }
  if (body.enablePrinter && !body.printerSN) { toast('请填写打印机编号', true); return; }
  if (body.enableWechat && !body.notifyPhone) { toast('请填写通知手机号', true); return; }
  const res = await api('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (res.success) toast('保存成功');
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

/* ===================== 鼎恒币中心 ===================== */
const LEVEL_NAME = { basic: '基础版', advanced: '进阶版', premium: '尊享版' };
const LEVEL_RANK = { basic: 0, advanced: 1, premium: 2 };
const LEVEL_COUPON_MAX = { basic: 'purchase_30', advanced: 'purchase_100', premium: 'purchase_200' };
// 会员采购返币率（币/元）：与后端 utils/dhConfig.js coinRate 保持一致
const COIN_RATE = { basic: 0.5, advanced: 1, premium: 1 };

// 鼎恒币中心页面加载
let _coinCenterData = null; // 缓存，方便兑换后刷新
async function loadCoinCenter() {
  try {
    const [status, history] = await Promise.all([
      api(`/api/coin/status/${SHOP_ID}`),
      api(`/api/coin/history/${SHOP_ID}`)
    ]);

    // 顶部余额与会员
    _coinCenterData = status.data || {};
    const d = _coinCenterData;
    const currentLevel = d.memberLevel || 'basic';
    $('coinBalance').textContent = d.dinghengCoin ?? 0;
    $('coinTotalEarned').textContent = d.totalEarnedCoin ?? 0;
    $('coinMemberLevel').textContent = LEVEL_NAME[currentLevel] || '基础版';
    if (d.memberExpire) {
      $('coinMemberExpire').textContent = '到期 ' + fmtTime(d.memberExpire).slice(0, 10);
    } else {
      $('coinMemberExpire').textContent = '永久有效';
    }

    // 会员续费卡片按钮状态更新
    const renewAdvBtn = $('coinRenewAdvanced');
    const renewPreBtn = $('coinRenewPremium');
    const coinNow = d.dinghengCoin ?? 0;
    if (renewAdvBtn) {
      if (currentLevel === 'premium') {
        renewAdvBtn.disabled = true;
        renewAdvBtn.textContent = '当前已是更高等级';
        renewAdvBtn.title = '尊享版无法降兑为进阶版';
      } else if (coinNow < 3000) {
        renewAdvBtn.disabled = true;
        renewAdvBtn.textContent = `鼎恒币不足（差 ${3000 - coinNow} 币）`;
        renewAdvBtn.title = '';
      } else {
        renewAdvBtn.disabled = false;
        renewAdvBtn.textContent = '兑换进阶版月卡';
        renewAdvBtn.title = '';
      }
    }
    if (renewPreBtn) {
      if (coinNow < 5000 && currentLevel !== 'advanced') {
        renewPreBtn.disabled = true;
        renewPreBtn.textContent = `鼎恒币不足（差 ${5000 - coinNow} 币）`;
      } else {
        renewPreBtn.disabled = false;
        renewPreBtn.textContent = currentLevel === 'advanced' ? '升级到尊享版' : '兑换尊享版月卡';
      }
    }

    const coupons = d.coupons || [];

    // 渲染抵用券兑换网格（固定 6 张，与 dhConfig 一致）+ 2 张未开放预告卡
    const couponConfigs = [
      { type: 'purchase_10', faceValue: 10, coinCost: 600, minOrder: 300, needLevel: 'basic' },
      { type: 'purchase_20', faceValue: 20, coinCost: 1100, minOrder: 500, needLevel: 'basic' },
      { type: 'purchase_30', faceValue: 30, coinCost: 1500, minOrder: 800, needLevel: 'basic' },
      { type: 'purchase_50', faceValue: 50, coinCost: 2400, minOrder: 1200, needLevel: 'advanced' },
      { type: 'purchase_100', faceValue: 100, coinCost: 4500, minOrder: 2500, needLevel: 'advanced' },
      { type: 'purchase_200', faceValue: 200, coinCost: 8000, minOrder: 4000, needLevel: 'premium' }
    ];
    // 未开放预告券（平台商家采购规模达标后开放，仅展示不可兑换；金卡，金色锁定样式）
    const upcomingConfigs = [
      { faceValue: 300, coinCost: 11100, minOrder: 5000 },
      { faceValue: 500, coinCost: 17500, minOrder: 6000 }
    ];
    const normalHtml = couponConfigs.map(c => {
      const locked = LEVEL_RANK[currentLevel] < LEVEL_RANK[c.needLevel];
      const notEnough = (d.dinghengCoin ?? 0) < c.coinCost;
      const canExchange = !locked && !notEnough;
      return `
        <div class="coupon-item ${locked ? 'locked' : ''}">
          <div class="coupon-face">¥${c.faceValue}<small> 抵</small></div>
          <div class="coupon-cost">需 <span>${c.coinCost} DH</span></div>
          <div class="coupon-condition">满 ¥${c.minOrder} 可用 · ${LEVEL_NAME[c.needLevel]}可兑</div>
          ${locked
            ? `<div class="coupon-locked-tip">需升级到 ${LEVEL_NAME[c.needLevel]}</div><button class="btn-add" onclick="goUpgrade('${c.needLevel}')">去升级</button>`
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

// 兑换会员：先弹明细确认框，数字实时按后端同口径计算（不预先写死差价）
// 升级折算规则与后端 routes/coin.js 一致：进阶→尊享 = 剩余天数 × 100 币/天 抵扣差价
const EXCH_DAILY_COIN = { advanced: 100, premium: 167 }; // 与后端 DAILY_COIN 一致（advanced 3000/30=100，premium 5000/30≈167）
async function exchangeMembership(targetLevel) {
  try {
    const res = await api(`/api/coin/status/${SHOP_ID}`);
    const d = res.data || {};
    const curLevel = d.memberLevel || 'basic';
    if (curLevel === 'premium' && targetLevel === 'advanced') {
      toast('当前已是更高等级会员，无法降兑', true);
      return;
    }
    const coin = Number(d.dinghengCoin) || 0;
    const expire = d.memberExpire ? new Date(d.memberExpire) : null;
    const isActive = expire && expire > new Date();
    const daysLeft = isActive ? Math.max(0, Math.ceil((expire - new Date()) / 86400000)) : 0;

    const cfg = PLAN_CFG[targetLevel];
    const price = cfg.coinCost; // 进阶 3000 / 尊享 5000
    let offset = 0;
    let payCoin = price;
    // 仅「进阶→尊享」升级走剩余价值折算；同等级续费 / basic→目标 / 已过期均按全价
    if (curLevel === 'advanced' && targetLevel === 'premium') {
      offset = daysLeft * EXCH_DAILY_COIN.advanced; // 剩余天数 × 100 币/天
      payCoin = Math.max(0, price - offset);
    }
    const after = coin - payCoin;

    // 兑换场景判定：同等级续费 / 升级折算 / 新开通
    const isRenewal = (curLevel === targetLevel && isActive);
    const isUpgrade = (curLevel === 'advanced' && targetLevel === 'premium');

    // 填充明细字段
    $('exchCurLevel').textContent = LEVEL_NAME[curLevel] || '基础版';
    // 剩余天数：续费场景用对比式展示「当前剩余 X 天 → 兑换后 (X+30) 天（+30 天）」，+30 天橙色加粗
    if (isRenewal) {
      const afterDays = daysLeft + 30;
      $('exchDaysLeft').innerHTML =
        `当前剩余 ${daysLeft} 天 → 兑换后 ${afterDays} 天` +
        `（<b style="color:#f97316;">+30 天</b>）`;
    } else {
      $('exchDaysLeft').textContent = isActive ? (daysLeft + ' 天') : '未生效/已过期';
    }
    $('exchTargetLevel').textContent = LEVEL_NAME[targetLevel];
    // 兑换方式：续费 / 升级折算 / 新开通
    $('exchMethod').textContent = isRenewal
      ? '续费（在现有有效期上延长 30 天）'
      : (isUpgrade ? '升级（剩余价值折算抵扣差价）' : '新开通（有效期 30 天）');
    $('exchPrice').textContent = `${price} 币`;
    $('exchOffset').innerHTML = offset > 0
      ? `剩余 ${daysLeft} 天 × 100 币/天 = 抵扣 <b>${offset}</b> 币`
      : '无';
    $('exchPayCoin').textContent = payCoin;
    $('exchCurBalance').textContent = `${coin} 币`;
    $('exchAfterBalance').innerHTML = after < 0
      ? `${after} 币（余额不足）`
      : `${after} 币`;

    const confirmBtn = $('exchConfirmBtn');
    confirmBtn.disabled = after < 0;
    confirmBtn.textContent = after < 0 ? '鼎恒币不足' : '确认兑换';
    confirmBtn.onclick = () => doExchangeMembership(targetLevel);

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
async function doExchangeMembership(targetLevel) {
  const confirmBtn = $('exchConfirmBtn');
  confirmBtn.disabled = true;
  confirmBtn.textContent = '兑换中...';
  try {
    const res = await api('/api/coin/exchange-membership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: SHOP_ID, targetLevel })
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
// 会员销售页：状态卡片 + 鼎恒币兑换专区 + 三档权益对比
// 月卡价格/币成本与 utils/dhConfig.js 的 membership 配置保持一致
const PLAN_CFG = {
  advanced: { price: 99, coinCost: 3000 },
  premium: { price: 199, coinCost: 5000 }
};

async function loadMemberCenter() {
  try {
    const res = await api(`/api/coin/status/${SHOP_ID}`);
    const d = res.data || {};
    const level = d.memberLevel || 'basic';
    const expire = d.memberExpire ? new Date(d.memberExpire) : null;
    const daysLeft = expire ? Math.max(0, Math.ceil((expire - new Date()) / 86400000)) : null;

    // 顶部状态卡片：等级 / 到期时间 / 剩余天数
    $('msLevel').textContent = LEVEL_NAME[level] || '基础版';
    $('msExpire').textContent = expire ? fmtTime(d.memberExpire).slice(0, 10) : '永久有效';
    $('msDaysLeft').textContent = expire ? daysLeft + ' 天' : '长期有效';

    // 体验期倒计时胶囊（仅注册赠送的进阶版体验期显示，挂在顶部状态条右侧）
    const isTrial = d.memberIsTrial === true && level === 'advanced' && expire;
    $('msTrialPill').style.display = isTrial ? 'flex' : 'none';
    if (isTrial) $('msTrialDays').textContent = daysLeft;

    // 兑换专区：余额 + 按钮状态（不足时禁用并提示差额；premium 时 advanced 按钮置灰）
    const coin = d.dinghengCoin ?? 0;
    const isPremium = level === 'premium';
    $('ezCoinBalance').textContent = coin;
    $('ezCoinBalance').dataset.loaded = '1'; // 标记已加载，供 waitForCoinLoaded 检测
    for (const key of ['advanced', 'premium']) {
      const btn = $('ezBtn' + (key === 'advanced' ? 'Advanced' : 'Premium'));
      const cost = PLAN_CFG[key].coinCost;
      // premium 时，advanced 按钮置灰不可点
      if (isPremium && key === 'advanced') {
        btn.disabled = true;
        btn.textContent = '当前已是更高等级会员';
        btn.title = '尊享版无法降兑为进阶版';
      } else if (coin < cost) {
        btn.disabled = true;
        btn.textContent = `鼎恒币不足（还差 ${cost - coin} 币）`;
        btn.title = '';
      } else {
        btn.disabled = false;
        btn.textContent = key === 'advanced' ? '立即兑换进阶版' : '立即兑换尊享版';
        btn.title = '';
      }
    }
  } catch (e) {
    console.error(e);
    toast('加载会员数据失败', true);
  }
}

// 现金支付暂未接入：弹窗提示联系客服
function openPayTip() {
  $('payTipModal').classList.add('show');
}
function closePayTip() {
  $('payTipModal').classList.remove('show');
}
window.openPayTip = openPayTip;
window.closePayTip = closePayTip;

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
async function loadMall() {
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

// 本月鼎恒币进度条 + 从未采购空状态引导卡（引导卡可关闭，localStorage 按店铺记忆）
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
      const fill = $('mpFill');
      const targetEl = $('mpTarget');
      if (d.target) {
        fill.style.width = (d.target.percent || 0) + '%';
        targetEl.textContent = d.allReached
          ? '本月兑换目标全部达成，继续保持！'
          : `再得 ${d.target.needMore} 币即可兑换${d.target.label}`;
      } else {
        fill.style.width = '0%';
        targetEl.textContent = '';
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

// 顶部鼎恒币激励横幅：统一展示（按规则只保留指定文案）
function renderMallCoinBanner() {
  const head = `🎁 采购即得鼎恒币：会员每采购 1 元 = 1 币，币可兑采购抵用券、兑会员月卡`;
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
        <div class="product-price">¥${Number(p.costPrice).toFixed(2)}<small> 批发价 / ${esc(unit)}</small></div>
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
function renderStoreProducts() {
  const grid = $('productGrid');
  const list = _mallCategory === 'all'
    ? _mallProducts
    : _mallProducts.filter(p => p.category === _mallCategory);
  if (!list.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">${_mallCategory === 'all' ? '该店铺暂无上架商品' : `「${_mallCategory}」分类下暂无商品`}</div>`;
    return;
  }
  grid.innerHTML = list.map(p => {
    const qtyVal = _mallPendingQty[p._id] || 1;
    const unit = p.unit || '个';
    const desc = p.description ? `<div class="product-supplier">${esc(p.description)}</div>` : '';
    // 品类得币倍率标注：接口返回 coinMultiplier（未配置默认 1）；>1 高亮激励，=1 普通展示
    const coinMult = Number(p.coinMultiplier);
    const multVal = (!isNaN(coinMult) && coinMult > 0) ? coinMult : 1;
    const coinBadge = multVal > 1
      ? `<div class="coin-boost">🪙 该品类 ${multVal} 倍得币</div>`
      : `<div class="coin-boost coin-boost-normal">🪙 该品类 1 倍得币</div>`;
    return `
      <div class="product-card">
        <div class="product-img">${p.image ? `<img src="${esc(p.image)}" alt="" onerror="this.parentElement.innerHTML='📦'">` : '📦'}</div>
        <div class="product-body">
          <div class="product-name">${esc(p.name)}</div>
          <div class="product-category">规格：${esc(unit)}${p.category ? ' · ' + esc(p.category) : ''}</div>
          ${coinBadge}
          <div class="product-price">¥${Number(p.costPrice).toFixed(2)}<small> 批发价</small></div>
          ${desc}
          <div class="product-actions">
            <div class="qty-ctrl">
              <button onclick="adjustQty('${p._id}', -1)">−</button>
              <input type="number" min="1" value="${qtyVal}" data-pid="${p._id}" oninput="setQty('${p._id}', this.value)">
              <button onclick="adjustQty('${p._id}', 1)">+</button>
            </div>
            <button class="btn-cart" data-add="${p._id}" onclick="addToCart('${p._id}')">加入采购车</button>
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
      unitPrice: p.costPrice,
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
  if (!orderRes.success) { toast(orderRes.message || '下单失败', true); return; }

  toast('采购订单已提交！');
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
  if (!orders.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">暂无采购订单</td></tr>`;
    if (cardList) cardList.innerHTML = `<div class="empty">暂无采购订单</div>`;
    return;
  }
  // 后端已 populate supplierId 为对象（含 name），直接取；兼容旧字符串 id
  const badgeCls = {
    '待确认': 'b-gray', '已确认': 'b-blue', '已发货': 'b-orange', '已完成': 'b-green'
  };
  // 桌面端表格行
  body.innerHTML = orders.map(o => {
    const sup = o.supplierId;
    const supplierName = (sup && typeof sup === 'object' && sup.name) ? sup.name : (typeof sup === 'string' ? sup : '未知供应商');
    const itemsText = (o.items || []).slice(0, 2).map(i => `${esc(i.name)}×${i.quantity}`).join('，') + (o.items?.length > 2 ? '…' : '');
    const bc = badgeCls[o.status] || 'b-gray';
    const actionHtml = o.status === '已发货'
      ? `<button class="btn btn-orange" data-id="${o._id}">确认收货</button>`
      : (o.status === '已完成' ? `<span style="color:#16a34a;">✓ 已返 ${o.rewardCoin || 0} DH</span>` : '—');

    return `
      <tr>
        <td><b>${esc(o.orderNo || o._id)}</b><br><small style="color:#9ca3af;">${fmtTime(o.createdAt)}</small></td>
        <td>${esc(supplierName)}</td>
        <td title="${esc((o.items || []).map(i => `${i.name}×${i.quantity}`).join('，'))}">${esc(itemsText)}</td>
        <td>¥${Number(o.totalAmount).toFixed(2)}</td>
        <td><span class="badge ${bc}">${o.status}</span></td>
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
      const itemsCount = (o.items || []).length;
      const itemsSummary = (o.items || []).slice(0, 3).map(i => `${esc(i.name)}×${i.quantity}`).join('，') + (itemsCount > 3 ? ` 等 ${itemsCount} 项` : '');
      const bc = badgeCls[o.status] || 'b-gray';
      const totalAmt = Number(o.totalAmount || 0);
      const discount = Number(o.discountAmount || 0);
      const actualPay = Number(o.actualPayAmount || totalAmt);
      const rewardCoin = o.rewardCoin || 0;
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
          <div class="pcard-items">${itemsSummary || '无商品'}</div>
          <div class="pcard-amounts">
            <span class="pcard-amount">总额 <b>¥${totalAmt.toFixed(2)}</b></span>
            ${discount > 0 ? `<span class="pcard-amount discount">券抵扣 <b>-¥${discount.toFixed(2)}</b></span>` : ''}
            <span class="pcard-amount pay">实付 <b>¥${actualPay.toFixed(2)}</b></span>
            ${o.status === '已完成' ? `<span class="pcard-amount coin">返币 <b>${rewardCoin} DH</b></span>` : ''}
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

/* ===================== 顾客积分 ===================== */
let _ptDishes = [];                 // 本店菜单缓存（积分换菜下拉用）
let _ptExchangeDishes = [];         // 待保存的兑换菜品列表 [{ dishId, dishName, points }]

async function loadPoints() {
  try {
    const perm = await api(`/api/member/permissions/${SHOP_ID}`);
    const memberLevel = perm.data?.memberLevel || 'basic';
    const unlocked = memberLevel !== 'basic'; // advanced / premium 均解锁
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
