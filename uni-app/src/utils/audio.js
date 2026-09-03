/**
 * utils/audio.js
 * 微信小程序 InnerAudioContext 播放新订单提示音
 *
 * 提示音文件位于 static/audio/new-order.wav（由 scripts/gen-icons.cjs 生成，双音"叮咚"）。
 * 如需真人语音"您有新的订单，请注意查收"，请将 mp3 放到
 * static/audio/new-order.mp3 并把下方 SRC 改为对应路径即可。
 */

const SRC = '/static/audio/new-order.wav';

let ctx = null;

export function getAudio() {
  if (ctx) return ctx;
  ctx = uni.createInnerAudioContext();
  ctx.src = SRC;
  ctx.obeyMuteSwitch = false; // 静音键不影响提示音
  ctx.volume = 1;
  ctx.onError((err) => {
    console.warn('[audio] 播放失败:', err);
  });
  return ctx;
}

/**
 * 播放一次新订单提示音
 * 每次重置到起点再播放，保证连续新订单都能响。
 */
export function playNewOrder() {
  try {
    const a = getAudio();
    a.stop();
    a.seek(0);
    a.play();
  } catch (e) {
    console.warn('[audio] 异常:', e);
  }
}

/**
 * 销毁音频实例（页面卸载时调用，避免占用资源）
 */
export function destroyAudio() {
  if (ctx) {
    try { ctx.destroy(); } catch (e) {}
    ctx = null;
  }
}

export default { getAudio, playNewOrder, destroyAudio };
