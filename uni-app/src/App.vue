<script setup>
import { onLaunch, onShow, onHide } from '@dcloudio/uni-app';
import { setupNetworkListener, syncPendingOrders } from './utils/cart.js';

onLaunch(() => {
  // 注册网络监听 + 首次尝试同步离线期间缓存的订单
  setupNetworkListener();
  syncPendingOrders();
  console.log('[App] 鼎恒餐饮前端已启动');
});

onShow(() => {
  // 回到前台时尝试同步待提交订单
  syncPendingOrders();
});

onHide(() => {
  console.log('[App] 进入后台');
});
</script>

<style>
/* 全局基础样式 */
page {
  background-color: #f5f5f5;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 28rpx;
  color: #333;
}

/* 清除默认点击高亮 */
view, text, button {
  box-sizing: border-box;
}

/* 深色模式全局适配（微信小程序支持 prefers-color-scheme） */
@media (prefers-color-scheme: dark) {
  page {
    background-color: #121212;
    color: #e6e6e6;
  }
}
</style>
