<script setup>
import { onLaunch, onShow, onHide } from '@dcloudio/uni-app';
import { setupNetworkListener, syncPendingOrders } from './utils/cart.js';
import { applyChrome } from './utils/theme.js';

onLaunch(() => {
  // 注册网络监听 + 首次尝试同步离线期间缓存的订单
  setupNetworkListener();
  syncPendingOrders();
  // 导航栏 / tabBar 是原生部件，不吃 CSS 变量，启动时按本机主题刷一次
  applyChrome();
  console.log('[App] 鼎恒餐饮前端已启动');
});

onShow(() => {
  // 回到前台时尝试同步待提交订单
  syncPendingOrders();
  applyChrome();   // 系统深浅可能在后台被改过，重新对齐一次
});

onHide(() => {
  console.log('[App] 进入后台');
});
</script>

<style>
/* 四套主题的变量取值（classic/warm/dark/fresh）。
   必须在这里全局引入：页面样式里写的都是 var(--dh-xxx)，没有这一层就没有值，
   会退化成 uni.scss 里的回退值（也就是改造前的样子）。 */
@import './styles/theme-vars.css';

/* 全局基础样式：底色走主题变量，回退值 = 改造前写死的 #f5f5f5 / #333（经典版零变化） */
page {
  background-color: var(--dh-bg, #f5f5f5);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 28rpx;
  color: var(--dh-text, #333);
}

/* 主题底色必须铺在【根 view】上，不能只铺 page —— 这是本端最容易踩的坑：
   主题 class 是挂在页面根 view 上的（各页 <view class="page" :class="themeClass">），
   而 CSS 变量只【往下】继承：page 是根 view 的父节点，它自己永远只能拿到
   theme-vars.css 里 page{} 那一组经典版基线值，看不到 .theme-dark 的取值。
   结果就是「深色卡片浮在浅灰页面上」，看着像没换成功。
   所以挂了主题 class 的根 view 自己铺满整屏底色。 */
.theme-warm, .theme-dark, .theme-fresh {
  min-height: 100vh;
  background-color: var(--dh-bg);
  color: var(--dh-text);
}

/* 清除默认点击高亮 */
view, text, button {
  box-sizing: border-box;
}

/* 深色模式全局适配（用户没手动选过主题时走这条：微信小程序支持 prefers-color-scheme）
   这里没有主题 class，拿不到 --dh-* 的深色取值，只能写死 —— 取值与 theme-vars.css
   的 .theme-dark 同一组（#0E1620 / #C6CDD6），不要两边各写各的。 */
@media (prefers-color-scheme: dark) {
  page {
    background-color: #0E1620;
    color: #C6CDD6;
  }
}
</style>
