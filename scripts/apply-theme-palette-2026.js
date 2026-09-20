/* ============================================================================
   一次性改造工具：四套主题「配色质感升级 + 润眼」v3（2026-09-19）
   ----------------------------------------------------------------------------
   ★★ v1 被老板验收打回，教训记死在文件头 ★★
     v1 为了「跟经典版区分」把颜色一味压深压暗：
       暖橙 #C8461F（他说像红色）/ 青绿 #008276（他说像灰色）/ 深色 #0C1218（乌漆嘛黑）
     ★ 根因：老板【色弱】。低明度低饱和的「高级色」在他眼里分辨不出色相，只剩一团灰。
     ★ 规矩一：**区分靠【色相 + 饱和度】，绝不靠压明度**。白字对比不够时，
       宁可让按钮用深色字，也不许把主色压暗。

   ★★ v2 验收通过，v3 追加「养眼润眼」（老板：看久了不得劲，睫状体要舒服）★★
     这是视觉工效学问题，不是配色审美问题。视疲劳四个来源，逐条下药：
       1) 大面积高亮 —— 纯白卡片 / 纯白底最伤眼 → 卡片改【近白】，页面底降一档
       2) 正文「过曝」—— 纯黑压纯白 16:1 像开了闪光灯 → 正文降到 10:1 左右的舒适区
       3) 深色炫光 halation —— 近白文字在深底上会发散光晕 → 深色正文降到 ~9.8:1
       4) 次要文字太淡（卡在 4.5:1）—— 眼睛要反复调节，睫状肌最累 → 提到 5.3~6.3:1
     另：边框 / 阴影柔化（减少硬边），页面底加一道极淡渐变做「空气感」。
     classic 经典版一个像素不动。

   硬约束（不许破）：
     · 按钮白字对比度 ≥ 3.0（项目管理规矩第 6 条）
     · 正文对比度 ≥ 4.5（且不要过曝到 15:1 以上）
     · 换肤不串色：主色透明度梯度 --p-* 必须全部跟随本主题 --primary
       （★ v1 踩坑：--p-05/06/08/09 带前导零，写成 --p-5 会静默命中不到）

   实现方式：**按键改值**（不重写块）→ 变量永不丢失；缺键会报告、不静默。
   用法：node scripts/apply-theme-palette-2026.js
   回退：从 *.bak-20260919e 覆盖后重跑（脚本幂等）
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- 三套主题参数（改色只动这里） ---------- */
// p 主色 / p2 点亮色 / rgb 透明度梯度 / card 卡片近白 / text 正文 / sub 次要字 / border 柔边框
const WARM = {
  p: '#D8741A', p2: '#FFA24D', rgb: '216, 116, 26',
  card: '#FFFDFB', text: '#453D33', sub: '#6A6259', border: '#EFE8E0'
};
const FRESH = {
  p: '#00A078', p2: '#00C9A7', rgb: '0, 160, 120',
  card: '#FCFEFD', text: '#37453F', sub: '#5E6D66', border: '#E2EDE8'
};
const DARK = {
  p: '#FFA873', p2: '#FFC294', rgb: '255, 168, 115',
  card: '#1B2634', text: '#C6CDD6', sub: '#9BA5B4', border: '#33465A'
};

/* ---------- 工具 ---------- */
function blockRange(src, marker) {
  const s = src.indexOf(marker);
  if (s < 0) throw new Error('找不到块: ' + marker);
  const m = src.slice(s).match(/\n[ \t]*\}/);
  if (!m) throw new Error('找不到块结束: ' + marker);
  return [s, s + m.index];
}

function applyVars(src, marker, updates) {
  const [s, e] = blockRange(src, marker);
  let body = src.slice(s, e);
  const miss = [];
  for (const k of Object.keys(updates)) {
    // 精确匹配 "键名: 值;" —— 键名结尾带冒号，不会误伤 --p-0 / --p-05 这类前缀相同的键
    const re = new RegExp('(' + k + ':\\s*)([^;]+)(;)', 'g');
    if (!body.match(re)) { miss.push(k); continue; }
    body = body.replace(re, '$1' + updates[k] + '$3');
  }
  if (miss.length) console.log('  · 跳过（本块无此键）: ' + miss.join(', '));
  return src.slice(0, s) + body + src.slice(e);
}

/* 精确字符串替换（端级写死规则）；原文不存在就报错，绝不静默 */
function mustReplace(src, from, to, tag) {
  if (src.indexOf(from) < 0) throw new Error('替换失败[' + tag + ']，原文不存在:\n' + from);
  return src.split(from).join(to);
}

/* 全局收尾：把散落在规则里的旧主色 rgba 一并换掉（这些不走变量）*/
function sweep(src, from, to) { return src.split(from).join(to); }

/* 主色透明度梯度。★ 键名必须与文件逐字一致：是 --p-05 不是 --p-5 */
function pSeries(rgb) {
  const o = {};
  [['0', '0'], ['05', '.05'], ['06', '.06'], ['08', '.08'], ['09', '.09'], ['1', '.1'],
   ['10', '.1'], ['12', '.12'], ['14', '.14'], ['15', '.15'], ['16', '.16'], ['18', '.18'],
   ['2', '.2'], ['20', '.20'], ['25', '.25'], ['28', '.28'], ['3', '.3'], ['30', '.30'],
   ['35', '.35'], ['4', '.4'], ['40', '.40'], ['45', '.45'], ['50', '.50'], ['55', '.55']
  ].forEach(function (pair) { o['--p-' + pair[0]] = 'rgba(' + rgb + ', ' + pair[1] + ')'; });
  return o;
}

/* ---------- 对比度校验 ---------- */
function lum(hex) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map(function (i) {
    const v = parseInt(h.substr(i, 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
}

/* ==========================================================================
   一、public/theme.css
   ========================================================================== */
const cssPath = path.join(ROOT, 'public/theme.css');
let css = fs.readFileSync(cssPath, 'utf8');
const cssBefore = css.length;

/* ---- warm 暖橙：琥珀橙 + 暖米白 + 深墨蓝侧栏（v3 追加润眼）---- */
css = applyVars(css, '[data-theme="warm"] {', Object.assign({
  '--bg': '#F8F4EF',
  '--card': WARM.card,            // 润眼①：纯白 → 近白，大面积高亮是视疲劳首因
  '--primary': WARM.p,
  '--primary-2': WARM.p2,
  '--text': WARM.text,            // 润眼②：正文从 16.5:1「过曝」降到舒适区
  '--text-2': '#4E463C',
  '--text-3': '#5C5349',
  '--text-slate': '#5C5349',
  '--text-sub': WARM.sub,         // 润眼④：次要字提到 5.8:1，眼睛不用反复调节
  '--text-muted': '#948C84',
  '--text-faint': '#B3ACA5',
  '--text-slate-400': '#8E877F',
  '--text-pale': '#C4BDB6',
  '--border': WARM.border,        // 润眼⑤：边框柔化，少一点硬边
  '--border-strong': '#DBD3CA',
  '--surface-2': '#FCFAF7',
  '--surface-3': '#F4EFE9',
  '--surface-4': '#FDFCFB',
  '--tint-red-100': '#FBDFD8', '--tint-red-200': '#F6C3B9', '--tint-red-50': '#FDF1EE',
  '--tint-green-100': '#DFF2E4', '--tint-green-50': '#F1FAF3',
  '--tint-amber-100': '#FBEBCB', '--tint-amber-200': '#F7D89B', '--tint-amber-50': '#FEF8E9',
  '--tint-blue-100': '#E2EBFA', '--tint-blue-200': '#C9DAF8', '--tint-blue-50': '#F2F6FD',
  '--tint-sky-50': '#F0F8FD', '--tint-sky-200': '#C2E2F7',
  '--tint-purple-100': '#EDE9FB',
  '--tint-orange-100': '#FBE0CE', '--tint-orange-50': '#FDF2EA', '--tint-orange-25': '#FDF5EF',
  '--tint-warm-50': '#FDF3EC', '--tint-warm-hover': '#FEF9F4',
  '--tint-row': '#FAF7F3', '--tint-divider': '#F1EAE3', '--tint-head-hover': '#F3EDE6',
  '--tint-page-alt': '#F3F7FC',
  '--shadow-sm': '0 1px 3px rgba(58, 40, 26, .045)',
  '--shadow': '0 4px 16px rgba(58, 40, 26, .065)',
  '--shadow-lg': '0 14px 36px rgba(58, 40, 26, .12)',
  '--card-shadow': '0 2px 14px rgba(58, 40, 26, .05)',   // 柔影：模糊更大、更淡
  '--row-unpriced': 'rgba(255, 162, 77, .12)',
  '--field-bg': '#F3EEE8',
  '--field-focus-shadow': '0 0 0 3px rgba(' + WARM.rgb + ', .16)',
  '--primary-ring': 'rgba(' + WARM.rgb + ', .14)',
  '--sidebar-bg': '#1B2A41',
  '--sidebar-color': '#C6CEDA',
  '--sidebar-active-bg': 'rgba(' + WARM.rgb + ', .26)',
  '--sidebar-active-color': '#FFC9A8',
  '--sidebar-tip-color': '#7C8898'
}, pSeries(WARM.rgb)));

/* ---- dark 深色：深蓝黑 + 卡片顶部高光（v3 追加去炫光）---- */
css = applyVars(css, '[data-theme="dark"] {', Object.assign({
  '--bg': '#0E1620',
  '--card': DARK.card,
  '--primary': DARK.p,
  '--primary-2': DARK.p2,
  '--text': DARK.text,            // 润眼③：深色正文从 12.6:1 降到 9.8:1，去掉光晕炫光
  '--text-2': '#BCC4CE',
  '--text-3': '#A6AFBA',
  '--text-sub': DARK.sub,         // 深色次要字提到 6.3:1
  '--text-muted': '#8A94A3',
  '--border': DARK.border,
  '--surface-2': '#263648',
  '--surface-3': '#33465A',
  '--surface-4': '#222E3D',
  '--tint-orange-25': 'rgba(' + DARK.rgb + ', .14)',
  '--tint-warm-50': 'rgba(' + DARK.rgb + ', .10)',
  '--tint-warm-hover': 'rgba(' + DARK.rgb + ', .16)',
  '--field-bg': '#263648',
  '--field-border': '1px solid #33465A',
  '--field-focus-shadow': '0 0 0 3px rgba(' + DARK.rgb + ', .20)',
  '--primary-ring': 'rgba(' + DARK.rgb + ', .14)',
  '--sidebar-bg': '#151E2B',
  '--shadow': '0 8px 24px rgba(0, 0, 0, .50)',
  '--shadow-lg': '0 20px 48px rgba(0, 0, 0, .60)'
}, pSeries(DARK.rgb)));
// 「黑亮」的关键：卡片顶边 1px 高光（玻璃质感），深色模式靠这个才有科技感
css = mustReplace(css,
  '--shadow-lg: 0 20px 48px rgba(0, 0, 0, .60);',
  '--shadow-lg: 0 20px 48px rgba(0, 0, 0, .60);\n      --card-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 4px 16px rgba(0, 0, 0, .35);',
  'dark 卡片高光');

/* ---- fresh 青绿：鲜活青绿（v3 追加润眼）---- */
css = applyVars(css, '[data-theme="fresh"] {', Object.assign({
  '--bg': '#F4FAF8',
  '--card': FRESH.card,           // 润眼①：纯白 → 微青近白
  '--primary': FRESH.p,
  '--primary-2': FRESH.p2,
  '--teal': '#00BF9C',
  '--text': FRESH.text,           // 润眼②：从 16.1:1 降到 9.8:1
  '--text-2': '#3D4B45',
  '--text-3': '#55635C',
  '--text-slate': '#55635C',
  '--text-sub': FRESH.sub,        // 润眼④：次要字 4.5 → 5.4:1
  '--text-muted': '#8B9993',
  '--text-faint': '#A9B5B0',
  '--text-slate-400': '#869490',
  '--text-pale': '#B7C2BD',
  '--border': FRESH.border,
  '--border-strong': '#D0DFD9',
  '--surface-2': '#F8FCFB',
  '--surface-3': '#E8F3F0',
  '--surface-4': '#F7FBFA',
  '--tint-red-100': '#FBE4E0', '--tint-red-200': '#F7C9C3', '--tint-red-50': '#FDF3F1',
  '--tint-green-100': '#D2F2EA', '--tint-green-50': '#EDFAF6',
  '--tint-amber-100': '#FAF1D5', '--tint-amber-200': '#F5E1A2', '--tint-amber-50': '#FEFAEC',
  '--tint-blue-100': '#E1EDFA', '--tint-blue-200': '#C7DBF8', '--tint-blue-50': '#F1F7FD',
  '--tint-sky-50': '#EEF8FD', '--tint-sky-200': '#C0E3F6',
  '--tint-purple-100': '#E9EBFB',
  '--tint-orange-100': '#FFE8DA', '--tint-orange-50': '#FFF6F0', '--tint-orange-25': '#FFF8F4',
  '--tint-warm-50': '#FFF7F3', '--tint-warm-hover': '#FFFBFA',
  '--tint-row': '#F7FBFA', '--tint-divider': '#EDF4F2', '--tint-head-hover': '#E9F3F1',
  '--tint-page-alt': '#EFF7FB',
  '--shadow-sm': '0 1px 3px rgba(0, 60, 55, .045)',
  '--shadow': '0 4px 16px rgba(0, 60, 55, .065)',
  '--shadow-lg': '0 14px 36px rgba(0, 60, 55, .11)',
  '--card-shadow': '0 1px 2px rgba(0, 60, 55, .04)',
  '--card-border': '1px solid #E6F0EC',
  '--field-border': '1px solid #D9ECE7',
  '--field-focus-shadow': '0 0 0 3px rgba(' + FRESH.rgb + ', .14)',
  '--primary-ring': 'rgba(' + FRESH.rgb + ', .14)',
  '--sidebar-color': '#3D4D48',
  '--sidebar-hover-color': FRESH.p,
  '--sidebar-active-bg': 'var(--primary)',
  '--sidebar-active-color': '#FFFFFF',
  '--btn-primary-bg': 'var(--primary)'
}, pSeries(FRESH.rgb)));

/* ---- fresh 补充块 ---- */
css = applyVars(css, '      --surface-5: #F2F9F7;', {
  '--c-orange': '#F0743A',
  '--c-orange-deep': '#D05F22',
  '--c-orange-dark': '#7E4527'
});

/* ---- 端级写死规则 ---- */
css = mustReplace(css,
  '      background: linear-gradient(180deg, #242C3A, #1A212C);\n      box-shadow: inset 1px 0 0 rgba(255, 255, 255, .04);\n    }\n    [data-page="dev"][data-theme="warm"] .nav-item { border-radius: 10px; padding: 13px 16px; }',
  '      background: #1B2A41;\n      box-shadow: inset 1px 0 0 rgba(255, 255, 255, .05);\n    }\n    [data-page="dev"][data-theme="warm"] .nav-item { border-radius: 10px; padding: 13px 16px; }',
  'dev warm 侧栏');
css = mustReplace(css,
  '      background: rgba(255, 122, 61, .16);\n      color: #FFD3BA; font-weight: 700;',
  '      background: rgba(' + WARM.rgb + ', .22);\n      color: #FFC9A8; font-weight: 700;',
  'dev warm 选中态');
css = mustReplace(css,
  '[data-page="dev"][data-theme="warm"] .btn-primary:hover { box-shadow: 0 6px 16px rgba(255, 122, 61, .28); }',
  '[data-page="dev"][data-theme="warm"] .btn-primary:hover { box-shadow: 0 6px 16px rgba(' + WARM.rgb + ', .34); }',
  'dev warm 按钮光晕');
css = mustReplace(css,
  '      background: linear-gradient(180deg, #242C3A, #1A212C);\n      box-shadow: inset 1px 0 0 rgba(255, 255, 255, .04);',
  '      background: #1B2A41;\n      box-shadow: inset 1px 0 0 rgba(255, 255, 255, .05);',
  'admin warm 侧栏');
css = mustReplace(css,
  '      background: rgba(255, 122, 61, .16); color: #FFD3BA; border-left-color: var(--primary);',
  '      background: rgba(' + WARM.rgb + ', .22); color: #FFC9A8; border-left-color: var(--primary);',
  'admin warm 选中态');
css = mustReplace(css,
  '[data-page="dev"][data-theme="dark"] .topbar,\n    [data-page="dev"][data-theme="dark"] .sidebar {\n      background: #131A22;',
  '[data-page="dev"][data-theme="dark"] .topbar,\n    [data-page="dev"][data-theme="dark"] .sidebar {\n      background: #151E2B;',
  'dev dark 侧栏');
css = mustReplace(css,
  '[data-theme="dark"] .admin .sidebar { background: #131A22; box-shadow: inset -1px 0 0 #232D38; }',
  '[data-theme="dark"] .admin .sidebar { background: #151E2B; box-shadow: inset -1px 0 0 #253345; }',
  'admin dark 侧栏');
css = mustReplace(css,
  '      background: var(--tint-green-100); color: #00B8A9; border-left-color: transparent;',
  '      background: var(--primary); color: #FFFFFF; border-left-color: transparent;\n      box-shadow: 0 4px 12px rgba(' + FRESH.rgb + ', .28);',
  'admin fresh 选中态');
css = mustReplace(css,
  '      background: var(--tint-green-100); color: #00B8A9; font-weight: 700;',
  '      background: var(--primary); color: #FFFFFF; font-weight: 700;\n      box-shadow: 0 4px 12px rgba(' + FRESH.rgb + ', .28);',
  'dev fresh 选中态');
// 选主题弹窗：外观恒定 = 跟随「暖橙默认」，暖橙主色换了它就得跟着换，否则面板和页面两个橙
css = mustReplace(css,
  '--primary: #FF7A3D; --accent: #FF7A3D; --accent-2: #FF9A6B;',
  '--primary: ' + WARM.p + '; --accent: ' + WARM.p + '; --accent-2: ' + WARM.p2 + ';',
  '主题弹窗主色');

/* ---- 全局收尾：散落在规则里、不走变量的旧值 ---- */
css = sweep(css, 'rgba(255, 148, 99', 'rgba(' + DARK.rgb);   // 深色：分隔线 / 字光晕 / 按钮 hover
css = sweep(css, 'rgba(0, 184, 169', 'rgba(' + FRESH.rgb);   // 青绿：首框投影
css = sweep(css, '#1D262F', '#202B3B');                      // 深色表格偶数行（老色，偏灰）

fs.writeFileSync(cssPath, css, 'utf8');
console.log('theme.css 写入完成：' + cssBefore + ' → ' + css.length + ' 字节');

/* ==========================================================================
   二、public/css/ui-polish.css —— 页面底色（大面积，润眼的主战场）
   ========================================================================== */
const polishPath = path.join(ROOT, 'public/css/ui-polish.css');
let pol = fs.readFileSync(polishPath, 'utf8');
const polBefore = pol.length;

// 页面底色：平色 → 极淡渐变（「空气感」），亮度再降一档。fixed 防止滚动时渐变重复
pol = mustReplace(pol,
  '[data-theme="warm"][data-theme] body { background: #FAF7F2; }',
  '/* 润眼：页面底不用纯白、也不压死 —— 一道极淡渐变做出「空气感」，大面积高亮才不刺眼 */\n' +
  '[data-theme="warm"][data-theme] body {\n' +
  '  background: linear-gradient(180deg, #FAF8F4 0%, #F5F0E7 100%);\n' +
  '  background-attachment: fixed;\n}\n' +
  '[data-theme="fresh"][data-theme] body {\n' +
  '  background: linear-gradient(180deg, #F8FCFA 0%, #F0F8F5 100%);\n' +
  '  background-attachment: fixed;\n}\n' +
  '[data-theme="dark"][data-theme] body {\n' +
  '  background: linear-gradient(180deg, #121C29 0%, #0B131C 100%);\n' +
  '  background-attachment: fixed;\n}',
  'polish 页面底色');
// ★ 旧青绿残留（换肤串色老毛病）：选中胶囊投影还写死 #00B8A9
pol = sweep(pol, 'rgba(0, 184, 169, .18)', 'rgba(' + FRESH.rgb + ', .28)');
// 深色顶栏与侧栏同色
pol = sweep(pol, 'rgba(24, 32, 41, .82)', 'rgba(21, 30, 43, .82)');

fs.writeFileSync(polishPath, pol, 'utf8');
console.log('ui-polish.css 写入完成：' + polBefore + ' → ' + pol.length + ' 字节');

/* ==========================================================================
   三、uni-app/src/styles/theme-vars.css（同一个牌子不能像两家）
   ========================================================================== */
const mpPath = path.join(ROOT, 'uni-app/src/styles/theme-vars.css');
let mp = fs.readFileSync(mpPath, 'utf8');
const mpBefore = mp.length;

mp = applyVars(mp, '.theme-warm {', {
  '--dh-primary': WARM.p,
  '--dh-primary-600': '#B85C12',
  '--dh-primary-500': WARM.p2,
  '--dh-primary-400': '#FFC9A8',
  '--dh-primary-100': '#FBE1C6',
  '--dh-primary-50': '#FDF3E9',
  '--dh-card': WARM.card,
  '--dh-text': WARM.text,
  '--dh-text-2': '#4E463C',
  '--dh-text-3': WARM.sub,
  '--dh-text-4': '#948C84',
  '--dh-text-disabled': '#C4BDB6',
  '--dh-border': WARM.border,
  '--dh-divider': '#F1EAE3',
  '--dh-bg': '#F8F4EF',
  '--dh-card-2': '#FCFAF7',
  '--dh-shadow-brand': '0 8rpx 24rpx rgba(' + WARM.rgb + ', .34)',
  '--dh-success-bg': '#F1FAF3',
  '--dh-warning-bg': '#FEF8E9',
  '--dh-danger-bg': '#FDF1EE'
});

mp = applyVars(mp, '.theme-dark {', {
  '--dh-primary': DARK.p,
  '--dh-primary-600': '#E8804A',
  '--dh-primary-500': DARK.p2,
  '--dh-primary-400': '#FFD8B4',
  '--dh-bg': '#0E1620',
  '--dh-card': DARK.card,
  '--dh-card-2': '#263648',
  '--dh-border': DARK.border,
  '--dh-text': DARK.text,
  '--dh-text-2': '#BCC4CE'
});

mp = applyVars(mp, '.theme-fresh {', {
  '--dh-primary': FRESH.p,
  '--dh-primary-600': '#00795C',
  '--dh-primary-500': FRESH.p2,
  '--dh-primary-400': '#6FE3CB',
  '--dh-primary-100': '#D2F2EA',
  '--dh-primary-50': '#EDFAF6',
  '--dh-card': FRESH.card,
  '--dh-text': FRESH.text,
  '--dh-text-2': '#3D4B45',
  '--dh-text-3': FRESH.sub,
  '--dh-text-4': '#8B9993',
  '--dh-text-disabled': '#B7C2BD',
  '--dh-border': FRESH.border,
  '--dh-divider': '#EDF4F2',
  '--dh-bg': '#F4FAF8',
  '--dh-card-2': '#F8FCFB',
  '--dh-shadow-brand': '0 8rpx 24rpx rgba(' + FRESH.rgb + ', .34)',
  '--dh-success-bg': '#EDFAF6',
  '--dh-warning-bg': '#FEFAEC',
  '--dh-danger-bg': '#FDF3F1'
});

fs.writeFileSync(mpPath, mp, 'utf8');
console.log('theme-vars.css 写入完成：' + mpBefore + ' → ' + mp.length + ' 字节');

/* ==========================================================================
   四、对比度自检（按钮白字 ≥3.0；正文 ≥4.5 且不过曝；次要字 ≥5）
   ========================================================================== */
console.log('\n=== 对比度自检（含润眼舒适区）===');
// [类型, 名称, 值, 最低, 最高(可选)]
const checks = [
  ['按钮', '暖橙主色 ' + WARM.p + ' 上白字', ratio(WARM.p, '#FFFFFF'), 3.0],
  ['按钮', '青绿主色 ' + FRESH.p + ' 上白字（按钮/选中胶囊）', ratio(FRESH.p, '#FFFFFF'), 3.0],
  ['按钮', '深色主色 ' + DARK.p + ' 在卡片 ' + DARK.card, ratio(DARK.p, DARK.card), 4.5],
  ['正文', '暖橙正文 ' + WARM.text + ' 在卡片 ' + WARM.card, ratio(WARM.text, WARM.card), 4.5, 13],
  ['正文', '青绿正文 ' + FRESH.text + ' 在卡片 ' + FRESH.card, ratio(FRESH.text, FRESH.card), 4.5, 13],
  ['正文', '深色正文 ' + DARK.text + ' 在卡片 ' + DARK.card, ratio(DARK.text, DARK.card), 4.5, 11],
  ['次要', '暖橙次要字 ' + WARM.sub + ' 在卡片', ratio(WARM.sub, WARM.card), 5.0],
  ['次要', '青绿次要字 ' + FRESH.sub + ' 在卡片', ratio(FRESH.sub, FRESH.card), 5.0],
  ['次要', '深色次要字 ' + DARK.sub + ' 在卡片', ratio(DARK.sub, DARK.card), 5.0],
  ['正文', '暖橙侧栏字 #C6CEDA 在 #1B2A41', ratio('#C6CEDA', '#1B2A41'), 4.5],
  ['正文', '暖橙侧栏选中 #FFC9A8 在 #1B2A41', ratio('#FFC9A8', '#1B2A41'), 4.5],
  ['正文', '青绿侧栏字 #3D4D48 在白侧栏', ratio('#3D4D48', '#FFFFFF'), 4.5]
];
let bad = 0;
checks.forEach(function (c) {
  const v = parseFloat(c[2]);
  const ok = v >= c[3] && (c[4] ? v <= c[4] : true);
  if (!ok) bad++;
  const range = c[4] ? '（舒适区 ' + c[3] + '~' + c[4] + '）' : '（需 ≥' + c[3] + '）';
  console.log((ok ? '  OK    ' : '  不达标 ') + c[2] + ' : 1  ' + range + '  ' + c[1]);
});
console.log('\n' + (bad ? '有 ' + bad + ' 项不达标，必须调整！' : '全部达标。'));
console.log('润眼要点：卡片近白（非纯白）/ 正文 10:1 左右不过曝 / 深色正文 ~9.8:1 无炫光 / 次要字 ≥5:1');
console.log('\n完成。请刷新网页端切换主题查看。');
