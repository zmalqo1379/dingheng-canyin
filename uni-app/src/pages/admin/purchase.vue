<template>
  <view class="page">
    <!-- 状态筛选 -->
    <scroll-view class="tabs" scroll-x>
      <view
        v-for="t in tabs"
        :key="t.value"
        class="tab"
        :class="{ active: tab === t.value }"
        @tap="switchTab(t.value)"
      >{{ t.label }}</view>
    </scroll-view>

    <view v-if="orders.length" class="list">
      <view class="card" v-for="o in orders" :key="o._id || o.orderNo">
        <view class="head">
          <text class="no">{{ o.orderNo || '-' }}</text>
          <text class="status">{{ o.status || '-' }}</text>
        </view>
        <view class="row">
          <text class="label">供应商</text>
          <text class="value">{{ supplierName(o) }}</text>
        </view>
        <view class="row">
          <text class="label">商品</text>
          <text class="value">{{ (o.items || []).length }} 项</text>
        </view>
        <view class="row">
          <text class="label">金额</text>
          <text class="value amount">¥{{ money(o.totalAmount) }}</text>
        </view>
        <view class="row">
          <text class="label">下单时间</text>
          <text class="value">{{ fmt(o.createdAt) }}</text>
        </view>
        <view class="items" v-if="(o.items || []).length">
          <text class="item" v-for="(it, i) in o.items.slice(0, 4)" :key="i">
            {{ it.name }} × {{ it.quantity }}{{ it.unit || '' }}
          </text>
          <text class="item more" v-if="o.items.length > 4">等 {{ o.items.length }} 项</text>
        </view>
        <view class="actions" v-if="o.status === '已发货'">
          <button class="receive-btn" :loading="receivingId === (o._id || o.orderNo)" @tap="confirmReceive(o)">确认收货</button>
        </view>
      </view>
    </view>

    <view v-else class="empty">
      <view class="empty-ico"><text>📑</text></view>
      <view class="empty-txt">{{ loaded ? '暂无采购订单' : '加载中…' }}</view>
      <button class="btn" @tap="goMall">去采购商城进货</button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import { get, post, getToken } from '@/utils/request.js';

const tabs = [
  { label: '全部', value: '' },
  { label: '待确认', value: '待确认' },
  { label: '已确认', value: '已确认' },
  { label: '已发货', value: '已发货' },
  { label: '已完成', value: '已完成' }
];

const tab = ref('');
const orders = ref([]);
const loaded = ref(false);
const receivingId = ref('');

function money(v) {
  return (Number(v) || 0).toFixed(2);
}
function fmt(d) {
  return d ? String(d).replace('T', ' ').slice(0, 16) : '-';
}
function supplierName(o) {
  if (!o) return '-';
  if (o.supplierName) return o.supplierName;
  if (o.supplierId && typeof o.supplierId === 'object' && o.supplierId.name) return o.supplierId.name;
  return '供应商';
}
function goMall() {
  uni.switchTab({ url: '/pages/admin/mall' });
}

function confirmReceive(o) {
  const id = o._id || o.orderNo;
  uni.showModal({
    title: '确认收货',
    content: `确认已收到「${supplierName(o)}」的货物？收货后将结算采购积分并发放鼎恒币。`,
    confirmColor: '#FF6B35',
    success: async (r) => {
      if (!r.confirm) return;
      receivingId.value = id;
      try {
        const data = await post('/purchase-orders/' + id + '/confirm-receive', {});
        const reward = (data && data.rewardCoin) ? ('，得 ' + data.rewardCoin + ' 鼎恒币') : '';
        uni.showToast({ title: '收货成功' + reward, icon: 'none', duration: 2500 });
        await load();
      } catch (e) {
        // request.js 已 toast
      } finally {
        receivingId.value = '';
      }
    }
  });
}

async function load() {
  const query = {};
  if (tab.value) query.status = tab.value;
  try {
    const list = await get('/purchase-orders', query, { showError: false });
    orders.value = Array.isArray(list) ? list : ((list && list.data) || []);
  } catch (e) {
    orders.value = [];
  } finally {
    loaded.value = true;
  }
}

function switchTab(v) {
  tab.value = v;
  load();
}

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/index' });
  }
});
onShow(() => { load(); });
onPullDownRefresh(async () => {
  await load();
  uni.stopPullDownRefresh();
});
</script>

<style lang="scss" scoped>
.page { min-height: 100vh; background: $ink-50; padding-bottom: 40rpx; }

.tabs {
  white-space: nowrap; background: $surface; padding: 16rpx 12rpx;
  border-bottom: 1rpx solid $ink-100;
}
.tab {
  display: inline-block; padding: 10rpx 26rpx; margin: 0 8rpx;
  font-size: $fs-base; color: $ink-500; background: $ink-50; border-radius: $radius-full;
}
.tab.active { background: $brand-grad; color: #fff; }

.list { padding: 20rpx; }
.card {
  background: $surface; border-radius: $radius-lg; padding: 24rpx;
  margin-bottom: 20rpx; box-shadow: $shadow-sm;
}
.head {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 14rpx; border-bottom: 1rpx solid $ink-100;
}
.no { font-size: $fs-sm; color: $ink-400; }
.status { font-size: $fs-sm; color: $brand; font-weight: $fw-semibold; }
.row { display: flex; justify-content: space-between; padding: 10rpx 0; }
.label { font-size: $fs-base; color: $ink-400; }
.value { font-size: $fs-base; color: $ink-700; }
.value.amount { color: $brand; font-weight: $fw-bold; }
.items { margin-top: 12rpx; padding-top: 12rpx; border-top: 1rpx dashed $ink-100; }
.item { display: block; font-size: $fs-sm; color: $ink-500; line-height: 1.7; }
.item.more { color: $ink-300; }
.actions { margin-top: 16rpx; padding-top: 16rpx; border-top: 1rpx solid $ink-50; display: flex; justify-content: flex-end; }
.receive-btn {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-base; font-weight: $fw-semibold; height: 60rpx; line-height: 60rpx; padding: 0 30rpx;
  box-shadow: $shadow-brand;
}

.empty { padding: 140rpx 60rpx; text-align: center; }
.empty-ico {
  width: 140rpx; height: 140rpx; border-radius: 40rpx; margin: 0 auto;
  background: $brand-50; display: flex; align-items: center; justify-content: center;
}
.empty-ico text { font-size: 72rpx; line-height: 1; }
.empty-txt { font-size: $fs-base; color: $ink-400; margin: 24rpx 0 30rpx; }
.btn {
  background: $brand-grad; color: #fff; border-radius: $radius-full;
  font-size: $fs-md; font-weight: $fw-semibold; height: 78rpx; line-height: 78rpx;
  box-shadow: $shadow-brand;
}
button::after { border: none; }

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .tabs { background: #1e1e1e; border-color: #2a2a2a; }
  .tab { background: #2a2a2a; color: #bbb; }
  .card { background: #1e1e1e; box-shadow: none; }
  .head { border-color: #2a2a2a; }
  .value { color: #e6e6e6; }
  .empty-ico { background: #2a2a2a; }
}
</style>
