<template>
  <view class="page">
    <!-- 搜索 -->
    <view class="search">
      <input class="search-input" v-model="keyword" placeholder="搜索商品名 / 供应商" confirm-type="search" @confirm="applyFilter" />
      <text class="search-btn" @tap="applyFilter">搜索</text>
    </view>

    <!-- 分类 -->
    <scroll-view class="cats" scroll-x>
      <view class="cat" :class="{ active: cat === '' }" @tap="setCat('')">全部</view>
      <view class="cat" v-for="c in categories" :key="c" :class="{ active: cat === c }" @tap="setCat(c)">{{ c }}</view>
    </scroll-view>

    <!-- 商品列表 -->
    <view v-if="filtered.length" class="list">
      <view class="prod" v-for="p in filtered" :key="p._id">
        <view class="prod-main">
          <text class="prod-name">{{ p.name }}</text>
          <text class="prod-meta">{{ p.category || '未分类' }} · {{ supplierName(p) }}</text>
          <text class="prod-price">¥{{ money(p.salePrice) }}<text class="prod-unit">/{{ p.unit || '份' }}</text></text>
          <text class="prod-save" v-if="saveAmount(p) > 0">市场参考 ¥{{ money(p.refPrice) }} · 省 ¥{{ money(saveAmount(p)) }}</text>
        </view>
        <button class="add-btn" @tap="openQty(p)">加购</button>
      </view>
    </view>
    <view v-else class="empty">{{ loaded ? '暂无在售商品' : '加载中…' }}</view>

    <!-- 底部采购车 -->
    <view class="cart-bar" v-if="cart.length">
      <view class="cart-info" @tap="showCart = true">
        <text class="cart-num">{{ cartCount }}</text>
        <text class="cart-text">已选 {{ cart.length }} 种 · ¥{{ money(cartTotal) }}</text>
      </view>
      <button class="submit" :loading="submitting" @tap="submit">提交采购订单</button>
    </view>

    <!-- 数量选择 -->
    <view class="mask" v-if="qtyProduct" @tap="qtyProduct = null">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">{{ qtyProduct.name }}</view>
        <view class="sheet-sub">¥{{ money(qtyProduct.salePrice) }}/{{ qtyProduct.unit || '份' }} · {{ supplierName(qtyProduct) }}</view>
        <view class="qty-row">
          <text class="qty-btn" @tap="decQty">－</text>
          <input class="qty-input" type="number" v-model="qty" />
          <text class="qty-btn" @tap="incQty">＋</text>
        </view>
        <button class="sheet-btn" @tap="addToCart">加入采购单</button>
      </view>
    </view>

    <!-- 购物车明细 -->
    <view class="mask" v-if="showCart" @tap="showCart = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">采购单明细</view>
        <scroll-view class="cart-list" scroll-y>
          <view class="cart-item" v-for="(c, i) in cart" :key="i">
            <view class="cart-main">
              <text class="cart-name">{{ c.name }}</text>
              <text class="cart-meta">{{ c.supplierName }} · ¥{{ money(c.price) }}/{{ c.unit || '份' }}</text>
            </view>
            <text class="cart-qty">×{{ c.quantity }}</text>
            <text class="cart-del" @tap="removeItem(i)">删除</text>
          </view>
        </scroll-view>
        <view class="cart-note">同一供应商合并为一单，多供应商将分别下单</view>
        <button class="sheet-btn" :loading="submitting" @tap="submit">提交采购订单（¥{{ money(cartTotal) }}）</button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import { get, post, getToken } from '@/utils/request.js';

const products = ref([]);
const categories = ref([]);
const keyword = ref('');
const cat = ref('');
const loaded = ref(false);

const qtyProduct = ref(null);
const qty = ref(1);
const showCart = ref(false);
const cart = ref([]);
const submitting = ref(false);

function money(v) { return (Number(v) || 0).toFixed(2); }
function supplierIdOf(p) {
  return p && p.supplierId && typeof p.supplierId === 'object' ? String(p.supplierId._id || '') : String((p && p.supplierId) || '');
}
function supplierName(p) {
  if (!p) return '供应商';
  if (p.supplierName) return p.supplierName;
  if (p.supplierId && typeof p.supplierId === 'object' && p.supplierId.name) return p.supplierId.name;
  return '供应商';
}
function applyFilter() { /* computed 自动响应 */ }
function setCat(c) { cat.value = c; }

const filtered = computed(() => {
  const kw = keyword.value.trim();
  return products.value.filter(p => {
    if (cat.value && (p.category || '') !== cat.value) return false;
    if (!kw) return true;
    return (p.name || '').includes(kw) || supplierName(p).includes(kw);
  });
});

const cartCount = computed(() => cart.value.reduce((s, c) => s + Number(c.quantity || 0), 0));
const cartTotal = computed(() => cart.value.reduce((s, c) => s + Number(c.quantity || 0) * Number(c.price || 0), 0));

async function load() {
  try {
    const list = await get('/supply-products', {}, { showError: false });
    const arr = Array.isArray(list) ? list : ((list && list.data) || []);
    products.value = arr.filter(p => p && p.name);
    const set = new Set();
    products.value.forEach(p => { if (p.category) set.add(p.category); });
    categories.value = [...set];
  } catch (e) {
    products.value = [];
  } finally {
    loaded.value = true;
  }
}

function openQty(p) {
  qtyProduct.value = p;
  qty.value = 1;
}
function incQty() { qty.value = Math.max(1, Number(qty.value || 1) + 1); }
function decQty() { qty.value = Math.max(1, Number(qty.value || 1) - 1); }

function addToCart() {
  const p = qtyProduct.value;
  if (!p) return;
  const n = Math.max(1, Math.floor(Number(qty.value) || 1));
  const pid = String(p._id);
  const exist = cart.value.find(c => c.productId === pid);
  if (exist) exist.quantity += n;
  else {
    cart.value.push({
      productId: pid,
      name: p.name,
      unit: p.unit || '',
      price: Number(p.salePrice) || 0,
      quantity: n,
      supplierId: supplierIdOf(p),
      supplierName: supplierName(p)
    });
  }
  qtyProduct.value = null;
  uni.showToast({ title: '已加入采购单', icon: 'none' });
}

function removeItem(i) {
  cart.value.splice(i, 1);
  if (!cart.value.length) showCart.value = false;
}

async function submit() {
  if (!cart.value.length) return;
  if (submitting.value) return;
  // 按供应商分组（同供应商合并一单）
  const groups = {};
  cart.value.forEach(c => {
    if (!c.supplierId) return;
    if (!groups[c.supplierId]) groups[c.supplierId] = [];
    groups[c.supplierId].push({ productId: c.productId, quantity: c.quantity });
  });
  const supplierIds = Object.keys(groups);
  if (!supplierIds.length) {
    uni.showToast({ title: '商品缺少供应商信息，无法下单', icon: 'none' });
    return;
  }
  submitting.value = true;
  let done = 0;
  const failed = [];
  for (const sid of supplierIds) {
    try {
      const body = { supplierId: sid, items: groups[sid] };
      const created = await post('/purchase-orders', body, { showError: false });
      // 草稿已创建（待支付）：mock 支付阶段自动调用支付接口完成下单；
      // 接入真实微信支付后，此处改为拉起收银台，由支付回调完成落账
      try {
        await payDraft(created._id);
        done++;
      } catch (pe) {
        if (pe.body && pe.body.code === 'CERT_REQUIRED') {
          showCertRequired(pe.body);
          done++; // 订单已保存为待支付草稿，认证后仍可支付
        } else {
          uni.showToast({ title: pe.message || '支付失败，请到订单中支付', icon: 'none' });
          done++;
        }
      }
    } catch (e) {
      if (e.body && e.body.code === 'CERT_REQUIRED') {
        // 认证门控：未认证且不符首单直通 → 订单挂起为待支付草稿，引导完成认证
        showCertRequired(e.body);
        done++;
      } else if (e.body && e.body.code === 'STOCKPILE_WARNING') {
        // 库存/跌价预警：二次确认后强制下单
        await forceOrder(sid, groups[sid]);
        done++;
      } else {
        uni.showToast({ title: e.message || '下单失败', icon: 'none' });
        failed.push(sid);
      }
    }
  }
  submitting.value = false;
  if (failed.length) {
    uni.showToast({ title: `部分失败（${failed.length} 家供应商）`, icon: 'none' });
  } else if (done) {
    uni.showToast({ title: '采购订单已提交', icon: 'success' });
    cart.value = [];
    showCart.value = false;
    setTimeout(() => uni.switchTab({ url: '/pages/admin/purchase' }), 700);
  }
}

// 支付待支付草稿（mock：调用即支付成功；真实微信支付上线后由收银台/回调接管）
async function payDraft(orderId) {
  return post(`/purchase-orders/${orderId}/pay`, {}, { showError: false });
}

// 认证门控拦截提示：列出缺失项，引导商家完成认证（订单保留为待支付草稿，24 小时内可支付）
// 上线加固第一批：blocking（履约必需）/ skippable（首单可暂缓）分流，并提供「去认证」入口
function showCertRequired(body) {
  const d = (body && body.data) || {};
  const blocking = d.missingBlocking || (d.missing && d.missing.blocking) || [];
  const skippable = d.missingSkippable || (d.missing && d.missing.skippable) || [];
  const blockingTxt = blocking.length ? blocking.join('、') : '无';
  const skippableTxt = skippable.length ? skippable.join('、') : '无';
  const content =
    '订单已保存（待支付）。\n\n' +
    '【必须现在补齐 · 否则无法配送】\n' + blockingTxt + '\n\n' +
    (skippable.length ? '【首单可暂缓 · 合规章程】\n' + skippableTxt + '\n\n' : '') +
    (body.message ? body.message + '\n\n' : '') +
    '点「去认证」补全资料；订单保留 24 小时，认证后到「采购单」中重新支付';
  uni.showModal({
    title: '需完成商家认证',
    content,
    confirmText: '去认证',
    cancelText: '稍后',
    success: (r) => {
      if (r.confirm) uni.navigateTo({ url: '/pages/admin/cert' });
    }
  });
}

function forceOrder(supplierId, items) {
  return new Promise((resolve, reject) => {
    uni.showModal({
      title: '下单确认',
      content: '该单存在库存或跌价提醒，是否仍要下单？',
      success: async (r) => {
        if (!r.confirm) return reject(new Error('cancel'));
        try {
          const created = await post('/purchase-orders', { supplierId, items, force: true }, { showError: false });
          // 强制下单的草稿同样走支付（mock 自动完成）
          try {
            await payDraft(created._id);
          } catch (pe) {
            if (pe.body && pe.body.code === 'CERT_REQUIRED') showCertRequired(pe.body);
            else uni.showToast({ title: pe.message || '支付失败，请到订单中支付', icon: 'none' });
          }
          resolve(true);
        } catch (e) {
          if (e.body && e.body.code === 'CERT_REQUIRED') {
            showCertRequired(e.body);
            resolve(true);
          } else { reject(e); }
        }
      },
      fail: () => reject(new Error('fail'))
    });
  });
}

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/index' });
  }
  load();
});
onPullDownRefresh(async () => {
  await load();
  uni.stopPullDownRefresh();
});
</script>

<style lang="scss" scoped>
.page { min-height: 100vh; background: $ink-50; padding-bottom: 160rpx; }

.search { display: flex; align-items: center; gap: 16rpx; padding: 20rpx; background: $surface; }
.search-input {
  flex: 1; background: $ink-50; border-radius: $radius-full;
  padding: 14rpx 24rpx; font-size: $fs-base;
}
.search-btn { font-size: $fs-base; color: $brand; font-weight: $fw-semibold; }

.cats { white-space: nowrap; background: $surface; padding: 0 12rpx 18rpx; }
.cat {
  display: inline-block; padding: 10rpx 24rpx; margin: 0 8rpx;
  font-size: $fs-base; color: $ink-500; background: $ink-50; border-radius: $radius-full;
}
.cat.active { background: $brand-grad; color: #fff; }

.list { padding: 20rpx; }
.prod {
  display: flex; align-items: center; gap: 16rpx;
  background: $surface; border-radius: $radius-lg; padding: 24rpx; margin-bottom: 18rpx;
  box-shadow: $shadow-sm;
}
.prod-main { flex: 1; display: flex; flex-direction: column; }
.prod-name { font-size: $fs-lg; color: $ink-900; font-weight: $fw-medium; }
.prod-meta { font-size: $fs-sm; color: $ink-400; margin-top: 6rpx; }
.prod-price { font-size: $fs-xl; color: $brand; font-weight: $fw-bold; margin-top: 8rpx; }
.prod-unit { font-size: $fs-sm; color: $ink-300; font-weight: $fw-regular; }
.prod-save { font-size: $fs-sm; color: #16a34a; margin-top: 6rpx; }
.add-btn {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-base; font-weight: $fw-semibold; height: 60rpx; line-height: 60rpx; padding: 0 28rpx;
  box-shadow: $shadow-brand;
}
.empty { padding: 140rpx 0; text-align: center; color: $ink-400; font-size: $fs-base; }

.cart-bar {
  position: fixed; left: 20rpx; right: 20rpx; bottom: 20rpx;
  background: $dark; border-radius: $radius-full; padding: 14rpx 14rpx 14rpx 30rpx;
  display: flex; align-items: center; justify-content: space-between;
  box-shadow: $shadow-lg;
}
.cart-info { display: flex; align-items: center; gap: 14rpx; flex: 1; }
.cart-num {
  background: $brand; color: #fff; border-radius: 50%;
  min-width: 40rpx; height: 40rpx; line-height: 40rpx; text-align: center; font-size: $fs-sm;
}
.cart-text { color: #fff; font-size: $fs-base; }
.submit {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-base; font-weight: $fw-semibold; height: 68rpx; line-height: 68rpx; padding: 0 32rpx;
}

.mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.45);
  display: flex; align-items: flex-end; z-index: 99;
}
.sheet {
  width: 100%; background: $surface; border-radius: $radius-lg $radius-lg 0 0;
  padding: 32rpx 32rpx calc(32rpx + env(safe-area-inset-bottom));
}
.sheet-title { font-size: $fs-xl; font-weight: $fw-bold; color: $ink-900; }
.sheet-sub { font-size: $fs-base; color: $ink-400; margin-top: 8rpx; }
.qty-row { display: flex; align-items: center; justify-content: center; gap: 30rpx; margin: 36rpx 0; }
.qty-btn {
  width: 72rpx; height: 72rpx; line-height: 72rpx; text-align: center;
  background: $ink-50; border-radius: 50%; font-size: 36rpx; color: $ink-900;
}
.qty-input {
  width: 160rpx; text-align: center; font-size: $fs-xl;
  border-bottom: 2rpx solid $ink-100; padding: 10rpx 0;
}
.sheet-btn {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-lg; font-weight: $fw-semibold; height: 82rpx; line-height: 82rpx; margin-top: 10rpx;
  box-shadow: $shadow-brand;
}
.cart-list { max-height: 46vh; margin: 20rpx 0; }
.cart-item {
  display: flex; align-items: center; gap: 16rpx;
  padding: 20rpx 0; border-bottom: 1rpx solid $ink-50;
}
.cart-main { flex: 1; display: flex; flex-direction: column; }
.cart-name { font-size: $fs-md; color: $ink-900; }
.cart-meta { font-size: $fs-sm; color: $ink-400; margin-top: 4rpx; }
.cart-qty { font-size: $fs-base; color: $brand; font-weight: $fw-semibold; }
.cart-del { font-size: $fs-base; color: $ink-300; }
.cart-note { font-size: $fs-sm; color: $ink-400; margin-bottom: 16rpx; }
button::after { border: none; }

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .search, .cats, .prod, .sheet { background: #1e1e1e; }
  .prod-name, .sheet-title { color: #e6e6e6; }
  .search-input, .cat, .qty-btn { background: #2a2a2a; color: #ddd; }
}
</style>
