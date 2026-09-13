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
      let res;
      try {
        res = await post('/purchase-orders', body, { showError: false });
      } catch (e) {
        // 库存/跌价预警：二次确认后强制下单
        await forceOrder(sid, groups[sid]);
        done++;
        continue;
      }
      done++;
    } catch (e) {
      failed.push(sid);
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

function forceOrder(supplierId, items) {
  return new Promise((resolve, reject) => {
    uni.showModal({
      title: '下单确认',
      content: '该单存在库存或跌价提醒，是否仍要下单？',
      success: async (r) => {
        if (!r.confirm) return reject(new Error('cancel'));
        try {
          await post('/purchase-orders', { supplierId, items, force: true });
          resolve(true);
        } catch (e) { reject(e); }
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
.page { min-height: 100vh; background: #f5f5f5; padding-bottom: 160rpx; }

.search { display: flex; align-items: center; gap: 16rpx; padding: 20rpx; background: #fff; }
.search-input {
  flex: 1; background: #f5f5f5; border-radius: 32rpx;
  padding: 14rpx 24rpx; font-size: 26rpx;
}
.search-btn { font-size: 26rpx; color: #ff6b35; font-weight: 600; }

.cats { white-space: nowrap; background: #fff; padding: 0 12rpx 18rpx; }
.cat {
  display: inline-block; padding: 10rpx 24rpx; margin: 0 8rpx;
  font-size: 24rpx; color: #666; background: #f5f5f5; border-radius: 28rpx;
}
.cat.active { background: #ff6b35; color: #fff; }

.list { padding: 20rpx; }
.prod {
  display: flex; align-items: center; gap: 16rpx;
  background: #fff; border-radius: 16rpx; padding: 24rpx; margin-bottom: 18rpx;
  box-shadow: 0 2rpx 12rpx rgba(0,0,0,.04);
}
.prod-main { flex: 1; display: flex; flex-direction: column; }
.prod-name { font-size: 29rpx; color: #333; font-weight: 500; }
.prod-meta { font-size: 22rpx; color: #999; margin-top: 6rpx; }
.prod-price { font-size: 30rpx; color: #ff6b35; font-weight: 700; margin-top: 8rpx; }
.prod-unit { font-size: 22rpx; color: #bbb; font-weight: 400; }
.add-btn {
  background: #ff6b35; color: #fff; border-radius: 30rpx;
  font-size: 24rpx; height: 60rpx; line-height: 60rpx; padding: 0 28rpx;
}
.empty { padding: 140rpx 0; text-align: center; color: #aaa; font-size: 26rpx; }

.cart-bar {
  position: fixed; left: 20rpx; right: 20rpx; bottom: 20rpx;
  background: #1f1f1f; border-radius: 44rpx; padding: 14rpx 14rpx 14rpx 30rpx;
  display: flex; align-items: center; justify-content: space-between;
  box-shadow: 0 8rpx 24rpx rgba(0,0,0,.2);
}
.cart-info { display: flex; align-items: center; gap: 14rpx; flex: 1; }
.cart-num {
  background: #ff6b35; color: #fff; border-radius: 50%;
  min-width: 40rpx; height: 40rpx; line-height: 40rpx; text-align: center; font-size: 22rpx;
}
.cart-text { color: #fff; font-size: 25rpx; }
.submit {
  background: #ff6b35; color: #fff; border-radius: 34rpx;
  font-size: 26rpx; height: 68rpx; line-height: 68rpx; padding: 0 32rpx;
}

.mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.45);
  display: flex; align-items: flex-end; z-index: 99;
}
.sheet {
  width: 100%; background: #fff; border-radius: 24rpx 24rpx 0 0;
  padding: 32rpx 32rpx calc(32rpx + env(safe-area-inset-bottom));
}
.sheet-title { font-size: 32rpx; font-weight: 700; color: #333; }
.sheet-sub { font-size: 24rpx; color: #999; margin-top: 8rpx; }
.qty-row { display: flex; align-items: center; justify-content: center; gap: 30rpx; margin: 36rpx 0; }
.qty-btn {
  width: 72rpx; height: 72rpx; line-height: 72rpx; text-align: center;
  background: #f5f5f5; border-radius: 50%; font-size: 36rpx; color: #333;
}
.qty-input {
  width: 160rpx; text-align: center; font-size: 32rpx;
  border-bottom: 2rpx solid #eee; padding: 10rpx 0;
}
.sheet-btn {
  background: #ff6b35; color: #fff; border-radius: 40rpx;
  font-size: 30rpx; height: 82rpx; line-height: 82rpx; margin-top: 10rpx;
}
.cart-list { max-height: 46vh; margin: 20rpx 0; }
.cart-item {
  display: flex; align-items: center; gap: 16rpx;
  padding: 20rpx 0; border-bottom: 1rpx solid #f5f5f5;
}
.cart-main { flex: 1; display: flex; flex-direction: column; }
.cart-name { font-size: 27rpx; color: #333; }
.cart-meta { font-size: 22rpx; color: #999; margin-top: 4rpx; }
.cart-qty { font-size: 26rpx; color: #ff6b35; font-weight: 600; }
.cart-del { font-size: 24rpx; color: #bbb; }
.cart-note { font-size: 22rpx; color: #bbb; margin-bottom: 16rpx; }
button::after { border: none; }

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .search, .cats, .prod, .sheet { background: #1e1e1e; }
  .prod-name, .sheet-title { color: #e6e6e6; }
  .search-input, .cat, .qty-btn { background: #2a2a2a; color: #ddd; }
}
</style>
