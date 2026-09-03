// 顾客点餐页逻辑
const params = new URLSearchParams(location.search);
let tableNumber = params.get('table') || params.get('t') || '';
// 店铺标识：必须从 URL 带 shopId 进入（由商家后台「预览点餐页」新标签打开）
const SHOP_ID = params.get('shopId') || '';
const cart = {}; // { dishId: { dish, quantity } }
let dishes = [];
let categories = [];
let currentCategory = '';

// shopId 缺失校验：缺少店铺标识则提示并停止加载业务内容
function ensureShopId() {
  if (SHOP_ID) return true;
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;';
  mask.innerHTML = '<div style="background:#fff;border-radius:16px;padding:32px 26px;max-width:340px;"><div style="font-size:44px;margin-bottom:12px;">🏪</div><h2 style="font-size:18px;margin-bottom:10px;">缺少店铺标识</h2><p style="font-size:14px;color:#666;line-height:1.6;">请从商家后台「店铺运营 → 预览点餐页」进入，链接需带 <b>shopId</b> 参数。</p></div>';
  document.body.appendChild(mask);
  return false;
}

// 桌号显示格式：纯数字 -> "5号桌"，否则 -> "A1桌"
function formatTable(num) {
  if (!num) return '未选桌';
  return /^\d+$/.test(String(num)) ? `${num}号桌` : `${num}桌`;
}

const toast = (msg) => {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
};

// 加载分类与菜品
async function loadData() {
  try {
    // 所有请求通过 query.shopId 携带店铺标识，后端按此过滤对应商家的数据
    const qs = `shopId=${encodeURIComponent(SHOP_ID)}`;
    const [catRes, dishRes] = await Promise.all([
      fetch(`/api/categories?${qs}`).then(r => r.json()),
      fetch(`/api/dishes?${qs}`).then(r => r.json())
    ]);
    categories = (catRes && catRes.data) ? catRes.data : [];
    // 保留全部菜品（含售罄），由前端显示遮罩
    dishes = (dishRes && dishRes.data) ? dishRes.data : [];
    if (categories.length > 0) currentCategory = categories[0].name;
    renderSidebar();
    renderContent();
    renderCart();
  } catch (e) {
    toast('加载失败，请刷新重试');
  }
}

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (categories.length === 0) {
    sidebar.innerHTML = '<div class="sidebar-empty">暂无分类</div>';
    return;
  }
  sidebar.innerHTML = categories.map(c => `
    <div class="sidebar-item ${c.name === currentCategory ? 'active' : ''}" data-cat="${c.name}">${c.name}</div>
  `).join('');
  sidebar.querySelectorAll('.sidebar-item').forEach(el => {
    el.onclick = () => {
      currentCategory = el.dataset.cat;
      renderSidebar();
      renderContent();
    };
  });
}

function renderContent() {
  const content = document.getElementById('content');
  const list = dishes.filter(d => d.category === currentCategory);
  let html = `<div class="category-title">${currentCategory || ''}</div>`;
  if (list.length === 0) {
    html += '<div class="empty">暂无菜品</div>';
    content.innerHTML = html;
    return;
  }
  html += '<div class="dish-grid">';
  list.forEach(d => {
    const qty = (cart[d._id] && cart[d._id].quantity) || 0;
    const available = d.isAvailable !== false;
    const img = d.image ? d.image : 'https://via.placeholder.com/150';
    html += `
      <div class="dish-card ${available ? '' : 'soldout'}">
        <div class="dish-img-wrap">
          <img class="dish-img" src="${img}" alt="${d.name}" onerror="this.style.display='none'">
          ${available ? '' : '<div class="soldout-mask">已售罄</div>'}
        </div>
        <div class="dish-name">${d.name}</div>
        ${d.description ? `<div class="dish-desc">${d.description}</div>` : ''}
        <div class="dish-bottom">
          <div class="dish-price">¥${d.price}</div>
          <div class="dish-stepper">
            ${qty > 0 ? `<button class="btn-stepper btn-minus" data-id="${d._id}" data-act="minus" ${available ? '' : 'disabled'}>−</button><span class="stepper-num">${qty}</span>` : ''}
            <button class="btn-stepper btn-plus" data-id="${d._id}" data-act="plus" ${available ? '' : 'disabled'}>+</button>
          </div>
        </div>
      </div>`;
  });
  html += '</div>';
  content.innerHTML = html;

  content.querySelectorAll('.btn-stepper').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'plus') {
        const d = dishes.find(x => x._id === id);
        if (!d) return;
        if (!cart[id]) cart[id] = { dish: d, quantity: 0 };
        cart[id].quantity++;
      } else {
        if (cart[id]) {
          cart[id].quantity--;
          if (cart[id].quantity <= 0) delete cart[id];
        }
      }
      renderContent();
      renderCart();
    };
  });
}

function getCartArray() {
  return Object.values(cart).filter(item => item.quantity > 0);
}

function renderCart() {
  const arr = getCartArray();
  const total = arr.reduce((s, i) => s + i.dish.price * i.quantity, 0);
  const count = arr.reduce((s, i) => s + i.quantity, 0);
  const badge = document.getElementById('cartBadge');
  badge.textContent = count;
  badge.style.display = count > 0 ? 'flex' : 'none';
  document.getElementById('cartCount').textContent = `已选 ${count} 件`;
  document.getElementById('cartTotal').textContent = total;
  document.getElementById('checkoutBtn').disabled = count === 0;
}

function openModal() {
  const arr = getCartArray();
  if (arr.length === 0) { toast('请先选择菜品'); return; }
  document.getElementById('modalTable').textContent = formatTable(tableNumber);
  document.getElementById('modalItems').innerHTML = arr.map(i => `
    <div class="modal-item">
      <span class="mi-name">${i.dish.name}</span>
      <span class="mi-qty">× ${i.quantity}</span>
      <span class="mi-price">¥${i.dish.price}</span>
      <span class="mi-sub">¥${i.dish.price * i.quantity}</span>
    </div>`).join('');
  const total = arr.reduce((s, i) => s + i.dish.price * i.quantity, 0);
  document.getElementById('modalTotal').textContent = `¥${total}`;
  document.getElementById('modalMask').classList.add('show');
}

function closeModal() {
  document.getElementById('modalMask').classList.remove('show');
}

// 事件绑定
document.getElementById('checkoutBtn').onclick = openModal;
document.getElementById('modalCancel').onclick = closeModal;
document.getElementById('modalMask').onclick = (e) => {
  if (e.target.id === 'modalMask') closeModal();
};
document.getElementById('cartIcon').onclick = () => {
  if (getCartArray().length === 0) { toast('请先选择菜品'); return; }
  openModal();
};

document.getElementById('modalConfirm').onclick = async () => {
  const arr = getCartArray();
  if (arr.length === 0) { toast('请先选择菜品'); return; }
  if (!tableNumber) { toast('未获取到桌号，请扫码进入'); return; }
  const items = arr.map(i => ({ dishName: i.dish.name, price: i.dish.price, quantity: i.quantity }));
  const btn = document.getElementById('modalConfirm');
  btn.disabled = true;
  btn.textContent = '提交中...';
  try {
    // 下单时通过 x-shop-id 请求头携带店铺标识，后端写入订单 shopId 字段
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shop-id': SHOP_ID
      },
      body: JSON.stringify({ tableNumber, items })
    }).then(r => r.json());
    if (res.success) {
      closeModal();
      // 清空购物车
      Object.keys(cart).forEach(k => delete cart[k]);
      renderContent();
      renderCart();
      // 显示成功提示
      const mask = document.getElementById('successMask');
      mask.classList.add('show');
      setTimeout(() => mask.classList.remove('show'), 2000);
    } else {
      toast(res.message || '下单失败');
    }
  } catch (e) {
    toast('网络错误，请重试');
  } finally {
    btn.disabled = false;
    btn.textContent = '确认下单';
  }
};

// 初始化：缺少 shopId 则停止加载业务内容
document.getElementById('tableInfo').textContent = formatTable(tableNumber);
if (ensureShopId()) loadData();
