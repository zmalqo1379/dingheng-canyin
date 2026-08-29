/* 鼎恒餐饮 · 管理后台逻辑 */
/* 注意：后端实际接口为 /api/admin/dishes、/api/admin/tables（非 /api/dishes、/api/tables），
   本文件按 server.js 中真实存在的接口调用，未改动 server.js。 */

const ADMIN_PASSWORD = 'admin123'; // 硬编码，不连数据库

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
    const res = await fetch(url, opts).then(r => r.json());
    return res;
  } catch (e) {
    toast('网络错误', true);
    return { success: false, message: 'network' };
  }
}

/* ---------- 登录 ---------- */
function tryLogin() {
  const pwd = $('pwdInput').value.trim();
  if (pwd !== ADMIN_PASSWORD) {
    $('loginError').style.display = 'block';
    $('pwdInput').focus();
    return;
  }
  $('loginError').style.display = 'none';
  $('loginPage').style.display = 'none';
  $('adminPage').classList.add('show');
  switchTab('dishes'); // 默认打开菜单管理
}

$('loginBtn').onclick = tryLogin;
$('pwdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
$('logoutBtn').onclick = () => {
  $('adminPage').classList.remove('show');
  $('loginPage').style.display = 'flex';
  $('pwdInput').value = '';
  $('loginError').style.display = 'none';
};

/* ---------- 侧边栏导航 ---------- */
function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach(x => x.classList.toggle('active', x.id === 'pane-' + tab));
  closeSidebar();
  if (tab === 'dishes') loadDishes();
  if (tab === 'tables') loadTables();
  if (tab === 'orders') loadOrders();
  if (tab === 'stats') loadStats();
  if (tab === 'settings') loadSettings();
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
