<template>
  <view class="kitchen">
    <view class="ktabs">
      <view class="ktab" :class="{ on: tab === 'pending' }" @tap="switchTab('pending')">待处理 {{ pending.length }}</view>
      <view class="ktab" :class="{ on: tab === 'completed' }" @tap="switchTab('completed')">已完成</view>
      <view class="voice" @tap="toggleVoice">
        <text class="ic">{{ voiceOn ? '🔊' : '🔇' }}</text>
        <text class="vt">{{ voiceOn ? '语音开' : '语音关' }}</text>
      </view>
    </view>

    <scroll-view scroll-y class="olist">
      <view v-for="o in currentList" :key="o._id" class="ocard" :class="{ new: isNew(o._id) }">
        <view class="ohead">
          <view class="otable">桌号 {{ o.tableNumber }}</view>
          <view class="otime">{{ formatTime(o.createdAt) }}</view>
        </view>
        <view class="oitems">
          <view class="oitem" v-for="(it, i) in o.items" :key="i">
            <text class="oiname">{{ it.dishName }}</text>
            <text class="oqty">×{{ it.quantity }}</text>
            <text class="oprice">¥{{ (it.price * it.quantity).toFixed(2) }}</text>
          </view>
        </view>
        <view class="ofoot">
          <text class="ototal">合计 ¥{{ Number(o.totalPrice || 0).toFixed(2) }}</text>
          <view v-if="o.status === 'pending'" class="obtn" @tap="complete(o)">完成出餐</view>
          <view v-else class="obtn done">已出餐</view>
        </view>
      </view>
      <view v-if="!currentList.length" class="empty">{{ tab === 'pending' ? '暂无待处理订单' : '暂无已完成订单' }}</view>
      <view style="height: 40rpx"></view>
    </scroll-view>

    <view class="tip" v-if="tab === 'pending'">每 {{ POLL_SEC }} 秒自动刷新 · 新订单自动播报</view>
  </view>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { onLoad, onUnload, onPullDownRefresh, onHide, onShow } from '@dcloudio/uni-app';
import { get, put, getToken } from '@/utils/request.js';
import { playNewOrder, destroyAudio } from '@/utils/audio.js';

const POLL_SEC = 5;
const orders = ref([]); // 当前 tab 的订单
const tab = ref('pending'); // pending | completed
const pending = ref([]); // 待处理数量（用于 tab 角标）
const knownIds = ref(new Set()); // 已知订单 id，用于识别"新订单"
const newIds = ref(new Set()); // 刚到的新订单（用于高亮）
const voiceOn = ref(true);
let timer = null;

const currentList = computed(() => {
  // orders 已是当前 tab 的数据
  return orders.value;
});

function switchTab(t) {
  if (t === tab.value) return;
  tab.value = t;
  load();
}

async function load(silent = false) {
  try {
    const list = await get('/admin/orders', { status: tab.value });
    const arr = Array.isArray(list) ? list : [];
    if (tab.value === 'pending') {
      // 识别新订单：仅当之前已有数据且非静默刷新时才播报+高亮
      const arrived = arr.filter((o) => !knownIds.value.has(o._id));
      if (arrived.length && knownIds.value.size > 0 && !silent) {
        arrived.forEach((o) => newIds.value.add(o._id));
        if (voiceOn.value) playNewOrder();
      }
      // 始终更新已知集合，避免下次刷新重复误报
      arr.forEach((o) => knownIds.value.add(o._id));
      pending.value = arr;
    } else {
      // 已完成 tab：补取一次待处理数量做角标
      try {
        const p = await get('/admin/orders', { status: 'pending' });
        pending.value = Array.isArray(p) ? p : [];
      } catch (e) {}
    }
    orders.value = arr;
  } catch (e) {}
}

function isNew(id) {
  return newIds.value.has(id);
}

function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function complete(o) {
  uni.showModal({
    title: '出餐确认',
    content: `确认桌号 ${o.tableNumber} 已出餐？`,
    confirmColor: '#FF6B35',
    success: async (r) => {
      if (!r.confirm) return;
      try {
        await put('/orders/' + o._id + '/complete');
        uni.showToast({ title: '已出餐', icon: 'success' });
        await load(true);
      } catch (e) {}
    }
  });
}

function toggleVoice() {
  voiceOn.value = !voiceOn.value;
  uni.showToast({ title: voiceOn.value ? '已开启语音播报' : '已关闭语音播报', icon: 'none' });
  // 开启时先播一次，解锁音频上下文
  if (voiceOn.value) playNewOrder();
}

function startPolling() {
  stopPolling();
  timer = setInterval(() => load(true), POLL_SEC * 1000);
}
function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  load().then(() => startPolling());
});
onShow(() => startPolling());
onHide(() => stopPolling());
onUnload(() => { stopPolling(); destroyAudio(); });
onUnmounted(() => { stopPolling(); destroyAudio(); });

onPullDownRefresh(() => load(true).finally(() => uni.stopPullDownRefresh()));
</script>

<style lang="scss" scoped>
.kitchen {
  min-height: 100vh;
  background: #121212;
  display: flex;
  flex-direction: column;
  color: #e6e6e6;
}

.ktabs {
  display: flex; align-items: center; background: #1f1f1f; padding: 16rpx 20rpx;
  border-bottom: 1rpx solid #2a2a2a; position: sticky; top: 0; z-index: 5; gap: 12rpx;
}
.ktab { padding: 10rpx 28rpx; font-size: 26rpx; color: #888; border-radius: 30rpx; background: #2a2a2a; }
.ktab.on { background: #ff6b35; color: #fff; }
.voice { margin-left: auto; display: flex; align-items: center; gap: 8rpx; font-size: 22rpx; color: #aaa; }
.voice .ic { font-size: 32rpx; }

.olist { flex: 1; padding: 20rpx; }
.ocard {
  background: #1e1e1e; border-radius: 16rpx; padding: 24rpx; margin-bottom: 20rpx;
  border-left: 8rpx solid #333;
}
.ocard.new { border-left-color: #ff6b35; animation: blink 1.5s ease-in-out 3; }
@keyframes blink { 0%,100%{ box-shadow: 0 0 0 rgba(255,107,53,0);} 50%{ box-shadow: 0 0 24rpx rgba(255,107,53,.5);} }

.ohead { display: flex; justify-content: space-between; align-items: center; }
.otable { font-size: 32rpx; font-weight: 700; color: #fff; }
.otime { font-size: 24rpx; color: #888; }

.oitems { margin-top: 16rpx; border-top: 1rpx solid #2a2a2a; padding-top: 12rpx; }
.oitem { display: flex; align-items: center; padding: 10rpx 0; }
.oiname { flex: 1; font-size: 28rpx; color: #e6e6e6; }
.oqty { width: 80rpx; text-align: center; color: #ff8a5c; font-size: 26rpx; }
.oprice { width: 140rpx; text-align: right; color: #999; font-size: 26rpx; }

.ofoot { display: flex; align-items: center; justify-content: space-between; margin-top: 16rpx; padding-top: 16rpx; border-top: 1rpx solid #2a2a2a; }
.ototal { color: #ff6b35; font-size: 30rpx; font-weight: 700; }
.obtn { background: #ff6b35; color: #fff; font-size: 26rpx; padding: 14rpx 32rpx; border-radius: 30rpx; }
.obtn.done { background: #3a3a3a; color: #888; }

.empty { text-align: center; color: #555; padding: 100rpx 0; }
.tip { text-align: center; font-size: 22rpx; color: #555; padding: 6rpx 0 20rpx; }
</style>
