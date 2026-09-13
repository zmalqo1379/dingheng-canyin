<template>
  <view class="page">
    <!-- 顶部：店铺 + 采购线档位 + 鼎恒币 -->
    <view class="hero">
      <view class="hero-row">
        <view class="hero-left">
          <view class="hero-name">{{ shopName || '鼎恒餐饮' }}</view>
          <view class="hero-sub">采购管家 · 进货省钱，才是真省钱</view>
        </view>
        <view class="hero-coin" @tap="goTab('/pages/admin/member')">
          <text class="hero-coin-num">{{ coin }}</text>
          <text class="hero-coin-unit">鼎恒币</text>
        </view>
      </view>
      <view class="hero-tags">
        <text class="tag">🛒 {{ purchaseLevelName }}</text>
        <text class="tag ghost" v-if="purchaseExpireText">{{ purchaseExpireText }}</text>
      </view>
    </view>

    <!-- 快捷入口 -->
    <view class="quick">
      <view class="quick-item" @tap="goTab('/pages/admin/mall')">
        <text class="quick-ico">🛒</text><text class="quick-txt">采购商城</text>
      </view>
      <view class="quick-item" @tap="goTab('/pages/admin/purchase')">
        <text class="quick-ico">📑</text><text class="quick-txt">采购订单</text>
      </view>
      <view class="quick-item" @tap="goTab('/pages/admin/member')">
        <text class="quick-ico">👑</text><text class="quick-txt">会员省钱卡</text>
      </view>
      <view class="quick-item" @tap="go('/pages/admin/more')">
        <text class="quick-ico">🍴</text><text class="quick-txt">门店经营</text>
      </view>
    </view>

    <!-- 快断货提醒（BOM + 库存反算；无数据隐藏） -->
    <view class="card" v-if="lowStock.length">
      <view class="card-head">
        <text class="card-title">⚠️ 快断货了</text>
        <text class="card-sub">{{ lowStock.length }} 道菜即将售罄</text>
      </view>
      <view class="ls-item" v-for="(x, i) in lowStock" :key="i">
        <text class="ls-name">{{ x.dishName }}</text>
        <text class="ls-num">仅可做 {{ x.portionsLeft }} 份</text>
        <text class="ls-tip">瓶颈：{{ x.bottleneck.name }}（库存 {{ x.bottleneck.have }}）</text>
      </view>
      <button class="btn ghost" @tap="goTab('/pages/admin/mall')">去采购商城补货</button>
    </view>

    <!-- 预测补货（30 天销量预测，采购省钱卡权益） -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">📈 预测补货（未来 7 天）</text>
      </view>
      <view v-if="forecastLocked" class="locked">
        <view class="locked-mask">
          <text class="locked-title">🔒 30 天智能补货预测是「采购省钱卡」权益</text>
          <text class="locked-desc">开通后提前知道该进什么货、进多少，备货不压货</text>
        </view>
        <view v-if="forecastPreview.length" class="locked-preview">
          <view class="fc-item" v-for="(x, i) in forecastPreview" :key="i">
            <text class="fc-name">{{ x.name }}</text>
            <text class="fc-qty">建议 {{ x.suggestedQuantity }} {{ x.unit }}</text>
          </view>
        </view>
        <button class="btn" @tap="goTab('/pages/admin/member')">升级采购省钱卡解锁</button>
      </view>
      <view v-else-if="forecast.length">
        <view class="fc-item" v-for="(x, i) in forecast" :key="i">
          <text class="fc-name">{{ x.name }}</text>
          <text class="fc-qty">建议 {{ x.suggestedQuantity }} {{ x.unit }}</text>
        </view>
        <button class="btn ghost" @tap="goTab('/pages/admin/mall')">去商城下单</button>
      </view>
      <view v-else class="empty">暂无销量数据或未配置菜品配方，无法预测</view>
    </view>

    <!-- 补货建议（按采购频率，免费） -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">🔔 补货提醒</text>
        <text class="card-sub">按采购频率推算</text>
      </view>
      <view v-if="suggestions.length">
        <view class="sr-item" v-for="(s, i) in suggestions" :key="i">
          <view class="sr-main">
            <text class="sr-name">{{ s.name }}</text>
            <text class="sr-reason">{{ s.reason || ('距上次采购 ' + s.daysSinceLast + ' 天') }}</text>
          </view>
          <text class="sr-qty">建议 {{ s.suggestedQuantity }} {{ s.unit }}</text>
        </view>
        <button class="btn ghost" @tap="goTab('/pages/admin/mall')">一键去补货</button>
      </view>
      <view v-else class="empty">暂无需要补货的食材 🎉</view>
    </view>

    <view class="foot-tip">按「配方 + 库存 + 采购频率」推算，仅供备货参考</view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad, onShow, onPullDownRefresh } from '@dcloudio/uni-app';
import { get, getToken, getShopId } from '@/utils/request.js';

const PURCHASE_NAME = { free: '采购免费版', plus: '采购省钱卡', pro: '采购省钱卡Pro' };

const shopName = ref('');
const coin = ref(0);
const purchaseLevelName = ref('采购免费版');
const purchaseExpireText = ref('');

const lowStock = ref([]);
const suggestions = ref([]);
const forecast = ref([]);
const forecastPreview = ref([]);
const forecastLocked = ref(false);

function go(url) {
  uni.navigateTo({ url });
}
function goTab(url) {
  uni.switchTab({ url });
}

async function loadStatus() {
  const shopId = getShopId();
  try {
    const d = await get(`/coin/status/${shopId}`, {}, { showError: false });
    if (!d) return;
    coin.value = d.dinghengCoin || 0;
    purchaseLevelName.value = PURCHASE_NAME[d.purchaseLevel] || PURCHASE_NAME.free;
    if (d.purchaseActive && d.purchaseExpire) {
      purchaseExpireText.value = '到期 ' + String(d.purchaseExpire).slice(0, 10);
    } else {
      purchaseExpireText.value = '长期有效';
    }
  } catch (e) {}
}

async function loadReplenish() {
  try {
    const [sr, fc, ls] = await Promise.all([
      get('/admin/smart-replenish/suggestions', {}, { showError: false }),
      get('/admin/smart-replenish/forecast', {}, { showError: false }),
      get('/admin/low-stock-dishes', {}, { showError: false })
    ]);
    suggestions.value = (sr && sr.suggestions) || [];
    forecastLocked.value = !!(fc && fc.locked);
    forecast.value = (fc && fc.forecastItems) || [];
    forecastPreview.value = (fc && fc.previewSample) || [];
    const items = (ls && ls.items) || [];
    lowStock.value = ls && ls.hasBom ? items.slice(0, 4) : [];
  } catch (e) {}
}

async function loadSettings() {
  try {
    const s = await get('/settings', {}, { showError: false });
    if (s && s.shopName) shopName.value = s.shopName;
  } catch (e) {}
}

async function refreshAll() {
  await Promise.all([loadStatus(), loadReplenish(), loadSettings()]);
}

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
});
onShow(() => { refreshAll(); });
onPullDownRefresh(async () => {
  await refreshAll();
  uni.stopPullDownRefresh();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  background: #f5f5f5;
  padding-bottom: 40rpx;
}

.hero {
  background: linear-gradient(135deg, #ff6b35, #ff8a5c);
  color: #fff;
  padding: 40rpx 32rpx 36rpx;
}
.hero-row { display: flex; align-items: center; justify-content: space-between; }
.hero-name { font-size: 42rpx; font-weight: 700; }
.hero-sub { font-size: 23rpx; opacity: .9; margin-top: 8rpx; }
.hero-coin {
  background: rgba(255,255,255,.18);
  border-radius: 16rpx; padding: 12rpx 20rpx; text-align: center;
}
.hero-coin-num { display: block; font-size: 34rpx; font-weight: 700; }
.hero-coin-unit { display: block; font-size: 20rpx; opacity: .9; }
.hero-tags { margin-top: 20rpx; display: flex; gap: 12rpx; }
.tag {
  background: rgba(255,255,255,.2);
  border-radius: 30rpx; padding: 8rpx 20rpx; font-size: 22rpx;
}
.tag.ghost { background: rgba(255,255,255,.1); }

.quick {
  display: flex; background: #fff; margin: -20rpx 20rpx 0;
  border-radius: 16rpx; padding: 24rpx 0;
  box-shadow: 0 4rpx 16rpx rgba(0,0,0,.06);
}
.quick-item { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8rpx; }
.quick-ico { font-size: 40rpx; }
.quick-txt { font-size: 22rpx; color: #555; }

.card {
  background: #fff; margin: 20rpx; border-radius: 16rpx;
  padding: 24rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,.04);
}
.card-head {
  display: flex; align-items: baseline; justify-content: space-between;
  padding-bottom: 14rpx; border-bottom: 1rpx solid #f5f5f5;
}
.card-title { font-size: 28rpx; font-weight: 600; color: #333; }
.card-sub { font-size: 22rpx; color: #999; }

.ls-item { display: flex; align-items: center; flex-wrap: wrap; gap: 10rpx; padding: 16rpx 0; border-bottom: 1rpx solid #faf7f4; }
.ls-name { font-size: 28rpx; color: #333; font-weight: 500; }
.ls-num { font-size: 26rpx; color: #ff6b35; font-weight: 700; }
.ls-tip { font-size: 22rpx; color: #aaa; width: 100%; }

.fc-item, .sr-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18rpx 0; border-bottom: 1rpx solid #faf7f4; gap: 16rpx;
}
.fc-name, .sr-name { font-size: 28rpx; color: #333; }
.fc-qty, .sr-qty { font-size: 26rpx; color: #ff6b35; font-weight: 600; }
.sr-main { flex: 1; display: flex; flex-direction: column; }
.sr-reason { font-size: 22rpx; color: #999; margin-top: 4rpx; }

.locked { position: relative; }
.locked-mask {
  background: #fff7f0; border: 1rpx dashed #ffd4b8; border-radius: 12rpx;
  padding: 20rpx; display: flex; flex-direction: column; gap: 6rpx;
}
.locked-title { font-size: 26rpx; color: #333; font-weight: 600; }
.locked-desc { font-size: 22rpx; color: #999; }
.locked-preview { filter: blur(3rpx); opacity: .6; pointer-events: none; margin-top: 8rpx; }

.btn {
  margin-top: 20rpx;
  background: #ff6b35; color: #fff; border-radius: 40rpx;
  font-size: 28rpx; height: 76rpx; line-height: 76rpx;
}
.btn.ghost { background: #fff2ea; color: #ff6b35; }
.empty { padding: 30rpx 0; text-align: center; font-size: 24rpx; color: #aaa; }
.foot-tip { text-align: center; font-size: 22rpx; color: #bbb; margin-top: 10rpx; }
button::after { border: none; }

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .card, .quick { background: #1e1e1e; box-shadow: none; }
  .card-head, .ls-item, .fc-item, .sr-item { border-color: #2a2a2a; }
  .card-title, .ls-name, .fc-name, .sr-name { color: #e6e6e6; }
  .quick-txt { color: #bbb; }
  .btn.ghost { background: #2a2119; }
  .locked-mask { background: #241c15; border-color: #4a3524; }
  .locked-title { color: #e6e6e6; }
}
</style>
