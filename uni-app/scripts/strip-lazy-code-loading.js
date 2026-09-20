/**
 * scripts/strip-lazy-code-loading.js
 * 2026-09-19 新增：构建后处理——从 dist/build/mp-weixin/app.json 里删掉 lazyCodeLoading。
 *
 * 为什么：微信开发者工具部分版本下，按需注入(requiredComponents)会让页面框架
 * (__pageframe__) 返回 500、页面逻辑不执行，表现为商城页「永远显示加载中…」。
 * uni-app 新版编译器会无条件写入该字段（manifest 关不掉），所以只能构建后删。
 * 按需注入只是加载性能优化，11 个页面的小程序去掉零损失。
 *
 * 用法：node scripts/strip-lazy-code-loading.js  （由 npm run build:mp-weixin 自动调用）
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'dist', 'build', 'mp-weixin', 'app.json');

if (!fs.existsSync(target)) {
  console.error('[strip-lazy] 未找到 ' + target + '，请先构建');
  process.exit(1);
}

const json = JSON.parse(fs.readFileSync(target, 'utf8'));
if ('lazyCodeLoading' in json) {
  delete json.lazyCodeLoading;
  fs.writeFileSync(target, JSON.stringify(json, null, 2), 'utf8');
  console.log('[strip-lazy] 已从 app.json 移除 lazyCodeLoading（规避开发者工具 pageframe 500）');
} else {
  console.log('[strip-lazy] app.json 本就没有 lazyCodeLoading，无需处理');
}
