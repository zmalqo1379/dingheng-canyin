const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'public', 'admin.html');
const backup = file + '.bak-' + Date.now();
fs.copyFileSync(file, backup);
console.log('已备份:', backup);

let html = fs.readFileSync(file, 'utf8');
const isEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

const jobs = [
  ['locked-icon 锁定图标', /<div class="locked-icon">[\s\S]*?<\/div>/g],
  ['大号 emoji (42/40/34/32/26px)', /<div style="font-size:\s*(42|40|34|32|26)px[^"]*">[\s\S]*?<\/div>/g],
  ['coin-intro 图标', /<div class="coin-intro-icon">[\s\S]*?<\/div>/g],
  ['upsell 图标', /<div class="upsell-icon">[\s\S]*?<\/div>/g],
  ['store-info 图标', /<div class="store-info-icon">[\s\S]*?<\/div>/g],
];

let total = 0;
for (const [label, re] of jobs) {
  let n = 0;
  html = html.replace(re, (m) => {
    if (isEmoji.test(m)) { n++; return ''; }
    return m;
  });
  console.log(`${label}: 删除 ${n} 个`);
  total += n;
}

fs.writeFileSync(file, html, 'utf8');
console.log('---- 共删除 ' + total + ' 个大号 emoji ----');
console.log('如有问题，把备份文件改回 admin.html 即可还原');