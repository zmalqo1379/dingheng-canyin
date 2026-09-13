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
      </view>
    </view>

    <view v-else class="empty">
      <view class="empty-ico">📑</view>
      <view class="empty-txt">{{ loaded ? '暂无采购订单' : '加载中…' }}</view>
      <button class="btn" @tap="goMall">去采购商城进货</button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import { get, getToken } from '@/utils/request.js';

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
.page { min-height: 100vh; background: #f5f5f5; padding-bottom: 40rpx; }

.tabs {
  white-space: nowrap; background: #fff; padding: 16rpx 12rpx;
  border-bottom: 1rpx solid #f0f0f0;
}
.tab {
  display: inline-block; padding: 10rpx 26rpx; margin: 0 8rpx;
  font-size: 26rpx; color: #666; background: #f5f5f5; border-radius: 30rpx;
}
.tab.active { background: #ff6b35; color: #fff; }

.list { padding: 20rpx; }
.card {
  background: #fff; border-radius: 16rpx; padding: 24rpx;
  margin-bottom: 20rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,.04);
}
.head {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 14rpx; border-bottom: 1rpx solid #f5f5f5;
}
.no { font-size: 24rpx; color: #999; }
.status { font-size: 24rpx; color: #ff6b35; font-weight: 600; }
.row { display: flex; justify-content: space-between; padding: 10rpx 0; }
.label { font-size: 25rpx; color: #999; }
.value { font-size: 26rpx; color: #333; }
.value.amount { color: #ff6b35; font-weight: 700; }
.items { margin-top: 12rpx; padding-top: 12rpx; border-top: 1rpx dashed #f0f0f0; }
.item { display: block; font-size: 23rpx; color: #777; line-height: 1.7; }
.item.more { color: #bbb; }

.empty { padding: 140rpx 60rpx; text-align: center; }
.empty-ico { font-size: 80rpx; }
.empty-txt { font-size: 26rpx; color: #999; margin: 20rpx 0 30rpx; }
.btn {
  background: #ff6b35; color: #fff; border-radius: 40rpx;
  font-size: 28rpx; height: 78rpx; line-height: 78rpx;
}
button::after { border: none; }

@media (prefers-color-scheme: dark) {
  .page { background: #121212; }
  .tabs { background: #1e1e1e; border-color: #2a2a2a; }
  .tab { background: #2a2a2a; color: #bbb; }
  .card { background: #1e1e1e; box-shadow: none; }
  .head { border-color: #2a2a2a; }
  .value { color: #e6e6e6; }
}
</style>
