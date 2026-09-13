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
      <view class="cart-btn" :class="{ off: !cartCount }" @tap="openCheckout">
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

    <!-- 结算弹层 -->
    <view class="mask" v-if="showCheckout" @tap="showCheckout = false"></view>
    <view class="checkout-pop" v-if="showCheckout">
      <view class="ck-head">
        <text class="ck-title">确认订单</text>
        <text class="ck-close" @tap="showCheckout = false">✕</text>
      </view>
      <scroll-view scroll-y class="ck-body">
        <!-- 优惠明细 -->
        <view class="ck-section" v-if="calc.discountAmount > 0">
          <view class="ck-row"><text>商品原价</text><text>¥{{ calc.originalTotal.toFixed(2) }}</text></view>
          <view class="ck-row discount" v-if="calc.itemDiscountAmount > 0"><text>折扣优惠</text><text>-¥{{ calc.itemDiscountAmount.toFixed(2) }}</text></view>
          <view class="ck-row discount" v-if="calc.fullReductionAmount > 0"><text>满减优惠</text><text>-¥{{ calc.fullReductionAmount.toFixed(2) }}</text></view>
        </view>
        <!-- 手机号 + 积分/储值 -->
        <view class="ck-section" v-if="pointCfg.enabled || svCfg.enabled">
          <view class="ck-input-row">
            <input class="ck-input" type="number" v-model="ckPhone" placeholder="手机号（选填，用于积分/储值）" maxlength="11" @blur="queryPhone" />
          </view>
          <view class="ck-link" v-if="pointCfg.enabled && pointCfg.exchangeDishes.length" @tap="openPointsSheet">
            <text>积分换菜</text>
            <text class="ck-link-arrow">›</text>
          </view>
          <view class="ck-opt" v-if="pointCfg.enabled && pointCfg.deductEnabled && phonePoints > 0">
            <view class="ck-opt-main">
              <text class="ck-opt-label">积分抵现</text>
              <text class="ck-opt-sub">可用 {{ pointDeduct.usable }} 积分抵 ¥{{ pointDeduct.amount.toFixed(2) }}</text>
            </view>
            <switch :checked="usePoints" color="#FF6B35" @change="e => usePoints = e.detail.value" />
          </view>
          <view class="ck-opt" v-if="svCfg.enabled && phoneStored > 0">
            <view class="ck-opt-main">
              <text class="ck-opt-label">储值抵扣</text>
              <text class="ck-opt-sub">余额 ¥{{ phoneStored.toFixed(2) }}</text>
            </view>
            <switch :checked="useStored" color="#FF6B35" @change="e => useStored = e.detail.value" />
          </view>
        </view>
      </scroll-view>
      <view class="ck-foot">
        <view class="ck-total">
          <text class="ck-total-label">应付</text>
          <text class="ck-total-num">¥{{ payableTotal }}</text>
        </view>
        <button class="ck-submit" :loading="submitting" @tap="submitOrder">确认下单</button>
      </view>
    </view>

    <!-- 积分换菜弹层 -->
    <view class="mask" v-if="showPointsSheet" @tap="closePointsSheet"></view>
    <view class="checkout-pop" v-if="showPointsSheet">
      <view class="ck-head">
        <text class="ck-title">积分换菜</text>
        <text class="ck-close" @tap="closePointsSheet">✕</text>
      </view>
      <view class="ck-body">
        <view class="ck-input-row">
          <input class="ck-input" type="number" v-model="ptPhone" placeholder="输入手机号查询积分" maxlength="11" @blur="queryPtBalance" />
        </view>
        <view class="ck-row" v-if="ptQueried">
          <text>积分余额</text>
          <text>{{ ptBalance }} 积分</text>
        </view>
        <view class="pt-list" v-if="pointCfg.exchangeDishes.length">
          <view class="pt-item" v-for="d in pointCfg.exchangeDishes" :key="d.dishId">
            <view class="pt-info">
              <text class="pt-name">{{ d.dishName }}</text>
              <text class="pt-need">需 {{ d.points }} 积分</text>
            </view>
            <button class="pt-btn" :disabled="!ptQueried || ptBalance < d.points || ptRedeeming" @tap="redeemDish(d)">
              {{ !ptQueried ? '先查积分' : (ptBalance < d.points ? '积分不足' : '兑换') }}
            </button>
          </view>
        </view>
      </view>
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

// ===== 结算（优惠 / 积分抵现 / 储值抵扣） =====
const showCheckout = ref(false);
const ckPhone = ref('');
const usePoints = ref(true);
const useStored = ref(true);
const submitting = ref(false);
const activeMarketing = ref([]);
const pointCfg = ref({ enabled: false, spendPerPoint: 0, deductEnabled: false, deductPoints: 100, maxPercent: 20, exchangeDishes: [] });
const svCfg = ref({ enabled: false });
const phonePoints = ref(0);
const phoneStored = ref(0);
const showPointsSheet = ref(false);
const ptPhone = ref('');
const ptBalance = ref(0);
const ptQueried = ref(false);
const ptRedeeming = ref(false);

const filteredDishes = computed(() => {
  if (activeCate.value === '全部') return dishes.value;
  return dishes.value.filter((d) => d.category === activeCate.value);
});
const cartCount = computed(() => cart.value.reduce((s, c) => s + c.qty, 0));
const total = computed(() => cart.value.reduce((s, c) => s + c.price * c.qty, 0));

// 营销优惠计算（与后端 utils/marketingCalc.js 逻辑一致，仅用于前端展示，实际以后端为准）
function computeDiscount(items, rules) {
  items = Array.isArray(items) ? items : [];
  rules = Array.isArray(rules) ? rules : [];
  const originalTotal = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
  let globalRate = 1;
  const catRates = {};
  for (const r of rules) {
    if (r.type !== 'discount') continue;
    const rate = Math.max(0.01, Math.min(1, Number(r.rate) || 1));
    if (!r.category) globalRate = Math.min(globalRate, rate);
    else if (catRates[r.category] == null || rate < catRates[r.category]) catRates[r.category] = rate;
  }
  let discountSubtotal = 0;
  for (const it of items) {
    const lineOriginal = (Number(it.price) || 0) * (Number(it.quantity) || 0);
    const rate = (catRates[it.category] != null) ? catRates[it.category] : globalRate;
    discountSubtotal += lineOriginal * rate;
  }
  const itemDiscountAmount = +(originalTotal - discountSubtotal).toFixed(2);
  let bestFull = null;
  for (const r of rules) {
    if (r.type !== 'fullReduction') continue;
    const threshold = Number(r.threshold) || 0;
    const reduce = Number(r.reduce) || 0;
    if (threshold > 0 && reduce > 0 && discountSubtotal >= threshold - 1e-9) {
      if (!bestFull || reduce > bestFull.reduce) bestFull = { threshold, reduce };
    }
  }
  const fullReductionAmount = bestFull ? +bestFull.reduce.toFixed(2) : 0;
  const finalTotal = +Math.max(0, discountSubtotal - fullReductionAmount).toFixed(2);
  return {
    originalTotal: +originalTotal.toFixed(2),
    discountSubtotal: +discountSubtotal.toFixed(2),
    itemDiscountAmount,
    fullReductionAmount,
    discountAmount: +(originalTotal - finalTotal).toFixed(2),
    finalTotal
  };
}

const calc = computed(() => computeDiscount(
  cart.value.map(c => ({ dishName: c.name, price: c.price, quantity: c.qty, category: c.category })),
  activeMarketing.value
));

const pointDeduct = computed(() => {
  if (!pointCfg.value.enabled || !pointCfg.value.deductEnabled || !usePoints.value) return { usable: 0, amount: 0 };
  const finalTotal = calc.value.finalTotal;
  if (finalTotal <= 0 || phonePoints.value <= 0) return { usable: 0, amount: 0 };
  const maxDiscountAmount = finalTotal * pointCfg.value.maxPercent / 100;
  const maxUsablePoints = Math.floor(maxDiscountAmount * pointCfg.value.deductPoints);
  const usable = Math.min(phonePoints.value, maxUsablePoints);
  if (usable <= 0) return { usable: 0, amount: 0 };
  const amount = Math.round(usable / pointCfg.value.deductPoints * 100) / 100;
  return { usable, amount };
});

const storedDeduct = computed(() => {
  if (!svCfg.value.enabled || !useStored.value) return 0;
  const remaining = calc.value.finalTotal - pointDeduct.value.amount;
  if (remaining <= 0 || phoneStored.value <= 0) return 0;
  return Math.round(Math.min(phoneStored.value, remaining) * 100) / 100;
});

const payableTotal = computed(() =>
  Math.max(0, calc.value.finalTotal - pointDeduct.value.amount - storedDeduct.value).toFixed(2)
);

function qty(id) {
  const f = cart.value.find((c) => c._id === id);
  return f ? f.qty : 0;
}

// 加减菜
function change(d, delta) {
  let f = cart.value.find((c) => c._id === d._id);
  if (!f) {
    if (delta < 0) return;
    f = { _id: d._id, name: d.name, price: d.price, qty: 0, category: d.category };
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

  loadConfigs();
}

// 加载营销活动 / 积分配置 / 储值开关（失败不阻塞点餐）
async function loadConfigs() {
  try {
    const [mkt, ptCfg, svPub] = await Promise.all([
      get('/marketing/active', {}, { showError: false }).catch(() => []),
      get('/points/config', {}, { showError: false }).catch(() => null),
      get('/stored-value/public-config', {}, { showError: false }).catch(() => null)
    ]);
    activeMarketing.value = Array.isArray(mkt) ? mkt : [];
    if (ptCfg) Object.assign(pointCfg.value, ptCfg);
    if (svPub) svCfg.value = { enabled: !!svPub.enabled };
  } catch (e) {}
}

onLoad((options = {}) => {
  tableId.value = options.tableId || '';
  shopId.value = options.shopId || '';
  // 持久化 shopId，供 request.js 统一以 x-shop-id 头带上（后端 requirePublicShopId 需要）
  if (shopId.value) uni.setStorageSync('shopId', shopId.value);
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

// 打开结算弹层
function openCheckout() {
  if (!cartCount.value) {
    uni.showToast({ title: '请先选择菜品', icon: 'none' });
    return;
  }
  if (!tableId.value) {
    uni.showToast({ title: '缺少桌号，无法下单', icon: 'none' });
    return;
  }
  showCheckout.value = true;
}

// 手机号输入后查询积分余额 / 储值余额
async function queryPhone() {
  const phone = ckPhone.value.trim();
  phonePoints.value = 0;
  phoneStored.value = 0;
  if (!/^1\d{10}$/.test(phone)) return;
  try {
    const [pRes, sRes] = await Promise.all([
      post('/points/query', { phone }, { showError: false }).catch(() => null),
      svCfg.value.enabled
        ? get('/stored-value/account', { phone }, { showError: false }).catch(() => null)
        : Promise.resolve(null)
    ]);
    phonePoints.value = (pRes && pRes.points) || 0;
    phoneStored.value = (sRes && sRes.balance) || 0;
  } catch (e) {}
}

// 确认下单（含优惠 / 积分 / 储值，后端权威计算）
async function submitOrder() {
  if (!cartCount.value || submitting.value) return;
  const items = cart.value.map((c) => ({ dishName: c.name, price: c.price, quantity: c.qty }));
  const localId = 'order_' + Date.now();
  const phone = ckPhone.value.trim();
  submitting.value = true;
  uni.showLoading({ title: '提交中...' });
  try {
    const order = await post('/orders', {
      tableNumber: String(tableId.value),
      items,
      phone,
      usePoints: !!phone && usePoints.value,
      useStoredValue: !!phone && useStored.value
    });
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
    showCheckout.value = false;
    ckPhone.value = '';
    phonePoints.value = 0;
    phoneStored.value = 0;
    clearCart(tableId.value);
    cart.value = [];
    showCart.value = false;
  } catch (e) {
    // 离线保护：失败订单进队列，联网后自动同步
    addPendingOrder({ localId, tableNumber: String(tableId.value), items });
    uni.showToast({ title: '当前网络不佳，订单已缓存，联网后自动提交', icon: 'none', duration: 2500 });
    showCheckout.value = false;
    clearCart(tableId.value);
    cart.value = [];
    showCart.value = false;
  } finally {
    submitting.value = false;
    uni.hideLoading();
  }
}

// ===== 积分换菜 =====
function openPointsSheet() {
  if (!pointCfg.value.enabled || !pointCfg.value.exchangeDishes.length) {
    uni.showToast({ title: '本店未开通积分换菜', icon: 'none' });
    return;
  }
  showCheckout.value = false;
  showPointsSheet.value = true;
  ptPhone.value = ckPhone.value || '';
  ptBalance.value = 0;
  ptQueried.value = false;
  if (/^1\d{10}$/.test(ptPhone.value)) queryPtBalance();
}
function closePointsSheet() {
  showPointsSheet.value = false;
}
async function queryPtBalance() {
  const phone = ptPhone.value.trim();
  if (!/^1\d{10}$/.test(phone)) {
    uni.showToast({ title: '请输入正确的 11 位手机号', icon: 'none' });
    return;
  }
  try {
    const res = await post('/points/query', { phone }, { showError: false });
    if (res && res.points != null) {
      ptBalance.value = res.points || 0;
      ptQueried.value = true;
    }
  } catch (e) {}
}
async function redeemDish(dish) {
  const phone = ptPhone.value.trim();
  if (!ptQueried.value || !/^1\d{10}$/.test(phone)) {
    uni.showToast({ title: '请先查询积分', icon: 'none' });
    return;
  }
  if (ptRedeeming.value) return;
  const ok = await new Promise((resolve) => {
    uni.showModal({
      title: '积分兑换',
      content: `确定用 ${dish.points} 积分兑换「${dish.dishName}」吗？兑换后立即送后厨出餐。`,
      confirmColor: '#FF6B35',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false)
    });
  });
  if (!ok) return;
  ptRedeeming.value = true;
  try {
    const res = await post('/points/redeem-dish', { phone, dishId: dish.dishId });
    ptBalance.value = (res && res.pointsBalance != null) ? res.pointsBalance : (ptBalance.value - dish.points);
    uni.showToast({ title: '兑换成功，已送后厨', icon: 'success' });
  } catch (e) {
    // request.js 已 toast
  } finally {
    ptRedeeming.value = false;
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
  background: $ink-50;
}

/* 顶部 */
.header {
  background: $brand-grad;
  color: #fff;
  padding: 24rpx 32rpx 32rpx;
}
.shop-name { font-size: $fs-2xl; font-weight: $fw-bold; }
.table-info { margin-top: 12rpx; display: flex; gap: 16rpx; }
.tag {
  font-size: $fs-sm; padding: 4rpx 18rpx; border-radius: $radius-full;
  background: rgba(255,255,255,.25);
}
.tag.light { background: rgba(255,255,255,.15); }

/* 主体 */
.body { flex: 1; display: flex; min-height: 0; }
.cate {
  width: 180rpx; height: 100%; background: $surface;
  border-right: 1rpx solid $ink-100;
}
.cate-item {
  position: relative; padding: 28rpx 20rpx; font-size: $fs-base; color: $ink-500;
  display: flex; align-items: center;
}
.cate-bar {
  width: 6rpx; height: 28rpx; background: transparent; border-radius: 6rpx; margin-right: 14rpx;
}
.cate-item.on { color: $brand; font-weight: $fw-semibold; background: $ink-50; }
.cate-item.on .cate-bar { background: $brand; }

.dishes { flex: 1; height: 100%; padding: 0 20rpx; }
.dish-tip { font-size: $fs-sm; color: $ink-400; padding: 16rpx 4rpx; }
.dish {
  display: flex; background: $surface; border-radius: $radius-lg; padding: 20rpx;
  margin-bottom: 18rpx; box-shadow: $shadow-sm;
}
.dish-img { width: 160rpx; height: 160rpx; border-radius: $radius; flex-shrink: 0; background: $ink-100; }
.dish-img.placeholder {
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #ffd2bf, #ffb59a); color: #fff; font-size: 56rpx; font-weight: $fw-bold;
}
.dish-info { flex: 1; margin-left: 20rpx; display: flex; flex-direction: column; justify-content: space-between; }
.dish-name { font-size: $fs-lg; font-weight: $fw-semibold; color: $ink-900; }
.dish-desc { font-size: $fs-sm; color: $ink-400; margin-top: 6rpx; }
.dish-bottom { display: flex; align-items: flex-end; justify-content: space-between; }
.price { color: $brand; font-size: 36rpx; font-weight: $fw-bold; }
.price .small { font-size: $fs-sm; }
.ctrl { display: flex; align-items: center; gap: 14rpx; }
.btn {
  width: 44rpx; height: 44rpx; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; font-size: 34rpx; color: #fff;
  background: $brand; line-height: 1;
}
.btn.minus { background: $surface; color: $brand; border: 2rpx solid $brand; }
.num { font-size: $fs-lg; min-width: 36rpx; text-align: center; font-weight: $fw-semibold; }
.sold { font-size: $fs-sm; color: $ink-300; }
.empty { text-align: center; color: $ink-300; padding: 60rpx 0; }

/* 底部购物车栏 */
.cart-bar {
  position: relative; display: flex; align-items: center; justify-content: space-between;
  background: $surface; padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
  border-top: 1rpx solid $ink-100; box-shadow: $shadow;
}
.cart-left { display: flex; align-items: center; }
.cart-icon {
  width: 88rpx; height: 88rpx; border-radius: 50%; background: $ink-200;
  display: flex; align-items: center; justify-content: center; margin-top: -28rpx;
  border: 6rpx solid $ink-50; position: relative;
}
.cart-icon.on { background: $brand; }
.cart-icon .ic { font-size: 44rpx; }
.cart-icon .badge {
  position: absolute; top: -8rpx; right: -8rpx; background: $danger; color: #fff;
  font-size: $fs-xs; min-width: 30rpx; height: 30rpx; line-height: 30rpx; padding: 0 8rpx;
  border-radius: $radius-full; text-align: center;
}
.cart-text { margin-left: 20rpx; }
.total { font-size: 36rpx; font-weight: $fw-bold; color: $ink-900; }
.total.empty { color: $ink-400; font-size: $fs-md; }
.sub { font-size: $fs-sm; color: $ink-400; }
.cart-btn {
  background: $brand-grad; color: #fff; padding: 20rpx 48rpx; border-radius: $radius-full;
  font-size: $fs-lg; font-weight: $fw-semibold; box-shadow: $shadow-brand;
}
.cart-btn.off { background: $ink-200; box-shadow: none; }

/* 购物车弹层 */
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 10; }
.cart-pop {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 11;
  background: $surface; border-radius: $radius-lg $radius-lg 0 0; padding: 24rpx;
  max-height: 60vh; display: flex; flex-direction: column;
  padding-bottom: calc(24rpx + env(safe-area-inset-bottom));
}
.pop-head { display: flex; justify-content: space-between; font-size: $fs-lg; font-weight: $fw-semibold; padding-bottom: 16rpx; border-bottom: 1rpx solid $ink-100; }
.clear { color: $brand; font-weight: $fw-regular; font-size: $fs-base; }
.pop-list { flex: 1; }
.pop-row { display: flex; align-items: center; padding: 20rpx 0; border-bottom: 1rpx solid $ink-50; }
.pop-name { flex: 1; font-size: $fs-md; color: $ink-900; }
.pop-mid { color: $brand; font-size: $fs-md; margin-right: 20rpx; }

/* ===== 结算弹层 ===== */
.checkout-pop {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 21;
  background: $surface; border-radius: $radius-lg $radius-lg 0 0;
  display: flex; flex-direction: column;
  max-height: 76vh;
}
.ck-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 24rpx 32rpx; border-bottom: 1rpx solid $ink-100;
}
.ck-title { font-size: $fs-lg; font-weight: $fw-bold; color: $ink-900; }
.ck-close { font-size: 32rpx; color: $ink-400; padding: 0 8rpx; }
.ck-body { flex: 1; overflow-y: auto; padding: 8rpx 32rpx; }
.ck-section { padding: 20rpx 0; border-bottom: 1rpx solid $ink-50; }
.ck-row { display: flex; justify-content: space-between; padding: 8rpx 0; font-size: $fs-base; color: $ink-700; }
.ck-row.discount { color: $brand; }
.ck-input-row { padding: 8rpx 0; }
.ck-input {
  background: $ink-50; border-radius: $radius; padding: 18rpx 24rpx;
  font-size: $fs-base; color: $ink-900;
}
.ck-opt { display: flex; align-items: center; justify-content: space-between; padding: 18rpx 0; }
.ck-opt-main { flex: 1; display: flex; flex-direction: column; }
.ck-opt-label { font-size: $fs-md; color: $ink-900; font-weight: $fw-medium; }
.ck-opt-sub { font-size: $fs-sm; color: $ink-400; margin-top: 4rpx; }
.ck-foot {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20rpx 32rpx calc(20rpx + env(safe-area-inset-bottom));
  border-top: 1rpx solid $ink-100;
}
.ck-total { display: flex; align-items: baseline; gap: 8rpx; }
.ck-total-label { font-size: $fs-base; color: $ink-700; }
.ck-total-num { font-size: $fs-2xl; font-weight: $fw-bold; color: $brand; }
.ck-submit {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-lg; font-weight: $fw-semibold; height: 80rpx; line-height: 80rpx; padding: 0 48rpx;
  box-shadow: $shadow-brand;
}

/* ===== 积分换菜 ===== */
.ck-link {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16rpx 0; font-size: $fs-md; color: $brand; font-weight: $fw-medium;
}
.ck-link-arrow { color: $ink-300; font-size: 32rpx; }
.pt-list { padding: 8rpx 0; }
.pt-item { display: flex; align-items: center; justify-content: space-between; padding: 20rpx 0; border-bottom: 1rpx solid $ink-50; }
.pt-info { flex: 1; display: flex; flex-direction: column; }
.pt-name { font-size: $fs-md; color: $ink-900; font-weight: $fw-medium; }
.pt-need { font-size: $fs-sm; color: $brand; margin-top: 4rpx; }
.pt-btn {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-base; font-weight: $fw-semibold; height: 60rpx; line-height: 60rpx; padding: 0 26rpx;
  box-shadow: $shadow-brand;
}
.pt-btn[disabled] { background: $ink-100; color: $ink-300; box-shadow: none; }
</style>
