<template>
  <view class="page" :class="themeClass">
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

    <!-- 商家认证入口（上线加固第一批：从更多页可手动进入认证页） -->
    <view class="card" v-if="certHint">
      <view class="card-title">商家认证</view>
      <view class="nav" @tap="goCert">
        <view class="nav-ico"><text>🛡️</text></view>
        <view class="nav-txt">
          <text class="nav-label">店铺认证</text>
          <text class="nav-desc">{{ certHint }}</text>
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

    <!-- 界面主题：只改本机外观，不动任何业务数据（2026-09-19 新增）。
         位置压在所有店铺设置之后、保存按钮之前 —— 第一屏是做生意的地方，
         外观设置沉到最后，这条规矩跟网页端三端保持一致。 -->
    <view class="card">
      <view class="card-title">界面主题</view>
      <view class="theme-row" v-for="t in themes" :key="t.key" @tap="pickTheme(t.key)">
        <view class="theme-dot" :style="{ background: t.dot }"></view>
        <view class="theme-info">
          <text class="theme-name">{{ t.name }}</text>
          <text class="theme-slogan">{{ t.slogan }}</text>
        </view>
        <text class="theme-check" v-if="t.key === curTheme">✓</text>
      </view>
      <view class="theme-tip">只保存在本机，不上传服务器，也不影响别人的手机</view>
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
import { THEMES, setTheme, currentKey, useThemeClass } from '@/utils/theme.js';

// 界面主题（本机外观设置）
const themeClass = useThemeClass();
const themes = THEMES;
const curTheme = ref(currentKey());
function pickTheme(key) {
  setTheme(key);            // 存本机 + 同步导航栏/tabBar
  curTheme.value = key;     // 打勾跟着走
}

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

const certHint = ref('');
async function loadCertStatus() {
  try {
    const s = await get('/admin/certification/status', {}, { showError: false });
    if (!s) { certHint.value = ''; return; }
    if (s.certified) {
      certHint.value = '已认证 · 可不限额下单';
    } else {
      const blocking = (s.missingBlocking || []).length;
      const skippable = (s.missingSkippable || []).length;
      certHint.value = `未认证 · 履约 ${blocking} 项 / 合规 ${skippable} 项待补齐`;
    }
  } catch (e) { certHint.value = ''; }
}
function goCert() { uni.navigateTo({ url: '/pages/admin/cert' }); }

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
  loadCertStatus();
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

/* ===== 界面主题四选一 ===== */
.theme-row {
  display: flex; align-items: center; gap: 20rpx;
  padding: 20rpx 4rpx; border-bottom: 1rpx solid $ink-100;
}
.theme-row:last-of-type { border-bottom: none; }
.theme-dot { width: 36rpx; height: 36rpx; border-radius: 50%; flex-shrink: 0; }
.theme-info { flex: 1; display: flex; flex-direction: column; gap: 4rpx; min-width: 0; }
.theme-name { font-size: $fs-base; font-weight: $fw-semibold; color: $ink-900; }
.theme-slogan { font-size: $fs-xs; color: $ink-500; }
.theme-check { font-size: $fs-lg; color: $brand; font-weight: $fw-bold; }
.theme-tip { margin-top: 16rpx; font-size: $fs-xs; color: $ink-400; line-height: 1.6; }
</style>
