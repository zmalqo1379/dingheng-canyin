/* ============================================================
   侧栏图标统一（三端通用：商家端 / 供应商端 / 开发者端）
   用法：页面底部引入 <script src="/js/nav-icons.js"></script>，无需其它调用。

   为什么要有这一段：
   项目硬约束「禁止 emoji 图标」（admin / supplier 里几处已内联 SVG 就是这个原因），
   但侧栏绝大多数项还在用 emoji —— 颜色五花八门、笔画粗细不统一，
   是界面「显便宜」的最大单一来源。
   这里把 emoji 换成统一笔画的线性图标（24 格 / 1.7 描边 / 圆端点），
   并用 currentColor 描边：主题一换，图标跟着变色（暖橙橙线、深色浅线、青绿青线）。

   匹配规则（按顺序）：
   1. 已经内联 <svg> 的项 —— 不动（尊重已有矢量图标）
   2. 按 data-tab / data-tool / id 的语义名取图标 —— 稳定，不受 emoji 编码差异影响
   3. 取不到就保留原 emoji —— 安全降级，绝不把菜单搞坏
   ============================================================ */
(function () {
  'use strict';

  // —— 图标笔画（viewBox 0 0 24 24） ——
  var P = {
    home: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9.5 21v-7h5v7"/>',
    cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a1.7 1.7 0 0 0 1.6 1.3h9.3a1.7 1.7 0 0 0 1.6-1.3L22 7H6"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 2v3M14.5 2v3M9.5 19v3M14.5 19v3M2 9.5h3M2 14.5h3M19 9.5h3M19 14.5h3"/>',
    'clipboard-file': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    'bar-chart': '<path d="M5 21V12M12 21V4M19 21v-6"/><path d="M2.5 21h19"/>',
    activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
    'dashboard-grid': '<rect x="3" y="3" width="7.5" height="9" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="5" rx="1.5"/><rect x="13.5" y="11" width="7.5" height="10" rx="1.5"/><rect x="3" y="15" width="7.5" height="6" rx="1.5"/>',
    package: '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    crown: '<path d="M3 18h18v3H3z"/><path d="M4 18 3 10l5 3 4-7 4 7 5-3-1 8"/>',
    coins: '<circle cx="9.5" cy="9.5" r="5.6"/><circle cx="14.5" cy="14.5" r="5.6"/>',
    star: '<path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 17.8 6.2 20.8l1.1-6.4L2.6 9.8l6.5-.9z"/>',
    wallet: '<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6"/>',
    utensils: '<path d="M6 2v7a2 2 0 0 0 4 0V2"/><path d="M8 9v13"/><path d="M16 2c-1.7 0-3 1.6-3 3.6s1.3 3.6 3 3.6 3-1.6 3-3.6S17.7 2 16 2z"/><path d="M16 9.2V22"/>',
    'chef-hat': '<path d="M5 13a4 4 0 1 1 1.6-7.7 4.5 4.5 0 0 1 8.4-1.3A4.5 4.5 0 0 1 19 13v4H5z"/><path d="M5 17h14v4H5z"/>',
    monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    scale: '<path d="M12 3v18"/><path d="M3 8h18"/><path d="M7 8 4 15a3 3 0 0 0 6 0z"/><path d="M17 8l-3 7a3 3 0 0 0 6 0z"/><path d="M8 21h8"/>',
    'id-card': '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><circle cx="8.5" cy="11" r="2.5"/><path d="M14 9.5h5M14 14h5M5.5 17.5c1-1.3 2-2 3-2s2 .7 3 2"/>',
    truck: '<path d="M2 5h12v11H2z"/><path d="M14 9h4l3 3v4h-7z"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="18.5" r="2"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    receipt: '<path d="M5 3h14v18l-2.3-1.4L14.4 21l-2.4-1.4L9.6 21 7.3 19.6 5 21z"/><path d="M9 8h6M9 12h6"/>',
    landmark: '<path d="M12 3l9 5H3z"/><path d="M3 21h18"/><path d="M6 10v11M10 10v11M14 10v11M18 10v11"/>',
    store: '<path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M3 4l1.5 5M21 4l-1.5 5"/><path d="M9 13h6"/>',
    tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
    'credit-card': '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>'
  };

  // —— 按菜单语义名取图标（data-tab / data-tool / id） ——
  var BY_KEY = {
    /* 商家端 */
    home: 'home', brain: 'cpu', mall: 'cart', smartReplenish: 'cpu', purchase: 'clipboard-file',
    procurement: 'activity', aftersale: 'receipt', dishes: 'list', tables: 'grid', orders: 'package',
    stats: 'bar-chart', decorate: 'edit', settings: 'settings', member: 'crown', coin: 'coins',
    points: 'star', storedvalue: 'wallet', marketing: 'target',
    /* 商家端底部运营工具（data-tool） */
    customer: 'utensils', kitchen: 'chef-hat', bigscreen: 'monitor',
    /* 供应商端 */
    service: 'receipt', price: 'activity', sort: 'scale', products: 'list', qualify: 'id-card',
    deliver: 'truck', notify: 'bell', split: 'receipt', onboarding: 'landmark',
    navLogoutBtn: 'log-out', navService: 'receipt', navOrders: 'package',
    /* 开发者端 */
    overview: 'dashboard-grid', merchants: 'store', suppliers: 'truck', pricing: 'tag',
    revenue: 'activity', coinrules: 'coins', membership: 'credit-card', notifylog: 'inbox',
    pricecheck: 'scale', tickets: 'shield', system: 'settings'
  };

  var SIZE = 16;

  function svgOf(name) {
    var body = P[name];
    if (!body) return '';
    return '<svg viewBox="0 0 24 24" width="' + SIZE + '" height="' + SIZE + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
      'style="vertical-align:-3px;display:inline-block">' + body + '</svg>';
  }

  function applyIcons(root) {
    var scope = root || document;
    var items = scope.querySelectorAll('.nav-item, .nav-tool, .nav-logout');
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var icon = el.querySelector('.icon');
      if (!icon) continue;
      if (icon.querySelector('svg')) continue;              // 已是矢量图标，尊重它
      if (icon.getAttribute('data-icon-done')) continue;
      var name = BY_KEY[el.getAttribute('data-tab')] ||
        BY_KEY[el.getAttribute('data-tool')] ||
        BY_KEY[el.id];
      if (!name) continue;                                   // 不在表里：保留原 emoji（安全降级）
      var html = svgOf(name);
      if (!html) continue;
      icon.innerHTML = html;
      icon.setAttribute('data-icon-done', '1');
    }
  }

  /* —— 空状态 / 加载态：把「暂无数据」「加载中…」这类裸文本套上统一排版 ——
     安全约束：只加 class，不改文字内容，不动任何业务数据。 */
  var EMPTY_RE = /^\s*(暂无|暂无数据|暂无记录|暂无内容|没有数据|没有记录|空空如也|加载中|加载中\.\.\.|数据加载中\.\.\.)\s*$/;

  function applyEmptyText(root) {
    var nodes = (root || document.body).querySelectorAll('div,td,p,li,span');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.children.length) continue;                      // 有子元素的容器不处理
      var txt = (el.textContent || '').trim();
      if (!txt || txt.length > 12) continue;
      if (!EMPTY_RE.test(txt)) continue;
      if (el.classList.contains('dh-empty-text')) continue;
      el.classList.add('dh-empty-text');
      if (/加载中/.test(txt)) el.classList.add('dh-loading-text');
    }
  }

  function run() {
    try { applyIcons(document); applyEmptyText(document.body); } catch (e) { /* 图标失败不影响业务 */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();

  // 面板切换等后续动态插入的菜单也能吃到（只加 retval 保护，避免递归）
  if (window.MutationObserver) {
    var t = null;
    new MutationObserver(function () {
      if (t) clearTimeout(t);
      t = setTimeout(run, 120);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.DHIcons = { apply: applyIcons, icons: P };
})();
