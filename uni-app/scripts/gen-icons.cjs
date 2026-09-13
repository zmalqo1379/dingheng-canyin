/**
 * scripts/gen-icons.cjs
 * 仅使用 Node 内置模块（fs/path/zlib）生成：
 *   - src/static/tabbar/*.png（4 组 tabBar 图标：普通灰色 + 选中橙色）
 *   - src/static/audio/new-order.wav（双音"叮咚"提示音）
 *
 * 运行：node scripts/gen-icons.cjs   或   npm run gen:icons
 *
 * 说明：微信小程序 tabBar 必须使用 PNG 图标，
 * 本脚本以像素方式绘制极简图标，保证项目开箱即用。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'src', 'static');
const tabbarDir = path.join(OUT, 'tabbar');
const audioDir = path.join(OUT, 'audio');
fs.mkdirSync(tabbarDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

/* ============ PNG 编码器 ============ */
function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ============ 像素画布 ============ */
function makeCanvas(w, h) {
  return { w, h, buf: Buffer.alloc(w * h * 4) }; // 全透明
}
function setPx(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.buf[i] = r; c.buf[i + 1] = g; c.buf[i + 2] = b; c.buf[i + 3] = (a === undefined ? 255 : a);
}
function fillRect(c, x0, y0, x1, y1, col) {
  const [r, g, b] = col;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(c, x, y, r, g, b, 255);
}
function eraseRect(c, x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(c, x, y, 0, 0, 0, 0);
}
function fillTriangle(c, x0, y0, x1, y1, x2, y2, col) {
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(c.h - 1, Math.ceil(Math.max(y0, y1, y2)));
  for (let y = minY; y <= maxY; y++) {
    let minX = c.w, maxX = -1;
    const edges = [[x0, y0, x1, y1], [x1, y1, x2, y2], [x2, y2, x0, y0]];
    for (const [ax, ay, bx, by] of edges) {
      if ((ay <= y && by >= y) || (by <= y && ay >= y)) {
        const t = (ay === by) ? 0 : (y - ay) / (by - ay);
        const ix = ax + (bx - ax) * t;
        if (ix < minX) minX = ix;
        if (ix > maxX) maxX = ix;
      }
    }
    if (maxX >= minX) {
      for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) setPx(c, x, y, col[0], col[1], col[2], 255);
    }
  }
}

/* ============ 图标绘制（采购 / 商城 / 采购单 / 我的） ============ */
// 采购：购物车（把手 + 车斗 + 双轮）
function drawCart(c, col) {
  fillRect(c, 6, 9, 42, 14, col);       // 顶部把手横杆
  fillRect(c, 6, 9, 11, 23, col);       // 把手竖杆
  fillRect(c, 9, 18, 39, 23, col);      // 车斗上沿
  fillRect(c, 12, 23, 36, 33, col);     // 车斗主体
  fillTriangle(c, 12, 33, 36, 33, 24, 39, col); // 车斗底部
  fillRect(c, 13, 36, 20, 42, col);     // 左轮
  fillRect(c, 28, 36, 35, 42, col);     // 右轮
}
// 商城：店铺（三角屋顶 + 房身 + 门洞）
function drawShop(c, col) {
  fillTriangle(c, 8, 26, 24, 8, 40, 26, col);
  fillRect(c, 12, 26, 36, 42, col);
  eraseRect(c, 21, 33, 27, 42);
}
// 采购单：文档外框 + 三条文字线
function drawOrder(c, col) {
  fillRect(c, 12, 6, 36, 42, col);
  eraseRect(c, 16, 10, 32, 38);
  fillRect(c, 18, 15, 30, 18, col);
  fillRect(c, 18, 22, 30, 25, col);
  fillRect(c, 18, 29, 27, 32, col);
}
// 我的：人形（头 + 肩身）
function drawUser(c, col) {
  fillRect(c, 20, 8, 28, 10, col);
  fillRect(c, 18, 10, 30, 19, col);
  fillRect(c, 20, 19, 28, 21, col);
  fillRect(c, 13, 24, 35, 42, col);
}

const NORMAL = [153, 153, 153];
const ACTIVE = [255, 107, 53]; // #FF6B35
const glyphs = { purchase: drawCart, mall: drawShop, order: drawOrder, mine: drawUser };

for (const name of Object.keys(glyphs)) {
  const cn = makeCanvas(48, 48); glyphs[name](cn, NORMAL);
  fs.writeFileSync(path.join(tabbarDir, name + '.png'), encodePNG(48, 48, cn.buf));
  const ca = makeCanvas(48, 48); glyphs[name](ca, ACTIVE);
  fs.writeFileSync(path.join(tabbarDir, name + '-active.png'), encodePNG(48, 48, ca.buf));
}

/* ============ WAV 编码器（双音叮咚提示音） ============ */
function writeWav(file, samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

const sr = 22050;
const samples = [];
function tone(freq, dur, vol) {
  const n = Math.floor(sr * dur);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-3 * t / dur); // 指数衰减包络
    samples.push(Math.sin(2 * Math.PI * freq * t) * env * vol);
  }
}
tone(659, 0.18, 0.6);   // E5
for (let i = 0; i < Math.floor(sr * 0.05); i++) samples.push(0); // 间隔
tone(1047, 0.28, 0.6);  // C6
writeWav(path.join(audioDir, 'new-order.wav'), samples, sr);

console.log('✅ 已生成 tabBar 图标(8) + new-order.wav');
console.log('   -', path.relative(process.cwd(), tabbarDir));
console.log('   -', path.relative(process.cwd(), audioDir));
