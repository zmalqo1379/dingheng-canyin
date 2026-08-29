// ============================================================
// bigscreen.js  后厨大屏看单
// 每5秒轮询 pending 订单 · 新订单提示音 + 红框闪烁 + 语音播报
// ============================================================

// -------- 全局状态 --------
let displayedIds = [];          // 当前已显示的订单 _id（用于检测新订单）
let firstLoad = true;          // 首次加载：1分钟前的历史订单不播报，1分钟内视为新订单
let highlightIds = new Set();  // 新订单高亮中的卡片（3秒）
let lastRenderKey = '';        // 渲染指纹，避免无变化重渲染打断闪烁动画
let connectionOk = true;       // 服务器连接状态
let systemEnableBigscreen = true; // 后台店铺设置：大屏弹窗总开关（false 时不播放提示音/闪烁/播报）

const POLL_INTERVAL = 5000;    // 轮询间隔 5 秒

const speechSupported = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
const beepAudio = document.getElementById('beepAudio');
const flashOverlay = document.getElementById('flashOverlay');
const errorBanner = document.getElementById('errorBanner');

// -------- 1. 加载店铺名称 & 大屏开关 --------
async function loadShopName() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data && data.success && data.data) {
      if (data.data.shopName) {
        const el = document.getElementById('shopName');
        if (el) el.textContent = data.data.shopName;
      }
      // 同步大屏弹窗总开关
      systemEnableBigscreen = data.data.enableBigscreen !== false;
    }
  } catch (e) { /* 连不上则使用默认名称「鼎恒餐饮」并保持大屏开关默认 */ }
}

// 定时刷新店铺设置（保证后台修改后大屏能及时生效）
async function refreshSystemSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data && data.success && data.data) {
      systemEnableBigscreen = data.data.enableBigscreen !== false;
      if (data.data.shopName) {
        const el = document.getElementById('shopName');
        if (el) el.textContent = data.data.shopName;
      }
    }
  } catch (e) {}
}

// -------- 2. 顶部当前时间（实时，每秒更新） --------
function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const timeEl = document.getElementById('currentTime');
  if (timeEl) timeEl.textContent = `${h}:${m}:${s}`;
  const dateEl = document.getElementById('currentDate');
  if (dateEl) {
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    dateEl.textContent = `${y}-${mo}-${d} 星期${week}`;
  }
}
updateClock();
setInterval(updateClock, 1000);

// -------- 3. 全屏按钮 --------
const btnFullscreen = document.getElementById('btnFullscreen');
if (btnFullscreen) {
  btnFullscreen.addEventListener('click', () => {
    const el = document.documentElement;
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!isFs) {
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  });
  // 全屏状态变化时更新按钮文字
  const updateFsBtn = () => {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    btnFullscreen.textContent = isFs ? '⤡ 退出全屏' : '⤢ 进入全屏';
  };
  document.addEventListener('fullscreenchange', updateFsBtn);
  document.addEventListener('webkitfullscreenchange', updateFsBtn);
}

// -------- 4. 语音解锁（浏览器自动播放策略要求至少一次用户手势） --------
const voiceUnlock = document.getElementById('voiceUnlock');
const voiceUnlockBtn = document.getElementById('voiceUnlockBtn');
let voiceUnlocked = false;

function unlockVoice() {
  voiceUnlocked = true;
  if (voiceUnlock) voiceUnlock.style.display = 'none';
  // 解锁 audio 自动播放（先静音播一次再恢复，满足「用户手势」要求）
  if (beepAudio) {
    beepAudio.muted = true;
    const p = beepAudio.play();
    if (p && typeof p.catch === 'function') {
      p.then(() => { beepAudio.muted = false; }).catch(() => { beepAudio.muted = false; });
    } else {
      beepAudio.muted = false;
    }
  }
  // 解锁语音合成
  if (speechSupported) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance('语音播报已开启');
      u.lang = 'zh-CN'; u.rate = 1; u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
}
if (voiceUnlockBtn) voiceUnlockBtn.addEventListener('click', (e) => { e.stopPropagation(); unlockVoice(); });
if (voiceUnlock) voiceUnlock.addEventListener('click', unlockVoice);

// -------- 5. 播放提示音 --------
function playBeep() {
  if (!beepAudio) return;
  try {
    beepAudio.currentTime = 0;
    const p = beepAudio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

// -------- 6. 语音播报 --------
// 文案："您有新的订单，{tableNumber}桌，{菜品列表}"
function speakOrder(order) {
  if (!speechSupported) return;
  const itemsText = (order.items || []).map(i => `${i.dishName} ${i.quantity}份`).join('，');
  const text = `您有新的订单，${order.tableNumber}桌，${itemsText}`;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'zh-CN';
  utter.rate = 1;
  utter.volume = 1;
  window.speechSynthesis.speak(utter);
  console.log('播报:', text);
}

// -------- 7. 新订单视觉提醒：屏幕四周边框闪烁红色 3 秒 --------
function triggerFlash() {
  if (!flashOverlay) return;
  flashOverlay.classList.remove('flash-active');
  void flashOverlay.offsetWidth; // 重置动画
  flashOverlay.classList.add('flash-active');
  setTimeout(() => flashOverlay.classList.remove('flash-active'), 3000);
}

// -------- 8. 下单时间格式化（仅时分 12:30） --------
function formatOrderTime(iso) {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// -------- 9. 轮询：每 5 秒拉取 pending 订单 --------
async function fetchOrders() {
  try {
    const res = await fetch('/api/orders?status=pending');
    const data = await res.json();
    const orders = (data && data.data) ? data.data : [];

    // 连接恢复
    if (!connectionOk) {
      connectionOk = true;
      if (errorBanner) errorBanner.style.display = 'none';
    }

    // 新订单检测
    const currentIdSet = new Set(orders.map(o => o._id));
    if (firstLoad) {
      // 首次加载：1分钟前的订单视为已显示（不播报），1分钟内的视为新订单（刷新页面也要播报）
      const now = Date.now();
      for (const o of orders) {
        const orderTime = new Date(o.createdAt).getTime();
        if (now - orderTime > 60000) {
          if (!displayedIds.includes(o._id)) displayedIds.push(o._id);
        }
      }
      firstLoad = false;
    } else {
      // 之后每次轮询：检测不在 displayedIds 中的新订单
      for (const o of orders) {
        if (!displayedIds.includes(o._id)) {
          displayedIds.push(o._id);
          highlightIds.add(o._id);
          setTimeout(() => highlightIds.delete(o._id), 3000);
          // 受店铺设置大屏开关控制：关闭时仅静默刷新列表，不播放提示音/闪烁/语音
          if (systemEnableBigscreen) {
            playBeep();       // 提示音
            triggerFlash();   // 红框闪烁
            speakOrder(o);    // 语音播报
          } else {
            console.log('大屏弹窗已被店铺设置关闭，仅静默刷新');
          }
        }
      }
    }

    // 已完成订单（不再 pending）从 displayedIds 移除，保证再次下单时能重新播报
    displayedIds = displayedIds.filter(id => currentIdSet.has(id));

    // 渲染：仅当订单指纹变化时才重渲染，避免无变化重渲染打断闪烁动画
    const key = orders.map(o => o._id).join('|');
    if (key !== lastRenderKey) {
      renderOrders(orders);
      lastRenderKey = key;
    }
  } catch (e) {
    console.error('fetch 失败:', e);
    connectionOk = false;
    if (errorBanner) errorBanner.style.display = 'block';
  }
}

// -------- 10. 渲染订单卡片 --------
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
    const isNew = highlightIds.has(o._id);
    const itemsHtml = (o.items || []).map(i => `
      <div class="item-row">
        <span class="item-name">${i.dishName}</span>
        <span class="item-qty">×${i.quantity}</span>
      </div>`).join('');
    return `
      <div class="order-card ${isNew ? 'new' : ''}" data-id="${o._id}">
        <div class="card-head">
          <div class="table-number">${o.tableNumber}<span class="suffix">桌</span></div>
          <div class="order-meta">
            <div class="order-time">${formatOrderTime(o.createdAt)}</div>
            <div class="order-total"><span class="label">合计</span>¥${o.totalPrice}</div>
          </div>
        </div>
        <div class="items-list">${itemsHtml}</div>
      </div>`;
  }).join('');
}

// -------- 11. 启动 --------
loadShopName();                        // 拉取店铺名称 & 大屏开关
setInterval(refreshSystemSettings, 30000); // 每 30 秒刷新一次店铺设置
fetchOrders();                         // 立即拉取一次
setInterval(fetchOrders, POLL_INTERVAL); // 每 5 秒轮询

// 页面从后台切回前台时立即刷新一次
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fetchOrders();
});
