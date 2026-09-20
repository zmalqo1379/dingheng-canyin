/* ============================================================================
   小程序端主题状态（uni-app/src/utils/theme.js）
   ----------------------------------------------------------------------------
   微信小程序里做运行时换肤，只有一条路走得通：
   给【页面根 view】挂一个主题 class（ .theme-warm / .theme-dark / .theme-fresh ），
   class 里定义一整套 CSS 变量，页面自己继承下去。
   不能像网页端那样 <html data-theme="xxx">，也别指望动态插样式表 —— 小程序都没有。

   三条机制的顺序（谁说了算）：
     ① 用户手动选过主题  → 永远用用户选的
     ② 没手动选过        → 跟随系统深浅色（系统深色 = 深色主题）
     ③ 都不是            → classic 经典版（小程序改造前的样子，零变化）
   这样既保留了「微信好公民」的系统跟随，又不会被系统抢走用户的选择。

   注意：小程序端的使用者是顾客 / 门店职员，所以钥匙是 dhAppTheme，
   刻意不与网页端的 dhAdminTheme 共用一个（老板在后台选的主题不该跳到顾客手机上）。
   ============================================================================ */
import { ref } from 'vue';

const KEY = 'dhAppTheme';
const LEGAL = ['classic', 'warm', 'dark', 'fresh'];

// 四套主题的展示信息。文案是硬约束，一字不得改。
export const THEMES = [
  { key: 'classic', name: '经典版', slogan: '走了很远，也别忘了出发的样子。', dot: '#FF6B35' },
  { key: 'warm',    name: '松墨绿', slogan: '盯一天，眼睛也不累。',         dot: '#177A56' },
  { key: 'dark',    name: '深色',   slogan: '夜深了，数字还在替你守着生意。', dot: '#FF9463' },
  { key: 'fresh',   name: '青绿',   slogan: '新鲜，是这行最贵的品质。',       dot: '#00B8A9' }
];

// 每套主题对应的原生 chrome 配色（导航栏 / tabBar）—— 这两个部件不吃 CSS 变量，
// 只能靠 uni.* API 逐个通知，不然换了主题导航栏还是旧的橙色，等于没换完。
// ★ 硬规矩：这里的 nav / tabOn / tabBg 必须与 src/styles/theme-vars.css 里
//   对应主题的 --dh-primary / --dh-card 同值。改了那边忘了这边（或反过来），
//   就会「页面变绿、导航栏还是橙」—— 换肤串色的老毛病，根子都在这张表。
//   （2026-09-20 修：warm 从旧暖橙 #FF7A3D 改成松墨绿 #177A56；dark/fresh 一并对齐令牌）
const CHROME = {
  classic: { nav: '#FF6B35', navText: '#ffffff', tabColor: '#999999', tabOn: '#FF6B35', tabBg: '#ffffff', tabBorder: 'black' },
  warm:    { nav: '#177A56', navText: '#ffffff', tabColor: '#A0A4AA', tabOn: '#177A56', tabBg: '#FFFFFF', tabBorder: 'black' },
  dark:    { nav: '#131A22', navText: '#ffffff', tabColor: '#7A8494', tabOn: '#FFA873', tabBg: '#1B2634', tabBorder: 'white' },
  fresh:   { nav: '#FFFFFF', navText: '#000000', tabColor: '#9BA5A3', tabOn: '#00A078', tabBg: '#FFFFFF', tabBorder: 'black' }
};

function readStored() {
  try {
    var v = uni.getStorageSync(KEY);
    return LEGAL.indexOf(v) > -1 ? v : '';   // '' = 用户没手动选过
  } catch (e) { return ''; }
}

function systemIsDark() {
  try {
    var info = uni.getAppBaseInfo && uni.getAppBaseInfo();
    if (info && info.theme) return info.theme === 'dark';
  } catch (e) { /* 平台不支持就往下走 */ }
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (e) { return false; }
}

function computeClass() {
  var manual = readStored();
  if (manual) return 'theme-' + manual;
  return systemIsDark() ? 'theme-dark' : '';   // 没选过 → 跟随系统
}

function currentChrome() {
  var manual = readStored();
  return CHROME[manual] || (systemIsDark() ? CHROME.dark : CHROME.classic);
}

// 所有页面共用同一个 ref —— 一处更新，全部页面跟着重渲染。
const themeClass = ref(computeClass());

// 系统深浅变了而我们仍处在「跟随」状态 → 立即跟着变
try {
  uni.onThemeChange && uni.onThemeChange(function (res) {
    if (readStored()) return;                 // 用户手动选过就不打扰
    themeClass.value = res && res.theme === 'dark' ? 'theme-dark' : '';
    applyChrome();
  });
} catch (e) { /* 不支持的系统忽略 */ }

/** 把主题同步给导航栏 / tabBar（原生部件，不吃 CSS 变量） */
export function applyChrome() {
  var c = currentChrome();
  try {
    uni.setNavigationBarColor({ frontColor: c.navText, backgroundColor: c.nav });
  } catch (e) { /* 非 tab 页或平台不支持：忽略 */ }
  try {
    uni.setTabBarStyle({ color: c.tabColor, selectedColor: c.tabOn, backgroundColor: c.tabBg, borderStyle: c.tabBorder });
  } catch (e) { /* 非 tab 页调用会失败，正常 */ }
}

/** 页面用：const themeClass = useThemeClass(); 然后根 view 上 :class="themeClass" */
export function useThemeClass() { return themeClass; }

/** 当前生效的 key（手动选的优先，否则跟随系统换算出来的） */
export function currentKey() {
  var manual = readStored();
  if (manual) return manual;
  return systemIsDark() ? 'dark' : 'classic';
}

/** 切换并保存（只存本机，不上传） */
export function setTheme(key) {
  if (LEGAL.indexOf(key) < 0) return;
  try { uni.setStorageSync(KEY, key); } catch (e) { /* 隐私模式忽略 */ }
  themeClass.value = 'theme-' + key;
  applyChrome();
}
