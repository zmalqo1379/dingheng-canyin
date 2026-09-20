/* =============================================================================
   横向滚动条常驻（商家端 / 供应商端 / 开发者端 通用）
   -----------------------------------------------------------------------------
   要解决的笨拙体验：
     一张宽表，横向滚动条长在【容器的最底部】。想看第一行右边超出屏幕的内容，
     得先竖直滚到容器最底下 → 横向拖到右边 → 再竖直滚回第一行，
     来回三趟。看一页内容像在做无用功。
   做法：
     给每个横向可滚动的容器配一条「影子滚动条」，固定在屏幕底部、左右与容器对齐、
     跟着容器进出视口（容器滚出屏幕就自动让位给下一个）。
     拖影子条 = 拖容器，两边 scrollLeft 实时同步 —— 不用滚到底也能左右拖。
   用法：页面底部引入 <script src="/js/sticky-scroll.js"></script>，无需其它调用。
   ============================================================================= */
(function () {
  var BAR_H = 14;
  var items = [];
  var raf = 0, timer = 0;

  var css = document.createElement('style');
  css.textContent =
    '.ss-xbar{position:fixed;bottom:0;height:' + BAR_H + 'px;overflow-x:auto;overflow-y:hidden;' +
    'z-index:9998;display:none;background:var(--card,#fff);border-top:1px solid var(--border,#e5e7eb);' +
    'box-shadow:0 -2px 8px rgba(0,0,0,.06);}' +
    '.ss-xbar>div{height:1px;}' +
    '.ss-xbar::-webkit-scrollbar{height:' + BAR_H + 'px;}' +
    '.ss-xbar::-webkit-scrollbar-thumb{background:rgba(107,114,128,.6);border-radius:8px;}' +
    '.ss-xbar::-webkit-scrollbar-thumb:hover{background:rgba(55,65,81,.85);}' +
    '.ss-xbar::-webkit-scrollbar-track{background:transparent;}';
  (document.head || document.documentElement).appendChild(css);

  function bind(el) {
    if (el.dataset.ssBound) return;
    el.dataset.ssBound = '1';
    var bar = document.createElement('div');
    bar.className = 'ss-xbar';
    var inner = document.createElement('div');
    bar.appendChild(inner);
    document.body.appendChild(bar);

    var syncing = false;
    function toBar() {
      if (syncing) return;
      syncing = true;
      bar.scrollLeft = el.scrollLeft;
      requestAnimationFrame(function () { syncing = false; });
    }
    function toEl() {
      if (syncing) return;
      syncing = true;
      el.scrollLeft = bar.scrollLeft;
      requestAnimationFrame(function () { syncing = false; });
    }
    el.addEventListener('scroll', toBar, { passive: true });
    bar.addEventListener('scroll', toEl, { passive: true });
    // 内容变了（换页 / 筛选）要重算影子条宽度
    items.push({ el: el, bar: bar, inner: inner });
  }

  // 自动发现：凡是 overflow-x 为 auto/scroll 且内容确实超宽的容器都接管，
  // 不用在每个页面逐个登记类名，也不怕以后新增表格忘了加
  function discover() {
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.dataset && el.dataset.ssBound) continue;
      if (el.classList && el.classList.contains('ss-xbar')) continue;
      var ox = getComputedStyle(el).overflowX;
      if (ox !== 'auto' && ox !== 'scroll') continue;
      if (el.scrollWidth - el.clientWidth < 8) continue;
      bind(el);
    }
  }

  // 只给「当前最占屏幕的那一个」容器显示影子条，避免一堆条叠在底部互相打架
  function update() {
    var best = null, bestH = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.el.isConnected) { it.bar.remove(); continue; }
      if (it.el.scrollWidth - it.el.clientWidth < 8) { it.bar.style.display = 'none'; continue; }
      var r = it.el.getBoundingClientRect();
      var top = Math.max(r.top, 0);
      var bottom = Math.min(r.bottom, window.innerHeight);
      var visH = bottom - top;
      if (visH <= 0 || r.width <= 0) { it.bar.style.display = 'none'; continue; }
      if (visH > bestH) { bestH = visH; best = it; }
    }
    for (var j = 0; j < items.length; j++) {
      if (items[j] !== best) items[j].bar.style.display = 'none';
    }
    if (!best) return;
    var rr = best.el.getBoundingClientRect();
    var left = Math.max(rr.left, 0);
    var w = Math.min(rr.right, window.innerWidth) - left;
    best.inner.style.width = best.el.scrollWidth + 'px';
    best.bar.style.left = left + 'px';
    best.bar.style.width = Math.max(w, 60) + 'px';
    best.bar.style.display = 'block';
    if (Math.abs(best.bar.scrollLeft - best.el.scrollLeft) > 1) best.bar.scrollLeft = best.el.scrollLeft;
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; update(); });
  }
  function rescan() { discover(); update(); }
  function debounceRescan() { clearTimeout(timer); timer = setTimeout(rescan, 250); }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', debounceRescan);
  // 表格大多是异步渲染出来的，DOM 一变就重新扫一遍
  if (window.MutationObserver) {
    new MutationObserver(debounceRescan).observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener('load', rescan);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rescan);
  rescan();
})();
