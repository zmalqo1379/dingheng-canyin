<template>
  <view class="page">
    <view class="hero">
      <view class="hero-title">数据统计</view>
      <view class="hero-sub">今日经营概况一览</view>
    </view>

    <view class="amount">
      <view class="amount-label">今日营业额</view>
      <view class="amount-val">¥{{ fmt(stats.revenue) }}</view>
      <view class="amount-tip">今日订单 {{ stats.orderCount }} 单 · 待处理 {{ stats.pendingCount }} · 已完成 {{ stats.completedCount }}</view>
    </view>

    <view class="grid">
      <view class="grid-item">
        <view class="num">{{ stats.orderCount }}</view>
        <view class="lbl">今日订单</view>
      </view>
      <view class="grid-item">
        <view class="num warn">{{ stats.pendingCount }}</view>
        <view class="lbl">待处理</view>
      </view>
      <view class="grid-item">
        <view class="num ok">{{ stats.completedCount }}</view>
        <view class="lbl">已完成</view>
      </view>
      <view class="grid-item">
        <view class="num">¥{{ fmt(stats.revenue) }}</view>
        <view class="lbl">营业额</view>
      </view>
    </view>

    <view class="bars card">
      <view class="card-title">完成情况</view>
      <view class="bar-wrap">
        <view class="bar-col">
          <view class="bar bar-warn" :style="{ height: barH(stats.pendingCount) }"></view>
          <text class="bar-lbl">待处理 {{ stats.pendingCount }}</text>
        </view>
        <view class="bar-col">
          <view class="bar bar-ok" :style="{ height: barH(stats.completedCount) }"></view>
          <text class="bar-lbl">已完成 {{ stats.completedCount }}</text>
        </view>
      </view>
    </view>

    <view class="tip">数据每分钟刷新一次，可下拉页面手动刷新</view>
    <view class="footer">
      <button class="refresh" @tap="load" :loading="loading">刷新数据</button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import { get, getToken } from '@/utils/request.js';

const stats = ref({
  orderCount: 0,
  revenue: 0,
  pendingCount: 0,
  completedCount: 0
});

const loading = ref(false);

function fmt(n) {
  return (Number(n || 0)).toFixed(2);
}
// 柱形高度（按最大值映射）
function barH(val) {
  const max = Math.max(stats.value.pendingCount, stats.value.completedCount, 1);
  const h = (val / max) * 200 + 20;
  return h + 'rpx';
}

async function load() {
  loading.value = true;
  try {
    const d = await get('/admin/merchant-stats');
    if (d) Object.assign(stats.value, d);
  } catch (e) {} finally {
    loading.value = false;
  }
}

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  load();
  // 每 60s 自动刷新一次
  setInterval(load, 60000);
});

onPullDownRefresh(() => {
  load().finally(() => uni.stopPullDownRefresh());
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  background: $ink-50;
  padding-bottom: 180rpx;
}

.hero {
  background: $brand-grad;
  color: #fff;
  padding: 50rpx 32rpx 0;
}
.hero-title { font-size: $fs-2xl; font-weight: $fw-bold; }
.hero-sub { font-size: $fs-sm; opacity: .9; margin-top: 8rpx; }

.amount {
  background: $brand-grad;
  color: #fff;
  padding: 20rpx 32rpx 60rpx;
}
.amount-label { font-size: $fs-sm; opacity: .9; }
.amount-val { font-size: $fs-4xl; font-weight: $fw-bold; margin: 10rpx 0; }
.amount-tip { font-size: $fs-sm; opacity: .85; }

.grid {
  display: flex; flex-wrap: wrap; margin: -40rpx 20rpx 0;
  background: transparent;
}
.grid-item {
  width: 50%; box-sizing: border-box; padding: 10rpx;
}
.grid-item .num {
  background: $surface; border-radius: $radius-lg; padding: 30rpx; box-sizing: border-box;
  font-size: $fs-2xl; font-weight: $fw-bold; color: $brand; text-align: center;
  box-shadow: $shadow-sm;
}
.grid-item .num.warn { color: $warning; }
.grid-item .num.ok { color: $success; }
.grid-item .lbl { text-align: center; font-size: $fs-sm; color: $ink-400; margin-top: 12rpx; }

.card {
  background: $surface; margin: 20rpx; border-radius: $radius-lg; padding: 24rpx;
  box-shadow: $shadow-sm;
}
.card-title { font-size: $fs-md; font-weight: $fw-semibold; color: $ink-900; margin-bottom: 24rpx; }

.bar-wrap { display: flex; justify-content: space-around; align-items: flex-end; height: 280rpx; }
.bar-col { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.bar { width: 80rpx; border-radius: $radius $radius 0 0; }
.bar-warn { background: $warning; }
.bar-ok { background: $success; }
.bar-lbl { font-size: $fs-sm; color: $ink-400; margin-top: 12rpx; }

.tip { text-align: center; font-size: $fs-sm; color: $ink-300; padding: 10rpx 0; }

.footer {
  position: fixed; left: 0; right: 0; bottom: 0;
  padding: 20rpx 32rpx calc(20rpx + env(safe-area-inset-bottom));
  background: $surface; box-shadow: $shadow;
}
.refresh {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-lg; font-weight: $fw-semibold; height: 80rpx; line-height: 80rpx;
  box-shadow: $shadow-brand;
}
button::after { border: none; }

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .grid-item .num { background: #1e1e1e; color: #ff8a5c; box-shadow: none; }
  .grid-item .lbl { color: #888; }
  .card { background: #1e1e1e; box-shadow: none; }
  .card-title { color: #e6e6e6; }
  .bar-lbl { color: #888; }
  .footer { background: #1e1e1e; }
}
</style>
