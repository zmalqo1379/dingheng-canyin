/**
 * utils/cart.js
 * 购物车离线保护 + 待提交订单自动同步
 *
 *  - 购物车按 tableId 维度存 uni.setStorageSync，断网仍可点餐。
 *  - 下单失败（断网）时把订单存入 pending 列表，联网后自动重新提交。
 */

import { post } from './request.js';

const CART_PREFIX = 'cart_'; // + tableId
const PENDING_KEY = 'pending_orders';
let netListenerReady = false;

/* ============ 购物车（按桌号） ============ */

export function getCart(tableId) {
  if (!tableId) return [];
  const list = uni.getStorageSync(CART_PREFIX + tableId);
  return Array.isArray(list) ? list : [];
}

export function setCart(tableId, items) {
  if (!tableId) return;
  uni.setStorageSync(CART_PREFIX + tableId, items || []);
}

export function clearCart(tableId) {
  if (!tableId) return;
  uni.removeStorageSync(CART_PREFIX + tableId);
}

/* ============ 待提交订单（离线队列） ============ */

export function getPendingOrders() {
  const list = uni.getStorageSync(PENDING_KEY);
  return Array.isArray(list) ? list : [];
}

function setPendingOrders(list) {
  uni.setStorageSync(PENDING_KEY, list || []);
}

export function addPendingOrder(order) {
  const list = getPendingOrders();
  list.push(order);
  setPendingOrders(list);
}

export function removePendingOrder(localId) {
  const list = getPendingOrders().filter((o) => o.localId !== localId);
  setPendingOrders(list);
}

/**
 * 联网后自动同步：逐条提交 pending 订单
 * 提交成功即移除；失败则保留待下次重试
 */
export async function syncPendingOrders() {
  const list = getPendingOrders();
  if (!list.length) return;
  for (const item of list) {
    try {
      await post('/orders', {
        tableNumber: String(item.tableNumber),
        items: item.items
      });
      removePendingOrder(item.localId);
      console.log('[cart] 离线订单已同步:', item.localId);
    } catch (e) {
      // 仍失败则停止，等下次联网再试
      console.warn('[cart] 同步失败，稍后重试:', item.localId);
      break;
    }
  }
}

/**
 * 注册网络状态监听：网络恢复即尝试同步
 */
export function setupNetworkListener() {
  if (netListenerReady) return;
  netListenerReady = true;
  try {
    uni.onNetworkStatusChange((res) => {
      if (res.isConnected) {
        syncPendingOrders();
      }
    });
  } catch (e) {
    console.warn('[cart] 网络监听注册失败', e);
  }
}

export default {
  getCart,
  setCart,
  clearCart,
  getPendingOrders,
  addPendingOrder,
  removePendingOrder,
  syncPendingOrders,
  setupNetworkListener
};
