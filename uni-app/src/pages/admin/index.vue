<template>
  <view class="page" :class="themeClass">
    <!-- 顶部：店铺 + 采购线档位 + 鼎恒币 -->
    <view class="hero">
      <view class="deco deco-1"></view>
      <view class="deco deco-2"></view>
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
        <view class="quick-ico"><text>🛒</text></view>
        <text class="quick-txt">采购商城</text>
      </view>
      <view class="quick-item" @tap="goTab('/pages/admin/purchase')">
        <view class="quick-ico"><text>📑</text></view>
        <text class="quick-txt">采购订单</text>
      </view>
      <view class="quick-item" @tap="goTab('/pages/admin/member')">
        <view class="quick-ico"><text>👑</text></view>
        <text class="quick-txt">会员省钱卡</text>
      </view>
      <view class="quick-item" @tap="go('/pages/admin/more')">
        <view class="quick-ico"><text>🍴</text></view>
        <text class="quick-txt">门店经营</text>
      </view>
    </view>

    <!-- 本月省钱账单（采购价 vs 平台参考价；无数据隐藏，不编造） -->
    <view class="savings" v-if="savings.hasData" @tap="goTab('/pages/admin/purchase')">
      <view class="savings-left">
        <text class="savings-label">本月已为你省钱</text>
        <view class="savings-num"><text class="rmb">¥</text>{{ savings.monthSaved }}</view>
        <text class="savings-sub">已对比 {{ savings.coveredItems }} 项采购明细 · 进货更划算</text>
      </view>
      <view class="savings-arrow">去采购 ›</view>
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
// 界面主题：根 view 上挂 class（.theme-warm / .theme-dark / .theme-fresh），
// 整套 CSS 变量由 src/styles/theme-vars.css 提供，页面样式一行都不用改。
import { useThemeClass } from '@/utils/theme.js';

const themeClass = useThemeClass();

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
const savings = ref({ hasData: false, monthSaved: '0.00', coveredItems: 0 });

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
    const [sr, fc, ls, sv] = await Promise.all([
      get('/admin/smart-replenish/suggestions', {}, { showError: false }),
      get('/admin/smart-replenish/forecast', {}, { showError: false }),
      get('/admin/low-stock-dishes', {}, { showError: false }),
      get('/admin/procurement-monitor/savings', {}, { showError: false })
    ]);
    suggestions.value = (sr && sr.suggestions) || [];
    forecastLocked.value = !!(fc && fc.locked);
    forecast.value = (fc && fc.forecastItems) || [];
    forecastPreview.value = (fc && fc.previewSample) || [];
    const items = (ls && ls.items) || [];
    lowStock.value = ls && ls.hasBom ? items.slice(0, 4) : [];
    if (sv && sv.hasData) {
      savings.value = { hasData: true, monthSaved: sv.monthSaved || '0.00', coveredItems: sv.coveredItems || 0 };
    }
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
  background: $ink-50;
  padding-bottom: 40rpx;
}

/* ===== hero ===== */
.hero {
  position: relative;
  background: $brand-grad;
  color: #fff;
  padding: 40rpx 32rpx 44rpx;
  overflow: hidden;
}
.deco { position: absolute; border-radius: 50%; background: rgba(255, 255, 255, .10); }
.deco-1 { top: -100rpx; right: -80rpx; width: 300rpx; height: 300rpx; }
.deco-2 { bottom: -120rpx; left: -60rpx; width: 240rpx; height: 240rpx; background: rgba(255, 255, 255, .07); }
.hero-row { display: flex; align-items: center; justify-content: space-between; position: relative; z-index: 1; }
.hero-name { font-size: $fs-2xl; font-weight: $fw-bold; }
.hero-sub { font-size: $fs-sm; opacity: .92; margin-top: 8rpx; }
.hero-coin {
  background: rgba(255, 255, 255, .2);
  border: 1rpx solid rgba(255, 255, 255, .28);
  border-radius: $radius; padding: 12rpx 22rpx; text-align: center;
}
.hero-coin-num { display: block; font-size: $fs-xl; font-weight: $fw-bold; }
.hero-coin-unit { display: block; font-size: $fs-xs; opacity: .92; }
.hero-tags { margin-top: 24rpx; display: flex; gap: 12rpx; position: relative; z-index: 1; }
.tag {
  background: rgba(255, 255, 255, .22);
  border-radius: $radius-full; padding: 8rpx 20rpx; font-size: $fs-sm;
}
.tag.ghost { background: rgba(255, 255, 255, .12); }

/* ===== 快捷入口 ===== */
.quick {
  display: flex; background: $surface; margin: -24rpx 20rpx 0;
  border-radius: $radius-lg; padding: 28rpx 0;
  box-shadow: $shadow; position: relative; z-index: 2;
}
.quick-item { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 12rpx; }
.quick-ico {
  width: 88rpx; height: 88rpx; border-radius: 28rpx;
  background: $brand-50; display: flex; align-items: center; justify-content: center;
}
.quick-ico text { font-size: 44rpx; line-height: 1; }
.quick-txt { font-size: $fs-sm; color: $ink-700; font-weight: $fw-medium; }

/* ===== 省钱账单 ===== */
.savings {
  display: flex; align-items: center; justify-content: space-between;
  margin: 24rpx 20rpx 0; padding: 28rpx 32rpx;
  background: $dark-grad; border-radius: $radius-lg; color: #fff;
  box-shadow: $shadow-lg;
}
.savings-left { display: flex; flex-direction: column; }
.savings-label { font-size: $fs-sm; color: rgba(255, 255, 255, .75); }
.savings-num { font-size: $fs-4xl; font-weight: $fw-black; margin-top: 6rpx; color: #FFD6A8; }
.savings-num .rmb { font-size: $fs-lg; font-weight: $fw-bold; margin-right: 4rpx; }
.savings-sub { font-size: $fs-sm; color: rgba(255, 255, 255, .6); margin-top: 6rpx; }
.savings-arrow { font-size: $fs-md; color: rgba(255, 255, 255, .85); }

/* ===== 卡片 ===== */
.card {
  background: $surface; margin: 24rpx 20rpx 0; border-radius: $radius-lg;
  padding: 24rpx; box-shadow: $shadow-sm;
}
.card-head {
  display: flex; align-items: baseline; justify-content: space-between;
  padding-bottom: 14rpx; border-bottom: 1rpx solid $ink-100; margin-bottom: 4rpx;
}
.card-title { font-size: $fs-md; font-weight: $fw-semibold; color: $ink-900; }
.card-sub { font-size: $fs-sm; color: $ink-400; }

.ls-item { display: flex; align-items: center; flex-wrap: wrap; gap: 10rpx; padding: 16rpx 0; border-bottom: 1rpx solid $ink-50; }
.ls-name { font-size: $fs-md; color: $ink-900; font-weight: $fw-medium; }
.ls-num { font-size: $fs-base; color: $brand; font-weight: $fw-bold; }
.ls-tip { font-size: $fs-sm; color: $ink-400; width: 100%; }

.fc-item, .sr-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18rpx 0; border-bottom: 1rpx solid $ink-50; gap: 16rpx;
}
.fc-name, .sr-name { font-size: $fs-md; color: $ink-900; }
.fc-qty, .sr-qty { font-size: $fs-base; color: $brand; font-weight: $fw-semibold; }
.sr-main { flex: 1; display: flex; flex-direction: column; }
.sr-reason { font-size: $fs-sm; color: $ink-400; margin-top: 4rpx; }

.locked { position: relative; }
.locked-mask {
  background: $brand-50; border: 1rpx dashed $brand-400; border-radius: $radius;
  padding: 20rpx; display: flex; flex-direction: column; gap: 6rpx;
}
.locked-title { font-size: $fs-base; color: $ink-900; font-weight: $fw-semibold; }
.locked-desc { font-size: $fs-sm; color: $ink-400; }
.locked-preview { filter: blur(3rpx); opacity: .6; pointer-events: none; margin-top: 8rpx; }

.btn {
  margin-top: 20rpx;
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-md; font-weight: $fw-semibold; height: 76rpx; line-height: 76rpx;
  box-shadow: $shadow-brand;
}
.btn.ghost { background: $brand-50; color: $brand; box-shadow: none; }
.empty { padding: 30rpx 0; text-align: center; font-size: $fs-base; color: $ink-400; }
.foot-tip { text-align: center; font-size: $fs-sm; color: $ink-300; margin-top: 10rpx; }
button::after { border: none; }

/* ★ 已删（2026-09-19）：原先这里手写了一整块 @media (prefers-color-scheme: dark)，
   逐个改 .card / .card-title / .locked-mask 的深色。
   问题：它只认系统深色，不认用户的选择 —— 用户选了经典版，系统偏偏是深色，
   就会变成「黑背景 + 旧橙色宝贝姆 victim 半残混合inolol而且改一处漏一处。
   现在由 .theme-dark（挂在本页根 view 上）统一接管，文字/边框/品牌色一整套都齐，
   而且「没手动选过主题时才跟随系统」的规则由 src/utils/theme.js 统一说了算。
   ⚠️ 其余 8 个页面里还留着同款手写深色块，等它们接入主题层时按同样方式删掉。 */
</style>
