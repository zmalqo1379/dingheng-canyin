<template>
  <view class="login-page">
    <view class="brand">
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
  background: #f5f5f5;
  padding: 0 40rpx;
  box-sizing: border-box;
}

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 100rpx 0 60rpx;
}
.brand-logo {
  width: 140rpx;
  height: 140rpx;
  border-radius: 32rpx;
  background: linear-gradient(135deg, #ff6b35, #ff8a5c);
  color: #fff;
  font-size: 72rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8rpx 24rpx rgba(255, 107, 53, .35);
}
.brand-name {
  margin-top: 24rpx;
  font-size: 44rpx;
  font-weight: 700;
  color: #222;
}
.brand-sub {
  margin-top: 8rpx;
  font-size: 24rpx;
  color: #999;
}

.tabs {
  display: flex;
  background: #fff;
  border-radius: 40rpx;
  padding: 8rpx;
  margin-bottom: 24rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, .04);
}
.tab {
  flex: 1;
  text-align: center;
  font-size: 28rpx;
  color: #666;
  padding: 18rpx 0;
  border-radius: 32rpx;
}
.tab.on {
  background: #ff6b35;
  color: #fff;
  font-weight: 600;
}

.card {
  background: #fff;
  border-radius: 20rpx;
  padding: 8rpx 32rpx 32rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, .04);
}
.field {
  display: flex;
  align-items: center;
  padding: 28rpx 0;
  border-bottom: 1rpx solid #f5f5f5;
}
.field:last-of-type {
  border-bottom: 0;
}
.fl {
  width: 160rpx;
  font-size: 28rpx;
  color: #333;
  flex-shrink: 0;
}
.fi {
  flex: 1;
  font-size: 28rpx;
  text-align: right;
}
.submit {
  margin-top: 32rpx;
  background: #ff6b35;
  color: #fff;
  border-radius: 40rpx;
  font-size: 30rpx;
  height: 88rpx;
  line-height: 88rpx;
}
button::after {
  border: none;
}

.tip {
  text-align: center;
  font-size: 22rpx;
  color: #bbb;
  margin-top: 32rpx;
}

@media (prefers-color-scheme: dark) {
  .login-page { background: #121212; }
  .brand-name { color: #e6e6e6; }
  .tabs { background: #1e1e1e; box-shadow: none; }
  .card { background: #1e1e1e; box-shadow: none; }
  .field { border-color: #2a2a2a; }
  .fl { color: #e6e6e6; }
  .fi { color: #e6e6e6; }
}
</style>
