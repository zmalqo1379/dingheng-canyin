/**
 * 拍照 / 粘贴文字 → 结构化商品（菜品）列表
 * ============================================================
 * 干什么用：供应商手里有一张品类报价单、商家手里有一份纸质菜单，
 *          一件一件手打太慢。拍张照（或把报价单文字粘进来），
 *          这里把图片/文字交给大模型，回来一张干净的结构化清单，
 *          前端渲染成"能改能删能加"的表格，最后一键批量新增。
 *
 * 为什么用多模态大模型而不是传统 OCR：
 *   传统 OCR 只吐"文字块 + 坐标"，还得自己把「宫保鸡丁」和右边的「38」配成一对、
 *   判断「热菜」是分类标题、忽略「加收10%服务费」。菜单排版一乱就满盘皆输。
 *   大模型看得懂版式，直接吐 JSON，中文菜单/手写单的准确率完全不是一个量级。
 *
 * 为什么做成"可换厂商"：
 *   各家都有免费额度，也都有用完的一天。所以这里统一走 OpenAI 兼容协议，
 *   换厂商 = 改 .env 里 AI_PROVIDER 一行，业务代码一个字不动。
 */

const TIMEOUT_MS = 60000;   // 识别一次最多等 60 秒，超时就让他重试，别干等

// ============ 厂商预设 ============
// 全部是 OpenAI 兼容的 chat/completions 协议，只换地址、模型名、Key。
const PROVIDERS = {
  qwen: {
    label: '通义千问（阿里云百炼）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    visionModel: 'qwen3-vl-plus',
    textModel: 'qwen-plus'
  },
  glm: {
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    visionModel: 'glm-4.5v',
    textModel: 'glm-4-flash'
  },
  doubao: {
    label: '豆包（火山方舟）',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    visionModel: 'doubao-1.5-vision-pro-32k',
    textModel: 'doubao-1.5-pro-32k'
  },
  deepseek: {
    // DeepSeek 目前没有视觉模型：只能接"粘贴文字"那条路，图片识别会明确报错提示换一家
    label: 'DeepSeek（仅支持文字，不支持图片）',
    baseURL: 'https://api.deepseek.com/chat/completions',
    visionModel: '',
    textModel: 'deepseek-chat'
  },
  moonshot: {
    label: 'Kimi（月之暗面）',
    baseURL: 'https://api.moonshot.cn/v1/chat/completions',
    visionModel: 'moonshot-v1-8k-vision-preview',
    textModel: 'moonshot-v1-8k'
  },
  custom: {
    label: '自定义（任意 OpenAI 兼容服务）',
    baseURL: '',
    visionModel: '',
    textModel: ''
  }
};

// 兜底枚举：识别结果往系统已有的选项上靠，别造出新分类
const DEFAULT_PRODUCT_CATEGORIES = ['米面粮油', '鲜肉', '叶菜', '根茎茄果', '蛋', '干调', '冻品', '一次性用品', '其他'];
const DEFAULT_DISH_CATEGORIES = ['热菜', '凉菜', '主食', '汤羹', '饮品', '小吃', '其他'];
const COMMON_UNITS = ['斤', 'kg', 'g', '箱', '桶', '袋', '个', '件', '瓶', '包', '盒', '把', '只', '条', '块', '台', '份', '扎', '杯', '壶', '锅', '袋/箱', '件/箱'];

class VisionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function getConfig() {
  const key = (process.env.AI_PROVIDER || 'qwen').toLowerCase();
  const p = PROVIDERS[key] || PROVIDERS.qwen;
  return {
    provider: key,
    label: p.label,
    baseURL: (process.env.AI_BASE_URL || p.baseURL || '').trim(),
    visionModel: (process.env.AI_VISION_MODEL || p.visionModel || '').trim(),
    textModel: (process.env.AI_TEXT_MODEL || p.textModel || '').trim(),
    apiKey: (process.env.AI_API_KEY || '').trim()
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(c.apiKey && c.baseURL);
}

// ============ 调模型 ============
async function chat(messages, model) {
  const cfg = getConfig();
  if (!cfg.apiKey) {
    throw new VisionError('NOT_CONFIGURED', '平台还没开通识别服务（缺 AI_API_KEY），请联系平台开通后再用');
  }
  if (!cfg.baseURL) {
    throw new VisionError('NOT_CONFIGURED', '识别服务地址没配置（缺 AI_BASE_URL）');
  }
  if (!model) {
    throw new VisionError('NO_MODEL', '当前服务商不支持这个模型，换一家（改 AI_PROVIDER）或换配置');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(cfg.baseURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 4096 }),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new VisionError('TIMEOUT', '识别超时了，请重试一次');
    throw new VisionError('NETWORK', '连不上识别服务：' + (err && err.message ? err.message : '网络异常'));
  }
  clearTimeout(timer);

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new VisionError('BAD_RESPONSE', '识别服务返回了看不懂的内容（HTTP ' + res.status + '）');
  }
  if (!res.ok) {
    const msg = (data && (data.error && (data.error.message || data.error.code))) || data.message || ('HTTP ' + res.status);
    if (res.status === 401 || res.status === 403) throw new VisionError('AUTH_FAILED', '识别服务的密钥不对或已失效：' + msg);
    throw new VisionError('UPSTREAM', '识别服务报错：' + msg);
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new VisionError('EMPTY', '识别服务没返回内容，请重试');
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// ============ 结果清洗 ============
// 模型偶尔会裹一层 ```json ```，或者前后加两句废话，这里一律剥掉只留 JSON
function extractJson(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) throw new VisionError('BAD_JSON', '识别结果不是标准清单，请重试或手动添加');
  s = s.slice(a, b + 1);
  // 模型偶尔在 JSON 里写注释或中文逗号，做最小限度的修补
  s = s.replace(/，/g, ',').replace(/：/g, ':');
  return JSON.parse(s);
}

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d.]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function cleanName(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  // 去掉行首的序号："1." "①" "1、" "- " 等
  s = s.replace(/^[\s]*[0-9０-９]{1,3}[\.、\)）:：]\s*/, '').replace(/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*/, '').replace(/^[-*·•]\s*/, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s.slice(0, 40);
}

// 把模型给的品类说法，靠到系统已有的选项上；靠不上就返回 null，由调用方兜底
function matchCategory(raw, list) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  for (const c of list) if (c === s) return c;
  if (s.length >= 2) {
    for (const c of list) {
      if (c.length >= 2 && (s.includes(c) || c.includes(s))) return c;
    }
  }
  return null;
}

function matchUnit(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/\s/g, '');
  if (!s) return null;
  for (const u of COMMON_UNITS) {
    if (s === u.toLowerCase()) return u;
  }
  for (const u of COMMON_UNITS) {
    if (s.includes(u.toLowerCase())) return u;
  }
  return s.slice(0, 6);   // 系统里没有的单位，原样留着，别硬改人家的说法
}

// 统一清洗：去空、去重、价格只留数字、品类/单位归一化
function normalizeItems(list, kind, opts) {
  const categories = (opts && opts.categories && opts.categories.length)
    ? opts.categories
    : (kind === 'dish' ? DEFAULT_DISH_CATEGORIES : DEFAULT_PRODUCT_CATEGORIES);
  const fallbackCategory = categories[categories.length - 1] || '其他';
  const out = [];
  const seen = new Set();

  (Array.isArray(list) ? list : []).forEach((it) => {
    if (!it || typeof it !== 'object') return;
    const name = cleanName(it.name || it.title || it.商品名 || it.菜名 || '');
    if (!name) return;
    const key = name.replace(/\s/g, '');
    if (seen.has(key)) return;   // 同一张表里重复的行只留一条
    seen.add(key);

    const price = toNumber(it.price != null ? it.price : (it.costPrice != null ? it.costPrice : it.价格));
    const item = {
      name,
      price,
      // 把握不大的（模型自己标的，或者价格都没拍到）标出来，前端打黄标让他核一眼
      confidence: (it.confidence === 'low' || it.confidence === 'low'.toUpperCase()) ? 'low' : 'high'
    };

    if (kind === 'dish') {
      item.category = matchCategory(it.category || it.分类, categories) || fallbackCategory;
      item.description = String(it.description || it.描述 || '').slice(0, 100);
    } else {
      const cat = matchCategory(it.category || it.品类, categories);
      item.category = cat || fallbackCategory;
      item.unit = matchUnit(it.unit || it.单位);
      item.stock = (() => { const n = toNumber(it.stock != null ? it.stock : it.库存); return n == null ? null : Math.max(0, Math.floor(n)); })();
      item.description = String(it.description || it.描述 || '').slice(0, 100);
      // 品类没匹配上系统的枚举、又不是"其他"—— 说明模型自己猜了一个，提醒核对
      if (!cat) item.confidence = 'low';
    }
    out.push(item);
  });
  return out;
}

// ============ Prompt ============
function buildPrompt(kind, opts) {
  const categories = (opts && opts.categories && opts.categories.length)
    ? opts.categories
    : (kind === 'dish' ? DEFAULT_DISH_CATEGORIES : DEFAULT_PRODUCT_CATEGORIES);
  const catList = categories.join('、');

  if (kind === 'dish') {
    return [
      '你是餐饮门店的菜单录入助手。这张照片是一份纸质菜单（或手写菜单、电子菜单截图）。',
      '请把菜单上的「菜品」一条条识别出来，只输出 JSON，不要任何解释文字。',
      '格式：{"items":[{"name":"宫保鸡丁","price":38,"category":"热菜","confidence":"high"}]}',
      '规则：',
      '1. name：菜名，去掉序号和价格，只留菜名本身',
      '2. price：纯数字（去掉 ¥、元、RMB 等符号），没有价格或写着"时价"就填 null',
      `3. category：必须从【${catList}】里选最接近的一个；判断不出就填"其他"`,
      '4. 忽略这些行：分类标题（如"热菜""凉菜"）、店名、电话、地址、服务费说明、页眉页脚',
      '5. 看不清楚的一律照猜出来，但 confidence 填 "low"',
      '6. 如果图里根本不是菜单，返回 {"items":[]}'
    ].join('\n');
  }

  return [
    '你是餐饮供应链的录入助手。这张照片是一份商品品类表 / 报价单 / 商品清单（可能手写，可能打印）。',
    '请把里面的「商品」一条条识别出来，只输出 JSON，不要任何解释文字。',
    '格式：{"items":[{"name":"五花肉","category":"鲜肉","unit":"斤","price":28.5,"stock":null,"confidence":"high"}]}',
    '规则：',
    '1. name：商品名，去掉序号，保留必要的规格信息',
    `2. category：必须从【${catList}】里选最接近的一个；判断不出就填"其他"`,
    '3. unit：计量单位（斤、kg、箱、桶、袋、个、件、瓶、包…），没有就填 null',
    '4. price：纯数字（去掉 ¥、元/斤 等），没有价格就填 null',
    '5. stock：库存数量，没有就填 null',
    '6. 忽略这些行：表头、日期、客户名、电话、合计、备注说明',
    '7. 看不清楚的一律照猜出来，但 confidence 填 "low"',
    '8. 如果图里根本不是商品清单，返回 {"items":[]}'
  ].join('\n');
}

// ============ 对外：图片识别 ============
// imageDataUrl：前端压缩后的 data:image/jpeg;base64,xxxx
async function parseImage(imageDataUrl, kind, opts) {
  const cfg = getConfig();
  const prompt = buildPrompt(kind, opts);
  const content = [
    { type: 'image_url', image_url: { url: imageDataUrl } },
    { type: 'text', text: prompt }
  ];
  let raw = await chat([{ role: 'user', content }], cfg.visionModel);

  let items;
  try {
    items = normalizeItems(extractJson(raw).items, kind, opts);
  } catch (e) {
    // 第一次没吐出标准 JSON —— 再要一次，这次话说得更硬
    raw = await chat([{ role: 'user', content: [...content, { type: 'text', text: '再输出一次，只输出纯 JSON，不要代码块、不要解释。' }] }], cfg.visionModel);
    items = normalizeItems(extractJson(raw).items, kind, opts);
  }
  return { items, provider: cfg.provider, providerLabel: cfg.label, via: 'image' };
}

// ============ 对外：文字识别（粘贴兜底）============
// 微信里收到的报价单、菜单文字，直接粘进来，比拍照还准，而且几乎不花钱
async function parseText(text, kind, opts) {
  const cfg = getConfig();
  const src = String(text || '').trim();
  if (!src) throw new VisionError('EMPTY_INPUT', '没有可识别的内容');
  const prompt = buildPrompt(kind, opts).replace('这张照片是', '下面这段文字是').replace(/照片/g, '文字');
  const userMsg = `${prompt}\n\n内容如下：\n${src.slice(0, 8000)}`;

  let raw = await chat([{ role: 'user', content: userMsg }], cfg.textModel);
  let items;
  try {
    items = normalizeItems(extractJson(raw).items, kind, opts);
  } catch (e) {
    raw = await chat([{ role: 'user', content: userMsg + '\n\n再输出一次，只输出纯 JSON，不要代码块、不要解释。' }], cfg.textModel);
    items = normalizeItems(extractJson(raw).items, kind, opts);
  }
  return { items, provider: cfg.provider, providerLabel: cfg.label, via: 'text' };
}

module.exports = {
  parseImage,
  parseText,
  isConfigured,
  getConfig,
  VisionError,
  PROVIDERS,
  DEFAULT_PRODUCT_CATEGORIES,
  DEFAULT_DISH_CATEGORIES,
  COMMON_UNITS,
  normalizeItems
};
