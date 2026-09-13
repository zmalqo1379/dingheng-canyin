/**
 * utils/request.js
 * 统一封装 uni.request：
 *  - baseURL = 环境变量 VITE_API_BASE_URL，未配置时回退 http://localhost:3000/api
 *  - 统一返回 { success, data } 的 data 部分
 *  - 自动携带 Authorization（商家 JWT）与 x-shop-id（顾客/商家 shopId）
 *  - 401 自动跳转登录页
 *  - 网络异常 / 业务错误统一 toast
 *
 * 注意：
 *  1) 上线时请在 uni-app/.env 中配置 VITE_API_BASE_URL 为正式 https 域名，
 *     并在微信小程序后台「服务器域名」中登记该 request 合法域名。
 *  2) 开发期：H5 走 vite 代理（见 vite.config.js）；小程序真机调试需把
 *     VITE_API_BASE_URL 指向局域网 IP，或在开发者工具勾选「不校验合法域名」。
 *  3) 后端响应统一格式为 { success: true/false, data/message }。
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

export function getToken() {
  return uni.getStorageSync('token') || '';
}

// shopId：顾客扫码 / 商家登录后写入 storage，请求统一以 x-shop-id 头带上
export function getShopId() {
  return uni.getStorageSync('shopId') || '';
}

export function request(options) {
  const {
    url,
    method = 'GET',
    data = {},
    header = {},
    showError = true,
    raw = false
  } = options;

  return new Promise((resolve, reject) => {
    const finalHeader = Object.assign(
      { 'Content-Type': 'application/json' },
      header
    );
    const token = getToken();
    if (token) finalHeader['Authorization'] = 'Bearer ' + token;
    const shopId = getShopId();
    if (shopId) finalHeader['x-shop-id'] = shopId;

    uni.request({
      url: BASE_URL + url,
      method,
      data,
      header: finalHeader,
      timeout: 15000,
      success: (res) => {
        // 401 未授权：清 token 跳登录
        if (res.statusCode === 401) {
          uni.removeStorageSync('token');
          uni.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
          setTimeout(() => {
            uni.reLaunch({ url: '/pages/login/index' });
          }, 800);
          return reject(new Error('未授权'));
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          const body = res.data || {};
          // raw 模式直接返回原始响应体
          if (raw) return resolve(body);
          // 业务层：success 为 false 视为失败
          if (body.success === false) {
            if (showError) {
              uni.showToast({ title: body.message || '请求失败', icon: 'none' });
            }
            return reject(new Error(body.message || '请求失败'));
          }
          // 统一返回 data 字段（后端约定 { success:true, data:... }）
          return resolve(body.data !== undefined ? body.data : body);
        }

        // 其它非 2xx
        const msg = (res.data && res.data.message) || '请求失败(' + res.statusCode + ')';
        if (showError) uni.showToast({ title: msg, icon: 'none' });
        reject(new Error(msg));
      },
      fail: (err) => {
        // 网络层失败（断网 / 超时 / 域名不通）
        const msg = '网络异常，请检查网络或服务是否启动';
        if (showError) uni.showToast({ title: msg, icon: 'none' });
        reject(err);
      }
    });
  });
}

export const get = (url, data, options = {}) =>
  request({ url, method: 'GET', data, ...options });

export const post = (url, data, options = {}) =>
  request({ url, method: 'POST', data, ...options });

export const put = (url, data, options = {}) =>
  request({ url, method: 'PUT', data, ...options });

export const del = (url, data, options = {}) =>
  request({ url, method: 'DELETE', data, ...options });

export default { request, get, post, put, del, getToken, getShopId, BASE_URL };
