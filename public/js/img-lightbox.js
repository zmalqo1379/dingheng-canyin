/* ============================================================
   图片灯箱（三端通用：商家端 / 供应商端 / 开发者端）
   用法：页面底部引入 <script src="/js/img-lightbox.js"></script>，无需其它调用。

   为什么要有这一段：
     以前各端各写半套放大 —— 有的只能点空白处关闭、有的连关都关不掉，
     老板点开凭证图后退回不去，只能刷新页面重来。图是用来看清问题的，
     看完就该一秒钟退回去接着干活，不该把人困住。

   关闭方式（都是玩电脑的人下意识会试的，所以界面上不写提示、不加按钮，
   免得按钮压在图上挡视线）：
     Esc / 空格 / 回车 / 减号 / 退格 / 左键点任意处（含图片上）/ 右键
   同一组多张图（如一张工单的多张凭证）支持 ← → 翻页。
   ============================================================ */
(function () {
  if (window.__dhImgLightboxReady) return;   // 同一页面重复引入只生效一次
  window.__dhImgLightboxReady = true;

  var lb = null, imgEl = null, counterEl = null;
  var group = [], idx = 0, savedOverflow = '';

  var IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)(\?|#|$)/i;

  function isImageUrl(u) {
    return !!u && (IMG_EXT.test(u) || /^data:image\/(?!svg)/i.test(u));
  }

  // 图外面包了一层链接时，链接指向的才是原图（缩略图看不清细节，要用原图）
  function bigUrl(node) {
    var a = node.closest ? node.closest('a') : null;
    if (a && a.href && isImageUrl(a.href)) return a.href;
    return node.currentSrc || node.src || '';
  }

  // 什么样的图才值得放大：图标、按钮里的图、SVG 一律不拦。
  // 注意：凭证图常常是 <a href="原图" target="_blank"><img 缩略图></a>，
  // 以前把「链接里的图」一律排除，结果点下去是新开一个网页，看完关不掉 ——
  // 这里改成：链接指向的确实是图片，就接管它，原地放大（不再新开网页）。
  function isCandidate(node) {
    if (!node || node.tagName !== 'IMG') return false;
    if (node.hasAttribute('data-no-lightbox')) return false;
    if (node.closest('[data-no-lightbox], .no-lightbox, button, label, input, select, textarea')) return false;
    var a = node.closest('a');
    // 链接不是图片（跳别的页面）就不拦，别把人家的正常跳转弄坏
    if (a && a.href && !isImageUrl(a.href)) return false;
    var src = node.currentSrc || node.src || '';
    if (!src || src === 'about:blank') return false;
    // 图标 / 占位 SVG 不是照片，放大没有意义
    if (/^data:image\/svg/i.test(src) || /\.svg(\?|#|$)/i.test(src)) return false;
    var r = node.getBoundingClientRect();
    return r.width >= 40 && r.height >= 40;
  }

  function ensure() {
    if (lb) return lb;
    lb = document.createElement('div');
    lb.id = 'dhImgLightbox';
    lb.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;'
      + 'justify-content:center;padding:28px;background:rgba(0,0,0,.86);cursor:zoom-out;';
    imgEl = document.createElement('img');
    imgEl.style.cssText = 'max-width:100%;max-height:100%;border-radius:10px;'
      + 'box-shadow:0 16px 48px rgba(0,0,0,.55);background:#fff;';
    // 多图时右下角显示 1/3 这样的序号（不挡图、不写操作说明）
    counterEl = document.createElement('div');
    counterEl.style.cssText = 'position:absolute;right:18px;bottom:16px;font-size:13px;'
      + 'color:rgba(255,255,255,.82);letter-spacing:1px;user-select:none;';
    lb.appendChild(imgEl);
    lb.appendChild(counterEl);
    lb.addEventListener('click', function (e) {
      // Ctrl / ⌘ + 点 = 在新标签页打开原图。电脑上「新标签打开」本来就是这个手势，
      // 不用写在界面上；真想拿原图的人一试就中，不想用的人也不受影响。
      // 手机上不需要这个动作：长按图片用系统菜单保存 / 打开照样能用。
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (group[idx]) window.open(group[idx], '_blank', 'noopener');
        return;
      }
      close();
    });
    lb.addEventListener('contextmenu', function (e) { e.preventDefault(); close(); });
    document.body.appendChild(lb);
    return lb;
  }

  function isOpen() { return !!lb && lb.style.display === 'flex'; }

  function render() {
    ensure();
    if (!group.length) return;
    imgEl.src = group[idx];
    counterEl.textContent = group.length > 1 ? (idx + 1) + ' / ' + group.length : '';
    counterEl.style.display = group.length > 1 ? '' : 'none';
    if (!isOpen()) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';   // 放大时锁住背景滚动，退出方向不会乱
    }
    lb.style.display = 'flex';
  }

  function close() {
    if (!isOpen()) return;
    lb.style.display = 'none';
    imgEl.removeAttribute('src');
    document.body.style.overflow = savedOverflow;
  }

  function step(d) {
    if (!isOpen() || group.length < 2) return;
    idx = (idx + d + group.length) % group.length;
    render();
  }

  // 点图放大：整页委托，后渲染出来的图（工单凭证、资质照、送达照…）自动生效。
  // 用捕获阶段：凭证图常嵌在「点整张卡片看详情」的卡片里，
  // 必须在卡片自己的 onclick 之前截住，否则点图会同时弹出详情弹窗。
  document.addEventListener('click', function (e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (lb && lb.contains(e.target)) return;     // 灯箱内部的点击由灯箱自己处理（点哪都关）
    var img = e.target;
    if (!isCandidate(img)) return;
    // 已经自己绑定了放大行为的图（旧的内联灯箱）交给它自己，避免开两层
    if (img.onclick || img.hasAttribute('data-lightbox-bound')) return;
    e.preventDefault();
    e.stopPropagation();
    // 同组：同一容器内的兄弟图 —— 一张工单的多张凭证可以左右翻着看
    var parent = img.parentElement;
    var src = bigUrl(img);
    var siblings = parent
      ? Array.prototype.slice.call(parent.querySelectorAll('img')).filter(isCandidate)
      : [];
    group = siblings.length ? siblings.map(bigUrl) : [src];
    idx = Math.max(0, group.indexOf(src));
    render();
  }, true);

  // 键盘：Esc / 空格 / 回车 / 减号 / 退格 关闭；← → 翻页。
  // 用捕获阶段 + stopPropagation：灯箱开着时只关灯箱，
  // 不会顺手把下面那层弹窗（工单详情等）一起关掉 —— 退一步，不是全退。
  window.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    var k = e.key;
    if (k === 'Escape' || k === ' ' || k === 'Spacebar' || k === 'Enter' || k === '-' || k === 'Backspace') {
      e.preventDefault(); e.stopPropagation(); close();
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation(); step(k === 'ArrowRight' ? 1 : -1);
    }
  }, true);

  // 对外入口：各端已有的放大调用统一走这里，保证关闭方式一致
  window.openImageLightbox = function (url) {
    if (!url) return;
    group = [url]; idx = 0; render();
  };
  window.closeImageLightbox = close;
})();
