<template>
  <view class="customer">
    <!-- 顶部店铺信息 -->
    <view class="header">
      <view class="shop-name">{{ shopName || '鼎恒餐饮' }}</view>
      <view class="table-info">
        <text class="tag">桌号 {{ tableId || '--' }}</text>
        <text v-if="shopId" class="tag light">门店 {{ shopId }}</text>
      </view>
    </view>

    <!-- 主体：左侧分类 + 右侧菜品 -->
    <view class="body">
      <scroll-view class="cate" scroll-y :scroll-into-view="'c-' + activeCate">
        <view
          v-for="c in categories"
          :key="c"
          class="cate-item"
          :class="{ on: c === activeCate }"
          @tap="activeCate = c"
        >
          <view class="cate-bar"></view>
          <text>{{ c }}</text>
        </view>
      </scroll-view>

      <scroll-view class="dishes" scroll-y>
        <view class="dish-tip">共 {{ filteredDishes.length }} 道菜</view>
        <view v-for="d in filteredDishes" :key="d._id" class="dish">
          <image
            v-if="d.image"
            class="dish-img"
            :src="d.image"
            mode="aspectFill"
            lazy-load
          />
          <view v-else class="dish-img placeholder">{{ (d.name || '菜').slice(0, 1) }}</view>

          <view class="dish-info">
            <view class="dish-name">{{ d.name }}</view>
            <view class="dish-desc">{{ d.description || '美味推荐' }}</view>
            <view class="dish-bottom">
              <view class="price"><text class="small">¥</text>{{ d.price }}</view>
              <view class="ctrl">
                <view v-if="qty(d._id) > 0" class="btn minus" @tap="change(d, -1)">-</view>
                <view v-if="qty(d._id) > 0" class="num">{{ qty(d._id) }}</view>
                <view v-if="d.isAvailable !== false" class="btn add" @tap="change(d, 1)">+</view>
                <view v-else class="sold">已售罄</view>
              </view>
            </view>
          </view>
        </view>
        <view v-if="!filteredDishes.length" class="empty">该分类暂无菜品</view>
        <view style="height: 200rpx"></view>
      </scroll-view>
    </view>

    <!-- 底部购物车栏 -->
    <view class="cart-bar">
      <view class="cart-left" @tap="showCart = !showCart">
        <view class="cart-icon" :class="{ on: cartCount > 0 }">
          <text class="badge" v-if="cartCount">{{ cartCount }}</text>
          <text class="ic">🛒</text>
        </view>
        <view class="cart-text">
          <view class="total" v-if="cartCount">¥{{ total.toFixed(2) }}</view>
          <view class="total empty" v-else>购物车是空的</view>
          <view class="sub" v-if="cartCount">已选 {{ cartCount }} 件</view>
        </view>
      </view>
      <view class="cart-btn" :class="{ off: !cartCount }" @tap="checkout">
        去结算
      </view>
    </view>

    <!-- 购物车弹层 -->
    <view class="mask" v-if="showCart && cartCount" @tap="showCart = false"></view>
    <view class="cart-pop" v-if="showCart && cartCount">
      <view class="pop-head">
        <text>已选菜品</text>
        <text class="clear" @tap="clearAll">清空</text>
      </view>
      <scroll-view scroll-y class="pop-list">
        <view v-for="c in cart" :key="c._id" class="pop-row">
          <view class="pop-name">{{ c.name }}</view>
          <view class="pop-mid">¥{{ (c.price * c.qty).toFixed(2) }}</view>
          <view class="ctrl">
            <view class="btn minus" @tap="change(c, -1)">-</view>
            <view class="num">{{ c.qty }}</view>
            <view class="btn add" @tap="change(c, 1)">+</view>
          </view>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import { get, post } from '@/utils/request.js';
import { getCart, setCart, clearCart, addPendingOrder, syncPendingOrders } from '@/utils/cart.js';

// 页面参数：扫码进入 pages/customer/index?tableId=5&shopId=xxx
const tableId = ref('');
const shopId = ref('');
const shopName = ref('');

const dishes = ref([]);
const categories = ref(['全部']);
const activeCate = ref('全部');
const cart = ref([]);
const showCart = ref(false);

const filteredDishes = computed(() => {
  if (activeCate.value === '全部') return dishes.value;
  return dishes.value.filter((d) => d.category === activeCate.value);
});
const cartCount = computed(() => cart.value.reduce((s, c) => s + c.qty, 0));
const total = computed(() => cart.value.reduce((s, c) => s + c.price * c.qty, 0));

function qty(id) {
  const f = cart.value.find((c) => c._id === id);
  return f ? f.qty : 0;
}

// 加减菜
function change(d, delta) {
  let f = cart.value.find((c) => c._id === d._id);
  if (!f) {
    if (delta < 0) return;
    f = { _id: d._id, name: d.name, price: d.price, qty: 0 };
    cart.value.push(f);
  }
  f.qty += delta;
  if (f.qty <= 0) {
    cart.value = cart.value.filter((c) => c._id !== d._id);
  }
  persist();
}

function persist() {
  setCart(tableId.value, cart.value);
}

function clearAll() {
  cart.value = [];
  persist();
  showCart.value = false;
}

// 拉取店铺信息 + 菜品
async function loadData() {
  try {
    const setting = await get('/settings');
    shopName.value = (setting && setting.shopName) || '鼎恒餐饮';
  } catch (e) {
    /* settings 失败不阻塞点餐 */
  }

  try {
    const list = await get('/dishes');
    dishes.value = Array.isArray(list) ? list : [];
    // 从菜品里派生分类（要求：用 /api/dishes 获取分类和菜品列表）
    const set = new Set();
    dishes.value.forEach((d) => d.category && set.add(d.category));
    categories.value = ['全部', ...Array.from(set)];
    if (!categories.value.includes(activeCate.value)) activeCate.value = '全部';
  } catch (e) {
    uni.showToast({ title: '菜品加载失败', icon: 'none' });
  }
}

onLoad((options = {}) => {
  tableId.value = options.tableId || '';
  shopId.value = options.shopId || '';
  if (!tableId.value) {
    uni.showToast({ title: '未识别桌号，请在桌牌扫码进入', icon: 'none', duration: 2500 });
  }
  cart.value = getCart(tableId.value);
  loadData();
});

onShow(() => {
  // 回前台时刷新购物车 + 尝试同步离线订单
  cart.value = getCart(tableId.value);
  syncPendingOrders();
});

onPullDownRefresh(() => {
  loadData().finally(() => uni.stopPullDownRefresh());
});

// 结算下单
async function checkout() {
  if (!cartCount.value) {
    uni.showToast({ title: '请先选择菜品', icon: 'none' });
    return;
  }
  if (!tableId.value) {
    uni.showToast({ title: '缺少桌号，无法下单', icon: 'none' });
    return;
  }
  const items = cart.value.map((c) => ({ dishName: c.name, price: c.price, quantity: c.qty }));
  const localId = 'order_' + Date.now();

  uni.showLoading({ title: '提交中...' });
  // 用 POST 创建订单
  try {
    const order = await post('/orders', { tableNumber: String(tableId.value), items });
    // ============ 微信小程序原生支付 ============
    // 后端如返回 paymentParams（含 timeStamp/nonceStr/package/signType/paySign）则调起支付
    if (order && order.paymentParams) {
      try {
        await payOrder(order.paymentParams);
        uni.showToast({ title: '支付成功', icon: 'success' });
      } catch (e) {
        uni.showToast({ title: '支付已取消', icon: 'none' });
        return;
      }
    } else {
      // 当前后端未接入微信支付，下单即视为已下单成功
      uni.showToast({ title: '下单成功，请等待上菜', icon: 'success' });
    }
    clearCart(tableId.value);
    cart.value = [];
    showCart.value = false;
  } catch (e) {
    // 离线保护：失败订单进队列，联网后自动同步
    addPendingOrder({ localId, tableNumber: String(tableId.value), items });
    uni.showToast({ title: '当前网络不佳，订单已缓存，联网后自动提交', icon: 'none', duration: 2500 });
    clearCart(tableId.value);
    cart.value = [];
    showCart.value = false;
  } finally {
    uni.hideLoading();
  }
}

// 封装 wx.requestPayment（uni-app 在微信端即映射为 wx.requestPayment）
function payOrder(params) {
  return new Promise((resolve, reject) => {
    uni.requestPayment({
      provider: 'wxpay',
      timeStamp: params.timeStamp,
      nonceStr: params.nonceStr,
      package: params.package,
      signType: params.signType || 'MD5',
      paySign: params.paySign,
      success: resolve,
      fail: reject
    });
  });
}
</script>

<style lang="scss" scoped>
.customer {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f5f5f5;
}

/* 顶部 */
.header {
  background: linear-gradient(135deg, #ff6b35, #ff8a5c);
  color: #fff;
  padding: 24rpx 32rpx 32rpx;
}
.shop-name { font-size: 40rpx; font-weight: 700; }
.table-info { margin-top: 12rpx; display: flex; gap: 16rpx; }
.tag {
  font-size: 24rpx; padding: 4rpx 18rpx; border-radius: 30rpx;
  background: rgba(255,255,255,.25);
}
.tag.light { background: rgba(255,255,255,.15); }

/* 主体 */
.body { flex: 1; display: flex; min-height: 0; }
.cate {
  width: 180rpx; height: 100%; background: #fff;
  border-right: 1rpx solid #eee;
}
.cate-item {
  position: relative; padding: 28rpx 20rpx; font-size: 26rpx; color: #666;
  display: flex; align-items: center;
}
.cate-bar {
  width: 6rpx; height: 28rpx; background: transparent; border-radius: 6rpx; margin-right: 14rpx;
}
.cate-item.on { color: #ff6b35; font-weight: 600; background: #f5f5f5; }
.cate-item.on .cate-bar { background: #ff6b35; }

.dishes { flex: 1; height: 100%; padding: 0 20rpx; }
.dish-tip { font-size: 24rpx; color: #999; padding: 16rpx 4rpx; }
.dish {
  display: flex; background: #fff; border-radius: 16rpx; padding: 20rpx;
  margin-bottom: 18rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,.04);
}
.dish-img { width: 160rpx; height: 160rpx; border-radius: 12rpx; flex-shrink: 0; background: #f0f0f0; }
.dish-img.placeholder {
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg,#ffd2bf,#ffb59a); color: #fff; font-size: 56rpx; font-weight: 700;
}
.dish-info { flex: 1; margin-left: 20rpx; display: flex; flex-direction: column; justify-content: space-between; }
.dish-name { font-size: 30rpx; font-weight: 600; color: #222; }
.dish-desc { font-size: 24rpx; color: #999; margin-top: 6rpx; }
.dish-bottom { display: flex; align-items: flex-end; justify-content: space-between; }
.price { color: #ff6b35; font-size: 36rpx; font-weight: 700; }
.price .small { font-size: 22rpx; }
.ctrl { display: flex; align-items: center; gap: 14rpx; }
.btn {
  width: 44rpx; height: 44rpx; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; font-size: 34rpx; color: #fff;
  background: #ff6b35; line-height: 1;
}
.btn.minus { background: #fff; color: #ff6b35; border: 2rpx solid #ff6b35; }
.num { font-size: 30rpx; min-width: 36rpx; text-align: center; font-weight: 600; }
.sold { font-size: 24rpx; color: #bbb; }
.empty { text-align: center; color: #bbb; padding: 60rpx 0; }

/* 底部购物车栏 */
.cart-bar {
  position: relative; display: flex; align-items: center; justify-content: space-between;
  background: #fff; padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
  border-top: 1rpx solid #eee; box-shadow: 0 -2rpx 12rpx rgba(0,0,0,.06);
}
.cart-left { display: flex; align-items: center; }
.cart-icon {
  width: 88rpx; height: 88rpx; border-radius: 50%; background: #ddd;
  display: flex; align-items: center; justify-content: center; margin-top: -28rpx;
  border: 6rpx solid #f5f5f5; position: relative;
}
.cart-icon.on { background: #ff6b35; }
.cart-icon .ic { font-size: 44rpx; }
.cart-icon .badge {
  position: absolute; top: -8rpx; right: -8rpx; background: #f44336; color: #fff;
  font-size: 20rpx; min-width: 30rpx; height: 30rpx; line-height: 30rpx; padding: 0 8rpx;
  border-radius: 30rpx; text-align: center;
}
.cart-text { margin-left: 20rpx; }
.total { font-size: 36rpx; font-weight: 700; color: #222; }
.total.empty { color: #999; font-size: 28rpx; }
.sub { font-size: 22rpx; color: #999; }
.cart-btn {
  background: #ff6b35; color: #fff; padding: 20rpx 48rpx; border-radius: 40rpx;
  font-size: 30rpx; font-weight: 600;
}
.cart-btn.off { background: #ccc; }

/* 购物车弹层 */
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 10; }
.cart-pop {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 11;
  background: #fff; border-radius: 24rpx 24rpx 0 0; padding: 24rpx;
  max-height: 60vh; display: flex; flex-direction: column;
  padding-bottom: calc(24rpx + env(safe-area-inset-bottom));
}
.pop-head { display: flex; justify-content: space-between; font-size: 30rpx; font-weight: 600; padding-bottom: 16rpx; border-bottom: 1rpx solid #eee; }
.clear { color: #ff6b35; font-weight: 400; font-size: 26rpx; }
.pop-list { flex: 1; }
.pop-row { display: flex; align-items: center; padding: 20rpx 0; border-bottom: 1rpx solid #f5f5f5; }
.pop-name { flex: 1; font-size: 28rpx; }
.pop-mid { color: #ff6b35; font-size: 28rpx; margin-right: 20rpx; }
</style>
