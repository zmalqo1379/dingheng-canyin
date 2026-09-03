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
  try { switchTab('dishes'); } catch (e) { console.error('初始化失败', e); }
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
    if (tab === 'settings') loadSettings();
    if (tab === 'member') loadMemberCenter();
    if (tab === 'coin') loadCoinCenter();
    if (tab === 'mall') loadMall();
    if (tab === 'purchase') loadPurchaseOrders();
    if (tab === 'points') loadPoints();
  } catch (e) { console.error('tab load error', tab, e); }
}
document.querySelectorAll('.nav-item').forEach(t => t.onclick = () => switchTab(t.dataset.tab));

/* 移动端侧边栏开关 */
function openSidebar() { $('sidebar').classList.add('open'); $('scrim').classList.add('show'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('scrim').classList.remove('show'); }
$('menuToggle').onclick = openSidebar;
$('scrim').onclick = closeSidebar;

/* ===================== 菜单管理 ===================== */
async function loadCategories() {
  const res = await api('/api/categories');
  categories = res.data || [];
  return categories;
}

async function loadDishes() {
  const res = await api('/api/dishes');
  const body = $('dishesBody');
  const dishes = res.data || [];
  if (!dishes.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">暂无菜品，点击右上角“新增菜品”添加</td></tr>`;
    return;
  }
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
  } else {
    $('dishModalTitle').textContent = '新增菜品';
    $('dishId').value = '';
    $('dishName').value = '';
    $('dishPrice').value = '';
    $('dishImage').value = '';
    $('dishDesc').value = '';
  }
  $('dishModal').classList.add('show');
  setTimeout(() => $('dishName').focus(), 50);
}

$('addDishBtn').onclick = () => openDishModal(null);
$('dishCloseBtn').onclick = closeDishModal;
$('dishCancelBtn').onclick = closeDishModal;
function closeDishModal() { $('dishModal').classList.remove('show'); }
$('dishModal').addEventListener('click', (e) => { if (e.target.id === 'dishModal') closeDishModal(); });

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

/* ===================== 鼎恒币中心 ===================== */
const LEVEL_NAME = { basic: '基础版', advanced: '进阶版', premium: '尊享版' };
const LEVEL_RANK = { basic: 0, advanced: 1, premium: 2 };
const LEVEL_COUPON_MAX = { basic: 'purchase_30', advanced: 'purchase_100', premium: 'purchase_200' };

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
    $('coinBalance').textContent = d.dinghengCoin ?? 0;
    $('coinTotalEarned').textContent = d.totalEarnedCoin ?? 0;
    $('coinMemberLevel').textContent = LEVEL_NAME[d.memberLevel] || '基础版';
    if (d.memberExpire) {
      $('coinMemberExpire').textContent = '到期 ' + fmtTime(d.memberExpire).slice(0, 10);
    } else {
      $('coinMemberExpire').textContent = '永久有效';
    }

    const currentLevel = d.memberLevel || 'basic';
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
    // 未开放预告券（平台商家采购规模达标后开放，仅展示不可兑换）
    const upcomingConfigs = [
      { faceValue: 300, coinCost: 12000, minOrder: 6000 },
      { faceValue: 500, coinCost: 20000, minOrder: 10000 }
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
            ? `<div class="coupon-locked-tip">需升级到 ${LEVEL_NAME[c.needLevel]}</div><button class="btn btn-gray" disabled>等级不足</button>`
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
    const upcomingFoot = `<div class="coupon-upcoming-foot">平台商家采购规模达标后开放，敬请期待</div>`;
    $('couponGrid').innerHTML = normalHtml + upcomingHtml + upcomingFoot;

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

// 兑换会员（在 HTML 的 onclick 中引用，必须挂到 window）
async function exchangeMembership(targetLevel) {
  if (!confirm(`确定兑换${LEVEL_NAME[targetLevel]}月卡？鼎恒币将立即扣减。`)) return;
  const res = await api('/api/coin/exchange-membership', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopId: SHOP_ID, targetLevel })
  });
  if (res.success) {
    toast('兑换成功！');
    loadCoinCenter();
    loadMemberCenter(); // 若停留在会员中心页，同步刷新余额与等级
  } else {
    toast(res.message || '兑换失败', true);
  }
}
window.exchangeMembership = exchangeMembership;
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

    // 兑换专区：余额 + 按钮状态（不足时禁用并提示差额）
    const coin = d.dinghengCoin ?? 0;
    $('ezCoinBalance').textContent = coin;
    for (const key of ['advanced', 'premium']) {
      const btn = $('ezBtn' + (key === 'advanced' ? 'Advanced' : 'Premium'));
      const cost = PLAN_CFG[key].coinCost;
      if (coin < cost) {
        btn.disabled = true;
        btn.textContent = `鼎恒币不足（还差 ${cost - coin} 币）`;
      } else {
        btn.disabled = false;
        btn.textContent = key === 'advanced' ? '立即兑换进阶版' : '立即兑换尊享版';
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
let _mallCategory = 'all';    // 当前分类筛选
let _mallCart = [];           // 当前店铺采购车 [{ productId, name, unit, quantity, unitPrice }]
let _mallCoupons = [];        // 当前商家可用抵用券（status=unused 且未过期）
let _mallMemberLevel = 'basic'; // 当前商家会员等级（用于横幅差异化文案）
let _mallSearchKey = '';      // 店铺列表搜索关键词
let _mallStoreCat = 'all';    // 店铺列表品类筛选标签

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

// 商城入口：拉取供应商列表 + 商家可用券，默认显示店铺列表层
async function loadMall() {
  try {
    const [supRes, statusRes] = await Promise.all([
      api('/api/suppliers'),
      api(`/api/coin/status/${SHOP_ID}`)
    ]);
    _mallSuppliers = (supRes.data || []).filter(s => s && s.name);
    _mallCoupons = ((statusRes.data && statusRes.data.coupons) || []).filter(couponUsable);
    _mallMemberLevel = (statusRes.data && statusRes.data.memberLevel) || 'basic';
    _mallCurrentStore = null;
    _mallCart = [];
    _mallCategory = 'all';
    _mallSearchKey = '';
    _mallStoreCat = 'all';
    renderMallCoinBanner();
    renderMallStoreCatTabs();
    renderStoreList();
    showStoreListView();
  } catch (e) {
    console.error(e);
    toast('加载采购商城失败', true);
  }
}

// 顶部鼎恒币激励横幅：基础版用户看到升级引导文案，进阶/尊享版看到通用文案
function renderMallCoinBanner() {
  const isBasic = _mallMemberLevel === 'basic';
  const basicTail = `（基础版 2 元 = 1 币，<a id="mallBannerUpgrade">升级会员返币翻倍 →</a>）`;
  const head = `🎁 采购即得鼎恒币：会员每采购 1 元 = 1 币，币可兑采购抵用券、兑会员月卡——进货的钱，花得出去，回得来`;
  const el = $('mallCoinBanner');
  el.innerHTML = isBasic ? (head + basicTail) : head;
  el.classList.toggle('basic', isBasic);
  const upg = $('mallBannerUpgrade');
  if (upg) upg.onclick = () => switchTab('member');
}

// 店铺列表品类筛选标签栏 + 搜索框绑定
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
  si.oninput = (e) => { _mallSearchKey = e.target.value.trim(); renderStoreList(); };
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

// 渲染供应商店铺列表（支持搜索 + 品类筛选）
function renderStoreList() {
  const grid = $('storeGrid');
  if (!_mallSuppliers.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">暂无供应商店铺</div>`;
    return;
  }
  // 关键词搜索（店名 + 品类）+ 品类筛选标签
  const key = _mallSearchKey.toLowerCase();
  let list = _mallSuppliers.filter(s => {
    const cats = Array.isArray(s.categories) ? s.categories : [];
    const matchKey = !key
      || String(s.name || '').toLowerCase().includes(key)
      || cats.some(c => String(c).toLowerCase().includes(key));
    const matchCat = _mallStoreCat === 'all' || cats.includes(_mallStoreCat);
    return matchKey && matchCat;
  });
  if (!list.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">没有匹配的供应商店铺</div>`;
    return;
  }
  grid.innerHTML = list.map(s => {
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
  }).join('');
}

// 进入某家供应商店铺（同 section 切换，不跳转新页面）
async function enterStore(supplierId) {
  const s = _mallSuppliers.find(x => String(x._id) === String(supplierId));
  if (!s) { toast('店铺不存在', true); return; }
  _mallCurrentStore = s;
  _mallCart = [];
  _mallCategory = 'all';
  $('mallStoreName').textContent = s.name;
  $('mallProductsTitle').textContent = s.name + ' · 店铺商品';
  $('cartStoreName').textContent = s.name;
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
  _mallProducts = [];
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
    const inCart = _mallCart.find(c => c.productId === p._id);
    const qtyVal = inCart ? inCart.quantity : 1;
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
              <input type="number" min="1" value="${qtyVal}" onchange="setQty('${p._id}', this.value)">
              <button onclick="adjustQty('${p._id}', 1)">+</button>
            </div>
            <button class="btn-cart ${inCart ? 'added' : ''}" onclick="addToCart('${p._id}')">${inCart ? '✓ 已加' : '加入采购车'}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// 数量加减器（最小 1）
function adjustQty(productId, delta) {
  const p = _mallProducts.find(x => x._id === productId);
  if (!p) return;
  const inCart = _mallCart.find(c => c.productId === productId);
  let qty = (inCart ? inCart.quantity : 1) + delta;
  if (qty < 1) qty = 1;
  if (inCart) inCart.quantity = qty;
  const input = document.querySelector(`input[onchange="setQty('${productId}', this.value)"]`);
  if (input) input.value = qty;
  renderCart();
}
function setQty(productId, val) {
  const qty = Math.max(1, parseInt(val) || 1);
  const p = _mallProducts.find(x => x._id === productId);
  if (!p) return;
  const inCart = _mallCart.find(c => c.productId === productId);
  if (inCart) inCart.quantity = qty;
  renderCart();
}

// 加入采购车（只加当前店铺商品，切换店铺已清空）
function addToCart(productId) {
  const p = _mallProducts.find(x => x._id === productId);
  if (!p) return;
  const idx = _mallCart.findIndex(c => c.productId === productId);
  if (idx >= 0) {
    _mallCart[idx].quantity += 1;
  } else {
    _mallCart.push({
      productId: p._id,
      name: p.name,
      unit: p.unit || '个',
      quantity: 1,
      unitPrice: p.costPrice
    });
  }
  renderStoreProducts();
  renderCart();
}

function removeFromCart(productId) {
  _mallCart = _mallCart.filter(c => c.productId !== productId);
  renderStoreProducts();
  renderCart();
}

// 渲染采购车：商品列表 + 小计 + 起送价提示 + 抵用券下拉（门槛校验）+ 折扣 + 应付 + 提交按钮状态
function renderCart() {
  const list = $('cartList');
  const empty = $('cartEmpty');
  const couponSection = $('cartCouponSection');
  const couponSelect = $('cartCouponSelect');
  const discountRow = $('cartDiscountRow');
  const discountEl = $('cartDiscount');
  const subtotalEl = $('cartSubtotal');
  const totalEl = $('cartTotal');
  const submitBtn = $('submitPurchaseBtn');
  const minOrderEl = $('cartMinOrder');

  const store = _mallCurrentStore;
  const minOrder = store ? storeMinOrder(store) : 300;

  if (!_mallCart.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    couponSection.style.display = 'none';
    discountRow.style.display = 'none';
    minOrderEl.style.display = 'none';
    subtotalEl.textContent = '0.00';
    totalEl.textContent = '0.00';
    submitBtn.disabled = true;
    submitBtn.textContent = '采购车为空';
    return;
  }
  empty.style.display = 'none';

  // 已选商品列表
  list.innerHTML = _mallCart.map(c => `
    <div class="cart-item">
      <div class="cart-item-info">
        <div class="cart-item-name">${esc(c.name)}</div>
        <div class="cart-item-meta">${c.quantity} ${esc(c.unit)} × ¥${Number(c.unitPrice).toFixed(2)}</div>
      </div>
      <div class="cart-item-price">¥${(c.quantity * c.unitPrice).toFixed(2)}</div>
      <button class="cart-item-del" onclick="removeFromCart('${c.productId}')">×</button>
    </div>
  `).join('');

  const subtotal = _mallCart.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  subtotalEl.textContent = subtotal.toFixed(2);

  // 起送价提示
  if (subtotal < minOrder) {
    const diff = (minOrder - subtotal).toFixed(2);
    minOrderEl.style.display = 'block';
    minOrderEl.className = 'cart-minorder lack';
    minOrderEl.textContent = `还差 ¥${diff} 起送，继续选购`;
  } else {
    minOrderEl.style.display = 'block';
    minOrderEl.className = 'cart-minorder ok';
    minOrderEl.textContent = `已满 ¥${minOrder} 起送`;
  }

  // 抵用券：按 面额|门槛 分组计数；满足门槛可选，不满足灰显且不可选
  const groups = {};
  _mallCoupons.forEach(c => {
    const key = `${c.faceValue}|${c.minOrder}`;
    if (!groups[key]) groups[key] = { faceValue: c.faceValue, minOrder: c.minOrder, items: [] };
    groups[key].items.push(c);
  });
  const groupList = Object.values(groups).map(g => {
    // 同组取最早过期的那张作为本次使用的券
    g.items.sort((a, b) => new Date(a.expireDate) - new Date(b.expireDate));
    g.first = g.items[0];
    return g;
  });
  groupList.sort((a, b) => a.faceValue - b.faceValue);

  const prevValue = couponSelect.value;
  if (groupList.length > 0) {
    couponSection.style.display = 'block';
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
    couponSelect.innerHTML = opts.join('');
    // 保留之前选中的券（若仍可选）
    if (prevValue && [...couponSelect.options].some(o => o.value === prevValue)) {
      couponSelect.value = prevValue;
    } else {
      couponSelect.value = '';
    }
    couponSelect.onchange = renderCart;
  } else {
    couponSection.style.display = 'none';
    couponSelect.onchange = null;
  }

  // 折扣与应付
  let discount = 0;
  if (couponSection.style.display !== 'none' && couponSelect.value) {
    const opt = couponSelect.querySelector(`option[value="${couponSelect.value}"]`);
    if (opt) discount = Number(opt.getAttribute('data-face') || 0);
  }
  const actual = Math.max(0, subtotal - discount);
  discountRow.style.display = discount > 0 ? 'flex' : 'none';
  discountEl.textContent = discount.toFixed(2);
  totalEl.textContent = actual.toFixed(2);

  // 提交按钮状态：未满起送价则禁用并提示差额
  if (subtotal < minOrder) {
    submitBtn.disabled = true;
    submitBtn.textContent = `还差 ¥${(minOrder - subtotal).toFixed(2)} 起送`;
  } else {
    submitBtn.disabled = false;
    submitBtn.textContent = '提交采购订单';
  }
}

// 提交采购订单（shopId 由后端从 JWT 取；couponId 随单提交，后端同事务核销）
$('submitPurchaseBtn').onclick = async () => {
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
  const couponSelect = $('cartCouponSelect');
  const couponId = (couponSelect && couponSelect.value) || '';

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
  backToStoreList();
  // 提交后刷新可用券缓存（用掉了一张）
  try {
    const st = await api(`/api/coin/status/${SHOP_ID}`);
    _mallCoupons = ((st.data && st.data.coupons) || []).filter(couponUsable);
  } catch (e) { /* ignore */ }
  switchTab('purchase'); // 跳转到采购订单查看
};

/* ===================== 采购订单 ===================== */
let _purchaseFilterStatus = '';

async function loadPurchaseOrders() {
  // 后端按 JWT 中的 shopId 过滤当前商家订单，无需前端再传 shopId
  const statusParam = _purchaseFilterStatus ? `?status=${encodeURIComponent(_purchaseFilterStatus)}` : '';
  const res = await api(`/api/purchase-orders${statusParam}`);
  const body = $('purchaseOrdersBody');
  const orders = res.data || [];
  if (!orders.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">暂无采购订单</td></tr>`;
    return;
  }
  // 后端已 populate supplierId 为对象（含 name），直接取；兼容旧字符串 id
  body.innerHTML = orders.map(o => {
    const sup = o.supplierId;
    const supplierName = (sup && typeof sup === 'object' && sup.name) ? sup.name : (typeof sup === 'string' ? sup : '未知供应商');
    const itemsText = (o.items || []).slice(0, 2).map(i => `${esc(i.name)}×${i.quantity}`).join('，') + (o.items?.length > 2 ? '…' : '');
    const badgeCls = {
      '待确认': 'b-gray', '已确认': 'b-blue', '已发货': 'b-orange', '已完成': 'b-green'
    }[o.status] || 'b-gray';
    const actionHtml = o.status === '已发货'
      ? `<button class="btn btn-orange" data-id="${o._id}">确认收货</button>`
      : (o.status === '已完成' ? `<span style="color:#16a34a;">✓ 已返 ${o.rewardCoin || 0} DH</span>` : '—');

    return `
      <tr>
        <td><b>${esc(o.orderNo || o._id)}</b><br><small style="color:#9ca3af;">${fmtTime(o.createdAt)}</small></td>
        <td>${esc(supplierName)}</td>
        <td title="${esc((o.items || []).map(i => `${i.name}×${i.quantity}`).join('，'))}">${esc(itemsText)}</td>
        <td>¥${Number(o.totalAmount).toFixed(2)}</td>
        <td><span class="badge ${badgeCls}">${o.status}</span></td>
        <td>${o.status === '已完成' ? (o.rewardCoin || 0) + ' DH' : '—'}</td>
        <td>${actionHtml}</td>
      </tr>
    `;
  }).join('');

  // 绑定"确认收货"按钮
  body.querySelectorAll('button[data-id]').forEach(btn => {
    btn.onclick = async () => {
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
  });
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

    // 加载现有 settings 中的积分设置（后端 settings 模型没有积分字段，使用 localStorage 做本地持久化）
    const saved = JSON.parse(localStorage.getItem('pointsSettings') || 'null');
    if (saved) {
      $('setSpendPerPoint').value = saved.spendPerPoint ?? 1;
      $('setPointDeductValue').value = saved.pointDeductValue ?? 0.01;
      $('setPointMinRedeem').value = saved.pointMinRedeem ?? 100;
    } else {
      // 默认值
      $('setSpendPerPoint').value = 1;
      $('setPointDeductValue').value = 0.01;
      $('setPointMinRedeem').value = 100;
    }
  } catch (e) {
    console.error(e);
  }
}

// 保存积分设置（暂存 localStorage，后续接后端 settings 扩展字段）
$('savePointsBtn').onclick = () => {
  const data = {
    spendPerPoint: Number($('setSpendPerPoint').value) || 0,
    pointDeductValue: Number($('setPointDeductValue').value) || 0,
    pointMinRedeem: Number($('setPointMinRedeem').value) || 0
  };
  localStorage.setItem('pointsSettings', JSON.stringify(data));
  toast('积分设置已保存');
};
