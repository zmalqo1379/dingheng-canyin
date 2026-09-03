<template>
  <view class="page">
    <view class="hero">
      <view class="hero-name">{{ form.shopName || '鼎恒餐饮' }}</view>
      <view class="hero-sub">店铺设置 · 一键管理通知与打印</view>
    </view>

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
        <switch
          :checked="form[t.key]"
          color="#FF6B35"
          @change="onToggle(t.key, $event)"
        />
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
import { ref, onMounted } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { get, put } from '@/utils/request.js';

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
    const body = { ...form.value };
    await put('/settings', body);
    uni.showToast({ title: '保存成功', icon: 'success' });
  } catch (e) {
    // request.js 已 toast
  } finally {
    saving.value = false;
  }
}

onLoad(() => {
  loadSettings();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  background: #f5f5f5;
  padding-bottom: 180rpx;
}

.hero {
  background: linear-gradient(135deg, #ff6b35, #ff8a5c);
  color: #fff;
  padding: 50rpx 32rpx 60rpx;
}
.hero-name { font-size: 44rpx; font-weight: 700; }
.hero-sub { font-size: 24rpx; opacity: .9; margin-top: 10rpx; }

.card {
  background: #fff;
  margin: 20rpx;
  border-radius: 16rpx;
  padding: 8rpx 24rpx;
  box-shadow: 0 2rpx 12rpx rgba(0,0,0,.04);
}
.card-title {
  font-size: 26rpx; color: #ff6b35; font-weight: 600;
  padding: 20rpx 0 8rpx; border-bottom: 1rpx solid #f5f5f5;
}
.row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 24rpx 0; border-bottom: 1rpx solid #f5f5f5; gap: 20rpx;
}
.row:last-child { border-bottom: 0; }
.label-wrap { flex: 1; display: flex; flex-direction: column; }
.label { font-size: 28rpx; color: #333; }
.desc { font-size: 22rpx; color: #999; margin-top: 6rpx; }
.input { flex: 1; text-align: right; font-size: 28rpx; color: #333; max-width: 360rpx; }

.footer {
  position: fixed; left: 0; right: 0; bottom: 0;
  padding: 20rpx 32rpx calc(20rpx + env(safe-area-inset-bottom));
  background: #fff; box-shadow: 0 -2rpx 12rpx rgba(0,0,0,.06);
}
.save {
  background: #ff6b35; color: #fff; border-radius: 40rpx;
  font-size: 30rpx; height: 80rpx; line-height: 80rpx;
}
button::after { border: none; }

/* 深色模式适配 */
@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .card { background: #1e1e1e; box-shadow: none; }
  .row { border-color: #2a2a2a; }
  .card-title { border-color: #2a2a2a; }
  .label { color: #e6e6e6; }
  .input { color: #e6e6e6; }
  .footer { background: #1e1e1e; }
}
</style>
