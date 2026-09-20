<template>
  <view class="login-page" :class="themeClass">
    <view class="brand">
      <view class="deco deco-1"></view>
      <view class="deco deco-2"></view>
      <view class="brand-logo">鼎</view>
      <view class="brand-name">鼎恒餐饮</view>
      <view class="brand-sub">门店经营 · 供应链 · 会员营销</view>
    </view>

    <view class="tabs">
      <view class="tab" :class="{ on: mode === 'login' }" @tap="switchMode('login')">登录</view>
      <view class="tab" :class="{ on: mode === 'register' }" @tap="switchMode('register')">注册</view>
    </view>

    <view class="card">
      <!-- 登录 -->
      <template v-if="mode === 'login'">
        <view class="field">
          <text class="fl">手机号</text>
          <input class="fi" type="number" v-model="loginForm.phone" placeholder="请输入手机号" maxlength="11" />
        </view>
        <view class="field">
          <text class="fl">密码</text>
          <input class="fi" :password="true" v-model="loginForm.password" placeholder="请输入密码" />
        </view>
        <button class="submit" :loading="submitting" @tap="doLogin">登录</button>
      </template>

      <!-- 注册 -->
      <template v-else>
        <view class="field">
          <text class="fl">店铺名称</text>
          <input class="fi" v-model="regForm.shopName" placeholder="请输入店铺名称" />
        </view>
        <view class="field">
          <text class="fl">联系人</text>
          <input class="fi" v-model="regForm.contactName" placeholder="请输入联系人姓名" />
        </view>
        <view class="field">
          <text class="fl">手机号</text>
          <input class="fi" type="number" v-model="regForm.phone" placeholder="请输入手机号" maxlength="11" />
        </view>
        <view class="field">
          <text class="fl">密码</text>
          <input class="fi" :password="true" v-model="regForm.password" placeholder="至少 6 位" />
        </view>
        <view class="field">
          <text class="fl">确认密码</text>
          <input class="fi" :password="true" v-model="regForm.confirm" placeholder="再次输入密码" />
        </view>
        <button class="submit" :loading="submitting" @tap="doRegister">注册并进入</button>
      </template>
    </view>

    <view class="tip">注册即赠送 30 天基础版会员体验</view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { post } from '@/utils/request.js';
// 界面主题：根 view 上挂 class（整套 CSS 变量在 src/styles/theme-vars.css）
import { useThemeClass } from '@/utils/theme.js';

const themeClass = useThemeClass();


const mode = ref('login');
const submitting = ref(false);

const loginForm = ref({ phone: '', password: '' });
const regForm = ref({ shopName: '', contactName: '', phone: '', password: '', confirm: '' });

function switchMode(m) {
  mode.value = m;
}

function saveAuth(data) {
  if (data && data.token) {
    uni.setStorageSync('token', data.token);
    if (data.shopId) uni.setStorageSync('shopId', data.shopId);
    if (data.shopName) uni.setStorageSync('shopName', data.shopName);
  }
}

function goAdmin() {
  uni.switchTab({ url: '/pages/admin/index' });
}

function validPhone(phone) {
  return /^1\d{10}$/.test(phone);
}

async function doLogin() {
  const { phone, password } = loginForm.value;
  if (!phone || !password) {
    uni.showToast({ title: '请输入手机号和密码', icon: 'none' });
    return;
  }
  if (!validPhone(phone)) {
    uni.showToast({ title: '手机号格式不正确', icon: 'none' });
    return;
  }
  submitting.value = true;
  try {
    const data = await post('/auth/merchant/login', { phone, password });
    saveAuth(data);
    uni.showToast({ title: '登录成功', icon: 'success' });
    setTimeout(goAdmin, 300);
  } catch (e) {
    // request.js 已 toast
  } finally {
    submitting.value = false;
  }
}

async function doRegister() {
  const { shopName, contactName, phone, password, confirm } = regForm.value;
  if (!shopName || !contactName || !phone || !password) {
    uni.showToast({ title: '请完整填写注册信息', icon: 'none' });
    return;
  }
  if (!validPhone(phone)) {
    uni.showToast({ title: '手机号格式不正确', icon: 'none' });
    return;
  }
  if (String(password).length < 6) {
    uni.showToast({ title: '密码至少 6 位', icon: 'none' });
    return;
  }
  if (confirm !== password) {
    uni.showToast({ title: '两次输入的密码不一致', icon: 'none' });
    return;
  }
  submitting.value = true;
  try {
    const data = await post('/auth/merchant/register', { shopName, contactName, phone, password, confirm });
    saveAuth(data);
    uni.showToast({ title: '注册成功', icon: 'success' });
    setTimeout(goAdmin, 300);
  } catch (e) {
    // request.js 已 toast
  } finally {
    submitting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.login-page {
  min-height: 100vh;
  background: $ink-50;
  box-sizing: border-box;
}

/* 顶部品牌渐变区 */
.brand {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 140rpx 40rpx 120rpx;
  background: $brand-grad;
  border-radius: 0 0 48rpx 48rpx;
  overflow: hidden;
}
.deco {
  position: absolute;
  border-radius: 50%;
  background: rgba(255, 255, 255, .10);
}
.deco-1 { top: -120rpx; right: -120rpx; width: 360rpx; height: 360rpx; }
.deco-2 { bottom: -80rpx; left: -60rpx; width: 260rpx; height: 260rpx; background: rgba(255, 255, 255, .08); }

.brand-logo {
  width: 140rpx;
  height: 140rpx;
  border-radius: 40rpx;
  background: #fff;
  color: $brand;
  font-size: 72rpx;
  font-weight: $fw-black;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 12rpx 32rpx rgba(0, 0, 0, .18);
  position: relative;
  z-index: 1;
}
.brand-name {
  margin-top: 28rpx;
  font-size: 48rpx;
  font-weight: $fw-bold;
  color: #fff;
  position: relative;
  z-index: 1;
}
.brand-sub {
  margin-top: 10rpx;
  font-size: 26rpx;
  color: rgba(255, 255, 255, .92);
  letter-spacing: 2rpx;
  position: relative;
  z-index: 1;
}

/* 表单区（悬浮于渐变区之上） */
.tabs {
  display: flex;
  background: $surface;
  border-radius: $radius-full;
  padding: 8rpx;
  margin: -60rpx 40rpx 0;
  box-shadow: $shadow-lg;
  position: relative;
  z-index: 2;
}
.tab {
  flex: 1;
  text-align: center;
  font-size: $fs-md;
  color: $ink-500;
  padding: 18rpx 0;
  border-radius: $radius-full;
  font-weight: $fw-medium;
}
.tab.on {
  background: $brand-grad;
  color: #fff;
  font-weight: $fw-semibold;
  box-shadow: $shadow-brand;
}

.card {
  background: $surface;
  border-radius: $radius-lg;
  padding: 8rpx 36rpx 40rpx;
  margin: 24rpx 40rpx 0;
  box-shadow: $shadow;
}
.field {
  display: flex;
  align-items: center;
  padding: 30rpx 0;
  border-bottom: 1rpx solid $ink-100;
}
.field:last-of-type {
  border-bottom: 0;
}
.fl {
  width: 160rpx;
  font-size: $fs-md;
  color: $ink-700;
  flex-shrink: 0;
  font-weight: $fw-medium;
}
.fi {
  flex: 1;
  font-size: $fs-md;
  text-align: right;
  color: $ink-900;
}
.submit {
  margin-top: 40rpx;
  background: $brand-grad;
  color: #fff;
  border-radius: $radius-full;
  font-size: $fs-lg;
  font-weight: $fw-semibold;
  height: 92rpx;
  line-height: 92rpx;
  box-shadow: $shadow-brand;
}
button::after {
  border: none;
}

.tip {
  text-align: center;
  font-size: $fs-sm;
  color: $ink-400;
  margin-top: 32rpx;
}

/* ★ 手写深色块已删（职责交给 .theme-dark），见 src/utils/theme.js */
</style>
