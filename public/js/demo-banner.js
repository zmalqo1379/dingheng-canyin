/**
 * 演示模式横幅（共享脚本，商家/供应商/开发者各端复用）
 *
 * 逻辑：GET /api/pay-mode（公开接口）→ payMode='mock' 时在页面顶部固定橙色横幅：
 *   「当前为演示模式，所有交易均为模拟数据，不会真实扣款/打款」
 * 切到真实支付（payMode='wechat'，开发者后台操作）后横幅自动消失，无需改前端代码。
 *
 * 用法：在页面 </body> 前引入 <script src="/js/demo-banner.js"></script>
 */
(function () {
  function showBanner() {
    if (document.getElementById('dh-demo-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'dh-demo-banner';
    banner.textContent = '当前为演示模式，所有交易均为模拟数据，不会真实扣款/打款';
    banner.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:99999',
      /* 深藏青玻璃底 + 淡金字：演示提示要「看得到」而不是「晃眼睛」。
         亮橙 + 白字大面积压顶最刺眼，深底浅字才是润眼的做法（科技风也靠这个） */
      'background:linear-gradient(90deg, rgba(11,32,26,.97), rgba(23,59,47,.97))',
      'color:#F5DFA8',
      'border-bottom:1px solid rgba(212,162,76,.35)',
      'text-align:center',
      'font-size:13px',
      'font-weight:500',
      'line-height:1.5',
      'padding:8px 12px',
      'box-shadow:0 1px 6px rgba(0,0,0,.18)',
      'letter-spacing:.5px'
    ].join(';');
    document.body.appendChild(banner);
    // 打标记：横幅是 fixed + z-index 99999，光靠 body 垫片管不到 position:fixed 的
    // 侧栏 / 顶栏 / 悬浮按钮，需要 CSS 按 [data-demo-banner] 统一让它们避让。
    document.documentElement.setAttribute('data-demo-banner', '1');
    // 给页面顶部留出空间，避免横幅遮挡原有头部内容（只在页面没有自行适配时加垫片）
    if (!document.getElementById('dh-demo-pad')) {
      var pad = document.createElement('div');
      pad.id = 'dh-demo-pad';
      pad.style.height = '36px';
      if (document.body.firstChild) {
        document.body.insertBefore(pad, document.body.firstChild);
      } else {
        document.body.appendChild(pad);
      }
    }
  }

  function check() {
    try {
      fetch('/api/pay-mode').then(function (r) { return r.json(); }).then(function (res) {
        if (res && res.success && res.data && res.data.demo) showBanner();
      }).catch(function () { /* 接口不可用时不显示，绝不阻断页面 */ });
    } catch (e) { /* 忽略 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
})();
