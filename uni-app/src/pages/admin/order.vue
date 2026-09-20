<template>
  <view class="kitchen" :class="themeClass">
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
// 界面主题：根 view 上挂 class（整套 CSS 变量在 src/styles/theme-vars.css）
import { useThemeClass } from '@/utils/theme.js';

const themeClass = useThemeClass();

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
/* 后厨 KDS 的四套主题形态：一律深底，变的是【色相】。
   为什么不能跟着其它页面一起变浅：后厨是强光 + 油烟 + 连续盯屏几小时的环境，
   浅底会眩光、费眼，深底是功能需要，不是配色偏好 —— 这一页永远不跟着主题变亮。
   换主题能看出变化的地方：底色色相（中性黑 / 墨绿 / 蓝黑 / 青黑）+ 强调色。
   强调色一律走 --dh-kds-accent（主色在近黑底上的提亮版）：主色本身太暗，
   比如松墨绿 #177A56 压在 #0F1A15 上几乎分不出来，出餐位会看错数量。
   所有 var() 的回退值 = 改造前写死的字面值 —— 经典版外观与改造前一模一样。 */
.kitchen {
  min-height: 100vh;
  background: var(--dh-kds-bg, #121212);
  display: flex;
  flex-direction: column;
  color: var(--dh-kds-text, #e6e6e6);
}

.ktabs {
  display: flex; align-items: center; background: var(--dh-kds-bar, #1f1f1f); padding: 16rpx 20rpx;
  border-bottom: 1rpx solid var(--dh-kds-line, #2a2a2a); position: sticky; top: 0; z-index: 5; gap: 12rpx;
}
.ktab { padding: 10rpx 28rpx; font-size: $fs-base; color: var(--dh-kds-sub, #888); border-radius: $radius-full; background: var(--dh-kds-chip, #2a2a2a); }
.ktab.on { background: $brand-grad; color: #fff; }
.voice { margin-left: auto; display: flex; align-items: center; gap: 8rpx; font-size: $fs-sm; color: var(--dh-kds-sub, #aaa); }
.voice .ic { font-size: 32rpx; }

.olist { flex: 1; padding: 20rpx; }
.ocard {
  background: var(--dh-kds-card, #1e1e1e); border-radius: $radius-lg; padding: 24rpx; margin-bottom: 20rpx;
  border-left: 8rpx solid var(--dh-kds-chip, #333);
}
.ocard.new { border-left-color: var(--dh-kds-accent, #FF6B35); animation: blink 1.5s ease-in-out 3; }
/* 新单闪烁光跟着主题走（松墨绿闪浅绿、深色闪暖橙、青绿闪亮青）。
   万一某些 WebView 不解析 keyframes 里的 var()，最坏只是不发光 ——
   新单仍有左侧强调色条，不会漏单，所以这里不做降级兜底。 */
@keyframes blink { 0%,100%{ box-shadow: 0 0 0 rgba(255,107,53,0);} 50%{ box-shadow: 0 0 24rpx var(--dh-kds-glow, rgba(255,107,53,.5));} }

.ohead { display: flex; justify-content: space-between; align-items: center; }
.otable { font-size: $fs-xl; font-weight: $fw-bold; color: var(--dh-kds-title, #fff); }
.otime { font-size: $fs-sm; color: var(--dh-kds-sub, #888); }

.oitems { margin-top: 16rpx; border-top: 1rpx solid var(--dh-kds-line, #2a2a2a); padding-top: 12rpx; }
.oitem { display: flex; align-items: center; padding: 10rpx 0; }
.oiname { flex: 1; font-size: $fs-md; color: var(--dh-kds-text, #e6e6e6); }
.oqty { width: 80rpx; text-align: center; color: var(--dh-kds-accent, #FF7A4D); font-size: $fs-base; }
.oprice { width: 140rpx; text-align: right; color: var(--dh-kds-sub, #999); font-size: $fs-base; }

.ofoot { display: flex; align-items: center; justify-content: space-between; margin-top: 16rpx; padding-top: 16rpx; border-top: 1rpx solid var(--dh-kds-line, #2a2a2a); }
.ototal { color: var(--dh-kds-accent, #FF6B35); font-size: $fs-lg; font-weight: $fw-bold; }
.obtn { background: $brand-grad; color: #fff; font-size: $fs-base; padding: 14rpx 32rpx; border-radius: $radius-full; }
.obtn.done { background: var(--dh-kds-done-bg, #3a3a3a); color: var(--dh-kds-done-text, #888); }

.empty { text-align: center; color: var(--dh-kds-sub, #555); padding: 100rpx 0; }
.tip { text-align: center; font-size: $fs-sm; color: var(--dh-kds-sub, #555); padding: 6rpx 0 20rpx; }
</style>
