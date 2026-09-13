<template>
  <view class="page">
    <view class="hero">
      <view class="hero-name">{{ form.shopName || '鼎恒餐饮' }}</view>
      <view class="hero-sub">门店经营 · 菜单 / 订单 / 统计 / 店铺设置</view>
    </view>

    <!-- 门店经营入口（点餐相关功能保留，不删除） -->
    <view class="card">
      <view class="card-title">门店经营（扫码点餐）</view>
      <view class="nav" v-for="n in navs" :key="n.url" @tap="go(n.url)">
        <view class="nav-ico"><text>{{ n.ico }}</text></view>
        <view class="nav-txt">
          <text class="nav-label">{{ n.label }}</text>
          <text class="nav-desc">{{ n.desc }}</text>
        </view>
        <text class="nav-arrow">›</text>
      </view>
    </view>

    <!-- 店铺设置（原首页内容，迁移至此） -->
    <view class="card">
      <view class="card-title">基础信息</view>
      <view class="row">
        <text class="label">店铺名称</text>
        <input class="input" v-model="form.shopName" placeholder="请输入店铺名称" />
      </view>
    </view>

    <view class="card">
      <view class="card-title">通知开关</view>
      <view class="row" v-for="t in toggles" :key="t.key">
        <view class="label-wrap">
          <text class="label">{{ t.label }}</text>
          <text class="desc">{{ t.desc }}</text>
        </view>
        <switch :checked="form[t.key]" color="#FF6B35" @change="onToggle(t.key, $event)" />
      </view>
    </view>

    <view class="card" v-if="form.enablePrinter">
      <view class="card-title">云打印机</view>
      <view class="row">
        <text class="label">打印机 SN</text>
        <input class="input" v-model="form.printerSN" placeholder="打印机编号" />
      </view>
      <view class="row">
        <text class="label">打印机 Key</text>
        <input class="input" v-model="form.printerKey" placeholder="打印机密钥" />
      </view>
    </view>

    <view class="card" v-if="form.enableWechat">
      <view class="card-title">微信通知</view>
      <view class="row">
        <text class="label">接收手机号</text>
        <input class="input" v-model="form.notifyPhone" placeholder="接收通知手机号" />
      </view>
    </view>

    <view class="footer">
      <button class="save" :loading="saving" @tap="save">保存设置</button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { get, put, getToken } from '@/utils/request.js';

const navs = [
  { ico: '📋', label: '菜单管理', desc: '分类 / 菜品 / 上下架', url: '/pages/admin/menu' },
  { ico: '📦', label: '订单管理', desc: '点餐订单 / 后厨看单', url: '/pages/admin/order' },
  { ico: '📊', label: '数据统计', desc: '营业额 / 销量概览', url: '/pages/admin/stats' },
  { ico: '🍴', label: '预览点餐页', desc: '顾客扫码点餐效果', url: '/pages/customer/index' }
];

const form = ref({
  shopName: '',
  enableVoice: true,
  enableBigscreen: true,
  enablePrinter: false,
  enableWechat: false,
  printerSN: '',
  printerKey: '',
  notifyPhone: ''
});

const toggles = [
  { key: 'enableVoice', label: '语音播报', desc: '新订单后厨自动语音播报' },
  { key: 'enableBigscreen', label: '大屏弹窗', desc: '新订单大屏弹窗提示' },
  { key: 'enablePrinter', label: '云打印机', desc: '新订单自动打印小票' },
  { key: 'enableWechat', label: '微信通知', desc: '新订单推送至手机' }
];

const saving = ref(false);

function go(url) {
  uni.navigateTo({ url });
}

function onToggle(key, e) {
  form.value[key] = e.detail.value;
}

async function loadSettings() {
  try {
    const s = await get('/settings');
    if (s) Object.assign(form.value, s);
  } catch (e) {}
}

async function save() {
  saving.value = true;
  try {
    await put('/settings', { ...form.value });
    uni.showToast({ title: '保存成功', icon: 'success' });
  } catch (e) {
    // request.js 已 toast
  } finally {
    saving.value = false;
  }
}

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  loadSettings();
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
  padding: 50rpx 32rpx 60rpx;
}
.hero-name { font-size: $fs-2xl; font-weight: $fw-bold; }
.hero-sub { font-size: $fs-sm; opacity: .9; margin-top: 10rpx; }

.card {
  background: $surface;
  margin: 20rpx;
  border-radius: $radius-lg;
  padding: 8rpx 24rpx;
  box-shadow: $shadow-sm;
}
.card-title {
  font-size: $fs-base; color: $brand; font-weight: $fw-semibold;
  padding: 20rpx 0 8rpx; border-bottom: 1rpx solid $ink-100;
}

.nav {
  display: flex; align-items: center; gap: 18rpx;
  padding: 26rpx 0; border-bottom: 1rpx solid $ink-50;
}
.nav:last-child { border-bottom: 0; }
.nav-ico {
  width: 72rpx; height: 72rpx; border-radius: 22rpx;
  background: $brand-50; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.nav-ico text { font-size: 36rpx; line-height: 1; }
.nav-txt { flex: 1; display: flex; flex-direction: column; }
.nav-label { font-size: $fs-lg; color: $ink-900; font-weight: $fw-medium; }
.nav-desc { font-size: $fs-sm; color: $ink-400; margin-top: 4rpx; }
.nav-arrow { font-size: 40rpx; color: $ink-200; }

.row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 24rpx 0; border-bottom: 1rpx solid $ink-50; gap: 20rpx;
}
.row:last-child { border-bottom: 0; }
.label-wrap { flex: 1; display: flex; flex-direction: column; }
.label { font-size: $fs-md; color: $ink-900; }
.desc { font-size: $fs-sm; color: $ink-400; margin-top: 6rpx; }
.input { flex: 1; text-align: right; font-size: $fs-md; color: $ink-900; max-width: 360rpx; }

.footer {
  position: fixed; left: 0; right: 0; bottom: 0;
  padding: 20rpx 32rpx calc(20rpx + env(safe-area-inset-bottom));
  background: $surface; box-shadow: $shadow;
}
.save {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-lg; font-weight: $fw-semibold; height: 80rpx; line-height: 80rpx;
  box-shadow: $shadow-brand;
}
button::after { border: none; }

/* 深色模式适配 */
@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .card { background: #1e1e1e; box-shadow: none; }
  .row, .nav { border-color: #2a2a2a; }
  .card-title { border-color: #2a2a2a; }
  .nav-ico { background: #2a2a2a; }
  .label, .nav-label { color: #e6e6e6; }
  .input { color: #e6e6e6; }
  .footer { background: #1e1e1e; }
}
</style>
