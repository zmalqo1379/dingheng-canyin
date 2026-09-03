// ============================================================
// kitchen.js  后厨看单
// 每2秒轮询 pending 订单 · 新订单自动语音播报 · 深色大字主题
// ------------------------------------------------------------
// 语音策略：
//   - 页面加载时调用 GET /api/settings 读取全局 enableVoice
//   - enableVoice=true  → 自动开启播报，无任何弹窗
//   - enableVoice=false → 静默运行，只轮询显示订单不播报
//   - 顶部按钮可临时切换当前页面语音状态（不写回数据库）
//   - 浏览器自动播放策略：通过用户在页面任意位置的首次点击/触摸
//     静默解锁 speechSynthesis，不再弹出强制确认框
// ============================================================

// -------- 1. 注入深色主题样式（覆盖 HTML 内联浅色样式，适合后厨远距离观看） --------
(function injectDarkTheme() {
  const css = `
    body { background: #1a1d24 !important; color: #e8e8e8 !important; }
    .header {
      background: linear-gradient(135deg, #23272f, #2d323c) !important;
      color: #fff !important; padding: 18px 28px !important;
    }
    .header h1 { font-size: 26px !important; }
    .header a { font-size: 22px !important; color: #fff !important; }
    .header-right { font-size: 16px !important; }
    .voice-toggle { background: rgba(255,255,255,0.12) !important; padding: 8px 16px !important; font-size: 16px !important; color: #fff !important; cursor: pointer !important; user-select: none !important; }
    .voice-toggle.on { background: rgba(255,107,53,0.3) !important; }
    .stat-bar { background: #23272f !important; padding: 16px 28px !important; }
    .stat-item { background: #2d323c !important; color: #ccc !important; font-size: 18px !important; padding: 10px 20px !important; }
    .stat-item .num { color: #ff8e53 !important; font-size: 24px !important; }
    .filter-bar { background: #23272f !important; padding: 14px 28px !important; }
    .filter-btn { background: #2d323c !important; color: #ccc !important; font-size: 16px !important; padding: 8px 20px !important; }
    .filter-btn.active { background: #ff6b35 !important; color: #fff !important; }
    .orders-grid { padding: 24px !important; gap: 20px !important; }
    .order-card {
      background: #2a2f3a !important; color: #fff !important;
      border-left: 6px solid #ff6b35 !important; padding: 22px !important;
      border-radius: 16px !important; box-shadow: 0 4px 16px rgba(0,0,0,0.4) !important;
    }
    .order-card.completed { border-left-color: #52c41a !important; opacity: 0.55 !important; }
    .order-card.new { animation: highlightDark 1s ease-in-out 3 !important; border-left-color: #ff2d2d !important; }
    @keyframes highlightDark { 0%,100%{ background:#2a2f3a; } 50%{ background:#4a2820; } }
    .order-table { font-size: 30px !important; color: #ff8e53 !important; font-weight: 800 !important; }
    .order-time { font-size: 16px !important; color: #999 !important; }
    .order-status { font-size: 14px !important; padding: 4px 12px !important; }
    .status-pending { background: rgba(255,107,53,0.2) !important; color: #ff8e53 !important; }
    .status-completed { background: rgba(82,196,26,0.2) !important; color: #52c41a !important; }
    .order-item { font-size: 20px !important; padding: 10px 0 !important; color: #fff !important; border-bottom: 1px dashed #3a3f4a !important; }
    .item-name { font-weight: 600 !important; }
    .item-qty { color: #ff8e53 !important; font-size: 22px !important; font-weight: 800 !important; }
    .order-remark { background: rgba(255,107,53,0.16) !important; color: #ff8e53 !important; font-size: 16px !important; }
    .order-total { font-size: 18px !important; color: #ccc !important; }
    .order-total strong { color: #ff8e53 !important; font-size: 26px !important; }
    .btn-done { background: #ff6b35 !important; color: #fff !important; padding: 12px 28px !important; font-size: 18px !important; border-radius: 10px !important; font-weight: 700 !important; }
    .btn-done:disabled { background: #555 !important; }
    .empty { color: #888 !important; font-size: 22px !important; }
    .empty .icon { font-size: 80px !important; }
    .flash-overlay { border-width: 10px !important; }
    .new-order-banner { font-size: 20px !important; padding: 16px 36px !important; }
  `;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
})();

// -------- 1.x shopId 缺失校验：缺少店铺标识则提示并停止加载业务内容 --------
const SHOP_ID = new URLSearchParams(location.search).get('shopId') || '';
function ensureShopId() {
  if (SHOP_ID) return true;
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;';
  mask.innerHTML = '<div style="background:#16213e;color:#fff;border:2px solid #ff6b35;border-radius:16px;padding:32px 26px;max-width:340px;"><div style="font-size:44px;margin-bottom:12px;">👨‍🍳</div><h2 style="font-size:18px;margin-bottom:10px;">缺少店铺标识</h2><p style="font-size:14px;color:#cbd5e1;line-height:1.6;">请从商家后台「店铺运营 → 后厨看单」进入，链接需带 <b style="color:#ff8e53;">shopId</b> 参数。</p></div>';
  document.body.appendChild(mask);
  return false;
}

// -------- 2. 全局状态 --------
let currentFilter = 'pending';
let voiceEnabled = false;            // 当前页面语音开关（加载时由 /api/settings 决定，可被按钮临时覆盖）
let voiceUnlocked = false;           // 浏览器自动播放策略：是否已通过用户手势解锁
let userToggledVoice = false;        // 用户是否已手动切换过按钮（手动切换后不再被全局设置覆盖）
let firstLoad = true;                // 首次加载标记：先把历史 pending 订单 _id 全部记入 announcedIds，不播报

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// -------- 2.x 菜品图片映射：按菜名索引，订单项据此显示菜品图片 --------
let dishImgMap = {}; // { 菜名: 图片地址 }
async function loadDishImages() {
  try {
    const res = await fetch(`/api/dishes?shopId=${encodeURIComponent(SHOP_ID)}`).then(r => r.json());
    (res.data || []).forEach(d => { dishImgMap[d.name] = d.image || ''; });
  } catch (e) {}
}
let announcedIds = [];               // 已播报过的订单 _id
let highlightIds = new Set();        // 当前高亮中的订单 id（3秒）
let lastRenderKey = '';              // 渲染指纹，避免无变化重渲染打断闪烁
let pollTimer = null;

const speechSupported = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

// -------- 3. 关闭 HTML 中的强制弹窗 + 改造顶部语音按钮 --------
// 修复"管理后台关闭语音后后厨仍强制弹窗"的 bug：不再弹窗询问，直接静默运行
const voiceUnlock = document.getElementById('voiceUnlock');
const voiceUnlockBtn = document.getElementById('voiceUnlockBtn');
const voiceLockTag = document.getElementById('voiceLockTag');
if (voiceUnlock) voiceUnlock.style.display = 'none';           // 隐藏强制弹窗
if (voiceUnlockBtn) voiceUnlockBtn.style.display = 'none';     // 隐藏弹窗内的解锁按钮
if (voiceLockTag) voiceLockTag.style.display = 'none';         // 隐藏"（未解锁）"标签

// 把 HTML 中原本带 checkbox 的 voice-toggle 改造成简洁的状态按钮
const voiceToggle = document.getElementById('voiceToggle');
const voiceCheck = document.getElementById('voiceCheck');
if (voiceCheck) voiceCheck.style.display = 'none';

function updateVoiceButton() {
  if (!voiceToggle) return;
  voiceToggle.classList.toggle('on', voiceEnabled);
  // 用 textContent 清掉原有 checkbox/标签，只显示按钮文字
  voiceToggle.textContent = voiceEnabled ? '🔊 语音开启' : '🔇 语音关闭';
}

// -------- 3.1 静默解锁 speechSynthesis（满足浏览器自动播放策略，无需弹窗） --------
// 浏览器要求至少一次用户手势后 speechSynthesis 才会真正发声。
// 这里监听页面任意位置的首次 click/touchend，悄悄播放一次空内容解锁，
// 不打扰用户、不弹窗。之后新订单即可自动播报。
function unlockVoiceOnFirstGesture() {
  if (!speechSupported || voiceUnlocked) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(' ');
    u.lang = 'zh-CN';
    u.rate = 1;
    u.volume = 0;   // 静音播放，仅用于解锁，不打扰用户
    window.speechSynthesis.speak(u);
    voiceUnlocked = true;
    console.log('语音已通过用户手势静默解锁');
  } catch (e) {
    console.warn('语音解锁失败:', e);
  }
}
document.addEventListener('click', unlockVoiceOnFirstGesture, { once: true });
document.addEventListener('touchend', unlockVoiceOnFirstGesture, { once: true });

// -------- 3.2 顶部按钮：临时切换当前页面语音状态（不写回数据库） --------
if (voiceToggle) {
  voiceToggle.style.cursor = 'pointer';
  voiceToggle.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    voiceEnabled = !voiceEnabled;
    userToggledVoice = true;   // 标记用户已手动切换，后续不再被全局设置覆盖
    updateVoiceButton();
    // 切换到开启时，借这次点击顺手解锁语音（若尚未解锁）
    if (voiceEnabled) unlockVoiceOnFirstGesture();
    console.log('当前页面语音已切换为:', voiceEnabled);
  };
}
updateVoiceButton();   // 初始按钮文字（默认"🔇 语音关闭"，等待 /api/settings 返回后再更新）

// -------- 4. 语音播报函数 --------
// 文案格式："您有新的订单，{tableNumber}桌，{items[0].dishName}一份，请及时处理"
function speakOrder(order) {
  if (!voiceEnabled) {
    // 当前页面语音关闭（可能是全局 enableVoice=false，或厨师临时关闭）
    return;
  }
  if (!speechSupported) return;
  if (!voiceUnlocked) {
    // 浏览器自动播放策略尚未解锁（用户还没在页面点过任何位置），静默跳过
    console.log('语音尚未解锁（等待用户首次点击页面）');
    return;
  }
  const firstDish = (order.items && order.items[0]) ? order.items[0].dishName : '';
  const text = `您有新的订单，${order.tableNumber}桌，${firstDish}一份，请及时处理`;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'zh-CN';
  utter.rate = 1;
  utter.volume = 1;
  window.speechSynthesis.speak(utter);
  console.log('播报:', text);
}

// -------- 4.1 拉取店铺设置：读取全局 enableVoice，决定本页是否播报 --------
async function loadVoiceSettingFromServer() {
  try {
    // 按 URL 的 shopId 取对应商家的设置
    const res = await fetch(`/api/settings?shopId=${encodeURIComponent(SHOP_ID)}`);
    const data = await res.json();
    if (data && data.success && data.data) {
      const enableVoice = data.data.enableVoice !== false;   // 默认 true（仅当显式 false 时关闭）
      // 仅在用户尚未手动切换过时跟随全局设置；用户切换过则尊重当前页面状态
      if (!userToggledVoice) {
        voiceEnabled = enableVoice;
        updateVoiceButton();
        console.log('已读取全局语音设置 enableVoice =', enableVoice);
      }
    }
  } catch (e) {
    // 拉取失败时保持默认（voiceEnabled=false，安静运行）
    console.error('拉取店铺设置失败:', e);
  }
}

// -------- 5. 新订单视觉提醒：全屏红框 + 顶部横幅 --------
function triggerNewOrderAlert(order) {
  const flash = document.getElementById('flashOverlay');
  if (flash) {
    flash.classList.remove('flash-active');
    void flash.offsetWidth; // 重置动画
    flash.classList.add('flash-active');
    setTimeout(() => flash.classList.remove('flash-active'), 3000);
  }
  const banner = document.getElementById('newOrderBanner');
  const txt = document.getElementById('newOrderText');
  if (banner && txt) {
    txt.textContent = `新订单：${order.tableNumber}桌 · ${order.items.reduce((s, i) => s + i.quantity, 0)}道菜`;
    banner.classList.add('show');
    setTimeout(() => banner.classList.remove('show'), 4000);
  }
}

// -------- 6. 时间格式化 --------
function formatTime(iso) {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// 兼容后端返回格式：可能是数组、{orders:[...]} 或本后端 {success,data:[...]}
function parseOrders(data) {
  return Array.isArray(data) ? data : (data.orders || data.data || []);
}

// -------- 7. 轮询：每 2 秒拉取 pending 订单 --------
async function fetchOrders() {
  try {
    const qs = `shopId=${encodeURIComponent(SHOP_ID)}`;
    const res = await fetch(`/api/orders?status=pending&${qs}`);
    const data = await res.json();
    const pendingOrders = parseOrders(data);

    const updateTimeEl = document.getElementById('updateTime');
    if (updateTimeEl) updateTimeEl.textContent = '更新于 ' + formatTime(new Date());

    if (firstLoad) {
      for (const o of pendingOrders) {
        // 只把1分钟前的订单标记为"已播报"，1分钟内的视为新订单，刷新页面也要播报
        const orderTime = new Date(o.createdAt).getTime();
        const now = Date.now();
        if (now - orderTime > 60000) { // 超过1分钟的才算旧订单
          if (!announcedIds.includes(o._id)) announcedIds.push(o._id);
        }
      }
      firstLoad = false;
    } else {
      // 之后每次轮询：检测新订单（_id 不在 announcedIds 中）并播报
      for (const o of pendingOrders) {
        if (!announcedIds.includes(o._id)) {
          speakOrder(o);               // 语音播报（voiceEnabled=false 时内部直接跳过）
          announcedIds.push(o._id);     // 加入 announcedIds，防止重复播报
          highlightIds.add(o._id);      // 卡片高亮 3 秒
          setTimeout(() => highlightIds.delete(o._id), 3000);
          triggerNewOrderAlert(o);      // 红框 + 横幅
        }
      }
    }

    // 订单完成（不再 pending）则从 announcedIds 移除
    const pendingIds = pendingOrders.map(o => o._id);
    announcedIds = announcedIds.filter(id => pendingIds.includes(id));

    // 根据当前过滤视图准备渲染数据
    let renderList = pendingOrders;
    if (currentFilter === 'completed') {
      const cRes = await fetch(`/api/orders?status=completed&${qs}`);
      renderList = parseOrders(await cRes.json());
    } else if (currentFilter === 'all') {
      const aRes = await fetch(`/api/orders?${qs}`);
      renderList = parseOrders(await aRes.json());
    }

    // 仅当订单指纹变化时才重渲染，避免无变化重渲染打断闪烁动画
    const key = renderList.map(o => o._id + ':' + o.status).join('|');
    if (key !== lastRenderKey) {
      renderOrders(renderList);
      lastRenderKey = key;
    }
    loadStats();
  } catch (e) {
    // fetch 失败只 console.error，不中断轮询
    console.error('fetch 失败:', e);
  }
}

// -------- 8. 统计 --------
async function loadStats() {
  try {
    const res = await fetch(`/api/admin/stats?shopId=${encodeURIComponent(SHOP_ID)}`);
    const data = await res.json();
    if (!data || !data.success) return;
    const d = data.data;
    const p = document.getElementById('pendingCount'); if (p) p.textContent = d.pendingCount;
    const t = document.getElementById('totalCount'); if (t) t.textContent = d.orderCount;
    const c = document.getElementById('completedCount'); if (c) c.textContent = d.completedCount;
  } catch (e) {}
}

// -------- 9. 渲染订单卡片：桌号、时间、菜品、总价、完成按钮 --------
function renderOrders(orders) {
  const grid = document.getElementById('ordersGrid');
  const empty = document.getElementById('emptyState');
  if (!orders || orders.length === 0) {
    if (grid) grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (!grid) return;

  grid.innerHTML = orders.map(o => {
    const isNew = o.status === 'pending' && highlightIds.has(o._id);
    const itemsHtml = o.items.map(i => {
      const img = dishImgMap[i.dishName] || '';
      const thumb = img
        ? `<img class="item-thumb" src="${esc(img)}" alt="" onerror="this.outerHTML='<span class=&quot;item-ph&quot;>🍽️</span>'">`
        : `<span class="item-ph">🍽️</span>`;
      return `
      <div class="order-item">
        ${thumb}
        <span class="item-name">${esc(i.dishName)}</span>
        <span class="item-qty">×${i.quantity}</span>
      </div>`;
    }).join('');
    const remarkHtml = o.remark ? `<div class="order-remark">📝 备注：${esc(o.remark)}</div>` : '';
    return `
      <div class="order-card ${o.status === 'completed' ? 'completed' : ''} ${isNew ? 'new' : ''}" data-id="${o._id}">
        <div class="order-header">
          <div>
            <div class="order-table">桌号 ${o.tableNumber}</div>
            <div class="order-time">${formatTime(o.createdAt)}</div>
          </div>
          <span class="order-status status-${o.status}">
            ${o.status === 'pending' ? '待制作' : '已完成'}
          </span>
        </div>
        <div class="order-items">${itemsHtml}</div>
        ${remarkHtml}
        <div class="order-footer">
          <div class="order-total">合计: <strong>¥${o.totalPrice}</strong></div>
          ${o.status === 'pending'
            ? `<button class="btn-done" data-id="${o._id}">完成出餐</button>`
            : '<span style="color:#52c41a;font-size:16px;">✓ 已完成</span>'}
        </div>
      </div>`;
  }).join('');

  // 绑定"完成出餐"按钮
  grid.querySelectorAll('.btn-done').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '处理中...';
      try {
        // 完成订单必须带 x-shop-id，后端按 {_id, shopId} 双重条件匹配，防止窜改
        const res = await fetch(`/api/orders/${btn.dataset.id}/complete`, {
          method: 'PUT',
          headers: { 'x-shop-id': SHOP_ID }
        });
        const data = await res.json();
        if (data && data.success) {
          // 标记完成后从 announcedIds 移除，下次轮询同步
          announcedIds = announcedIds.filter(id => id !== btn.dataset.id);
          lastRenderKey = ''; // 强制重新渲染
          fetchOrders();
        } else {
          alert((data && data.message) || '操作失败');
          btn.disabled = false;
          btn.textContent = '完成出餐';
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '完成出餐';
      }
    };
  });
}

// -------- 10. 过滤切换 --------
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    lastRenderKey = ''; // 切换过滤时强制重新渲染
    fetchOrders();
  };
});

// -------- 11. 启动：页面加载 → 读 /api/settings → 轮询订单 --------
//   enableVoice=true  → 自动开始轮询+播报（无需弹窗确认）
//   enableVoice=false → 只轮询显示订单，不播报
//   厨师可点击右上角按钮临时切换当前页面语音状态
//   缺少 shopId 时停止加载业务内容
if (ensureShopId()) {
  loadVoiceSettingFromServer();               // 拉取一次全局语音设置（不再周期性刷新，避免覆盖厨师临时切换）
  loadDishImages();                           // 拉取菜品图片映射（订单项显示图片用）
  fetchOrders();                              // 立即拉取一次
  pollTimer = setInterval(fetchOrders, 2000); // 每 2 秒轮询，不受语音按钮影响

  // 页面从后台切回前台时立即刷新一次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fetchOrders();
  });
}
