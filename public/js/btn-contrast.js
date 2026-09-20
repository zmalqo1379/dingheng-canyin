/* ============================================================
   按钮字色自动对比度（三端通用：商家端 / 供应商端 / 开发者端）
   用法：页面底部引入 <script src="/js/btn-contrast.js"></script>，无需其它调用。

   为什么要有这一段：
     按钮的字色以前是「人按主题猜」的 —— 暖橙配白字、深色配深棕字。
     可同一套主题里，按钮背景可能是渐变、可能是主色、也可能被主题刷成中性灰，
     任何一种配错，按钮就整颗隐形（用户原话：一个浅得看不见，一个深得看不见）。
     猜一次错一次，改了三轮还是翻车 —— 因为「猜」这个动作本身就是错的。

   这里的做法：不再猜。读按钮真正渲染出来的背景（渐变取最亮的一段，
   按最坏情况判定），算出白字压上去的对比度，够用就用白字，不够就换成
   同色相压暗的文字 —— 怎么换主题、换背景都不会再看不清。

   安全边界（绝不把已经合格的地方改坏）：
     - 白字对比度 ≥ 2.5:1 一律保持白字。经典版主色 #FF6B35 算出来是 2.83，
       正好在保留区 —— 经典版外观一个像素都不动。
     - 描边类按钮（白底深字）算出来就是深色字，与现状一致，不会改坏。
     - 透明背景的按钮不碰，交回样式表自己管。
   ============================================================ */
(function () {
  if (window.__dhBtnContrastReady) return;   // 同一页面重复引入只生效一次
  window.__dhBtnContrastReady = true;

  // 低于这个对比度，白字就开始发虚、等于隐形（用户看到的就是「看不见」）。
  // 定在 2.5 是为了让经典版（2.83）稳稳留在白字区 —— 它一直这样，没有投诉，不动它。
  const WHITE_MIN = 2.5;

  const SEL = '.btn, .btn-primary, .btn-add, .btn-orange, .btn-blue, .btn-green, '
    + '.btn-red, .btn-gray, .btn-ghost, button.btn, .home-todo-item .btn';

  // ---------- 颜色工具 ----------
  function parseRgb(s) {
    const m = /rgba?\(([^)]+)\)/i.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map(function (x) { return parseFloat(x); });
    if (p.length < 3 || [p[0], p[1], p[2]].some(isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  // WCAG 相对亮度
  function relLum(r, g, b) {
    const f = function (c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function contrast(a, b) {
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hslToRgb(h, s, l) {
    if (!s) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = function (t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [
      Math.round(hue(h + 1 / 3) * 255),
      Math.round(hue(h) * 255),
      Math.round(hue(h - 1 / 3) * 255)
    ];
  }

  const toCss = function (rgb) { return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')'; };

  // ---------- 取按钮真实背景 ----------
  // 渐变没有 backgroundColor，得从 background-image 里取所有色标：
  // 按「最亮的一段」判定 —— 白字在最亮处最看不清，取最坏情况才不会有的地方看得见有的地方糊。
  function bgOf(el) {
    const cs = getComputedStyle(el);
    const solid = parseRgb(cs.backgroundColor);
    if (solid && solid.a > 0.5) return solid;
    const bi = cs.backgroundImage || '';
    if (bi.indexOf('gradient') >= 0) {
      const stops = (bi.match(/rgba?\([^)]+\)/gi) || [])
        .map(parseRgb)
        .filter(function (c) { return c && c.a > 0.5; });
      if (stops.length) {
        return stops.reduce(function (a, b) {
          return relLum(b.r, b.g, b.b) > relLum(a.r, a.g, a.b) ? b : a;
        });
      }
    }
    return null;   // 透明背景：不处理，交回样式表
  }

  // 按背景挑字色：白字够清楚就用白字；否则用同色相压暗的字（不像纯黑那么死板，对比度也够）
  function pickFg(bg) {
    const bgL = relLum(bg.r, bg.g, bg.b);
    if (contrast(1, bgL) >= WHITE_MIN) return '#ffffff';
    const hsl = rgbToHsl(bg.r, bg.g, bg.b);
    const s = Math.min(1, hsl[1] * 1.05);
    let l = 0.16;
    let rgb = hslToRgb(hsl[0], s, l);
    // 兜底：万一压到 0.16 还差一点（极端浅色），继续压暗直到 ≥ 4.5:1
    while (contrast(relLum(rgb[0], rgb[1], rgb[2]), bgL) < 4.5 && l > 0.05) {
      l -= 0.02;
      rgb = hslToRgb(hsl[0], s, l);
    }
    return toCss(rgb);
  }

  let lastCount = -1;
  function fix() {
    const els = document.querySelectorAll(SEL);
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const bg = bgOf(el);
      if (!bg) continue;
      const want = pickFg(bg);
      // 只在值真的变了才写 inline —— 避免无谓重绘，也不覆盖等价的样式表写法
      if (el.style.color !== want) el.style.color = want;
    }
    lastCount = els.length;
  }

  // 主题切换 / 列表重新渲染后都要重算：刚插入的按钮还没算过
  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; fix(); }, 150);
  }

  function boot() {
    fix();
    new MutationObserver(schedule).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme']
    });
    if (document.body) {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__dhBtnContrastFix = fix;   // 需要时可手动触发（如切页签后）
})();
