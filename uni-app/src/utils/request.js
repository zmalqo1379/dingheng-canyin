/**
 * utils/request.js
 * 统一封装 uni.request：
 *  - baseURL = http://localhost:3000/api
 *  - 统一返回 { success, data } 的 data 部分
 *  - 401 自动跳转登录页
 *  - 网络异常 / 业务错误统一 toast
 *
 * 注意：
 *  1) 微信小程序真机调试时 localhost 不可达，请改为内网/公网 HTTPS 域名，
 *     并在 mp 微信后台 request 合法域名中配置；开发期在微信开发者工具
 *     「详情 → 本地设置 → 不校验合法域名」勾选即可使用 http://localhost。
 *  2) 后端响应统一格式为 { success: true/false, data/message }。
 */

const BASE_URL = 'http://localhost:3000/api';

function getToken() {
  return uni.getStorageSync('token') || '';
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
            uni.reLaunch({ url: '/pages/customer/index' });
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

export default { request, get, post, put, del, BASE_URL };
