// 商品定价治理 · 端到端验证（隔离测试数据，用完即删）
// 覆盖：
//   第一部分：未定价商品不进商城（列表过滤 / 详情 404）+ 下单防御（0 元 / 低于底线一律拒绝）
//   第二部分：一键定价预览 → 应用（卖价 = 公式值）→ 手动定价跳过 → 成本线保护 → 快照回滚
//   第二部分-补充：尾数取整选项（页面可选）——默认四舍五入到角 + 取整保护、自定义尾数、不取整
//   【2026-09】低价商品加价上限（保底加价额 / 加价率上限倍数在定价页面可改，超出上限则放弃保底）
// 运行：node scripts/verify_pricing_e2e.js   （需先启动服务，BASE 可用 E2E_BASE 覆盖）
require('dotenv').config();
const mongoose = require('mongoose');
const SupplyProduct = require('../models/SupplyProduct');
const Supplier = require('../models/Supplier');
const ShopAccount = require('../models/ShopAccount');
const Setting = require('../models/Setting');
const PurchaseOrder = require('../models/PurchaseOrder');
const PlatformConfig = require('../models/PlatformConfig');
const dhConfig = require('../utils/dhConfig');

const BASE = process.env.E2E_BASE || 'http://localhost:3000';
const TS = Date.now();
const TAG = 'PRICEE2E' + TS;

// 一键定价的「尾数取整」选项（2026-09 起在定价工作台页面选择，随请求提交，不落库）
// 本脚本历史期望值（11.9 / 41.9 / 1.9 …）对应旧口径，故显式固定为「向上取整到 .9 + 关闭取整保护」；
// 页面新默认（四舍五入到角 + 取整保护开启）的校验见「第二部分-补充」。
const ROUND_LEGACY = { roundMode: 'ceil', roundTail: 9, roundGuard: false };

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? ' → ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
}

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch (e) { json = { success: false, message: 'non-json' }; }
  return { status: r.status, ...json };
}

async function main() {
  console.log('===== 商品定价治理 · 端到端验证 =====');
  console.log('BASE =', BASE, '\n');

  await mongoose.connect(process.env.MONGODB_URI);

  const created = { products: [], supplierId: null, shopId: null };
  const RATE = 0.10;

  try {
    // ---------- 准备：测试供应商（直接置为可接单状态） ----------
    console.log('[准备] 创建测试供应商 + 商品');
    const supplier = await Supplier.create({
      name: TAG + '供应商',
      contact: '测试员',
      phone: '9' + TS.toString().slice(-10),
      loginAccount: ('s' + TS).toLowerCase(),
      password: 'Test@12345',
      categories: ['蔬菜'],
      status: 'active',
      agreementSigned: true,
      orderEnabled: true,
      minOrderAmount: 1
    });
    created.supplierId = supplier._id;

    const mk = async (name, cost, salePrice, isManual) => {
      const p = await SupplyProduct.create({
        name: TAG + '-' + name,
        category: '蔬菜',
        unit: '斤',
        costPrice: cost,
        marketPrice: cost,
        supplierId: supplier._id,
        supplierName: supplier.name,
        stock: 1000,
        status: '上架',
        salePrice: salePrice == null ? null : salePrice,
        isManualPrice: !!isManual
      });
      created.products.push(p._id);
      return p;
    };
    const p1 = await mk('P1成本10', 10, null, false);       // 10×1.1=11 → 11.9
    const p2 = await mk('P2成本37.4', 37.4, null, false);   // 41.14 → 41.9
    // P3：保底 0.5 → 1.5 但超过「加价率 10% × 上限 2 倍 = 20%」→ 放弃保底，改用 1×1.2=1.2 → 向上取整到 .9 → 1.9
    const p3 = await mk('P3成本1', 1, null, false);
    const pCap = await mk('P4成本100', 100, null, false);   // 成本线保护用例 → 回落硬地板（默认 5% → 105.9）
    const p4 = await mk('P5手动9.9', 5, 9.9, true);         // 手动定价 → 必须跳过
    const pZero = await mk('P6成本0', 0, null, false);      // 供货价 0 → 跳过
    const pUnder = await mk('P7低于底线', 10, 10, false);   // 存量无加价数据 → 一键定价拉回底线
    console.log('  供应商', String(supplier._id), '｜商品已建\n');

    // ---------- 第一部分 A：商城列表 / 详情过滤未定价商品 ----------
    console.log('[第一部分-A] 未定价商品不进采购商城（商家视角）');
    let list = await req('GET', `/api/supply-products?supplierId=${supplier._id}`);
    let ids = (list.data || []).map(x => String(x._id));
    check('列表不含未定价商品（卖价 0/空）',
      [p1, p2, p3, pCap, pZero].every(p => !ids.includes(String(p._id))));
    // 边界记录：卖价 > 0 但低于底线（如配置调高最低加价率后的存量价）
    //   规格只要求「0/空」不进商城，故此类仍可见；下单接口会拦截并给出明确提示
    check('（边界）卖价低于底线的商品仍可见于商城，由下单接口拦截',
      ids.includes(String(pUnder._id)));
    check('列表含 P5（已手动定价）', ids.includes(String(p4._id)));
    check('P5 卖价展示为 9.9', (list.data || []).find(x => String(x._id) === String(p4._id))?.salePrice === 9.9);

    const detail = await req('GET', `/api/supply-products/${p1._id}`);
    check('未定价商品详情返回 404', detail.status === 404, 'status=' + detail.status);

    // ---------- 第一部分 B：下单防御 ----------
    console.log('\n[第一部分-B] 下单防御（0 元 / 低于底线）');
    const phone = '1' + ('9' + TS).slice(-10);
    const reg = await req('POST', '/api/auth/merchant/register', {
      shopName: TAG + '测试店', contactName: '店长', phone, password: 'Test@12345', confirm: 'Test@12345'
    });
    if (!reg.success) { console.log('  商家注册失败:', reg.message); return; }
    const mToken = reg.data.token;
    created.shopId = reg.data.shopId;
    // 补齐履约必需项（门店地址），使首单直通可放行
    await Setting.updateOne({ shopId: created.shopId }, { $set: { shopAddress: '测试市测试路1号' } });

    const orderUnpriced = await req('POST', '/api/purchase-orders', {
      supplierId: String(supplier._id), items: [{ productId: String(p1._id), quantity: 10 }]
    }, mToken);
    check('未定价商品下单被拒', orderUnpriced.success === false && orderUnpriced.status === 400, orderUnpriced.message);

    const orderZero = await req('POST', '/api/purchase-orders', {
      supplierId: String(supplier._id), items: [{ productId: String(pZero._id), quantity: 10 }]
    }, mToken);
    check('供货价/卖价 0 元下单被拒（资金安全）', orderZero.success === false, orderZero.message);

    const orderUnder = await req('POST', '/api/purchase-orders', {
      supplierId: String(supplier._id), items: [{ productId: String(pUnder._id), quantity: 10 }]
    }, mToken);
    check('卖价低于底线（=供货价）下单被拒', orderUnder.success === false, orderUnder.message);

    // ---------- 第二部分：一键定价 ----------
    console.log('\n[第二部分] 一键定价（开发者工作台）');
    const devLogin = await req('POST', '/api/auth/dev/login', {
      username: process.env.DEV_ADMIN_USER, password: process.env.DEV_ADMIN_PASSWORD
    });
    if (!devLogin.success) { console.log('  开发者登录失败:', devLogin.message); return; }
    const dToken = devLogin.data.token;

    // 后台商品管理（供应商详情「商品列表与定价」）应标记「待定价」
    const supDetail = await req('GET', `/api/dev/suppliers/${supplier._id}/detail`, undefined, dToken);
    const dProds = ((supDetail.data || {}).products) || [];
    const d1 = dProds.find(x => String(x._id) === String(p1._id));
    const dManual = dProds.find(x => String(x._id) === String(p4._id));
    check('后台商品管理：未定价商品被标记「待定价」(pending)',
      !!d1 && d1.pricingStatus === 'pending' && d1.priced === false);
    check('后台商品管理：已定价商品标记为 priced',
      !!dManual && dManual.pricingStatus === 'priced' && dManual.priced === true);

    // 成本线保护：rate=0.01 < COST_FLOOR_RATE(0.03) → pCap 应被判 capped 并回落到硬地板
    // 硬地板 = 系统设置·最低加价率（默认 5%，下限 3%），故这里按当前配置动态算期望值
    const capCfg = await PlatformConfig.getSingleton();
    const capHardFloor = dhConfig.resolveMinMarkupRate(capCfg.minMarkupRate);
    const capExpect = dhConfig.computeBulkSalePrice(100, capHardFloor, capHardFloor).salePrice;
    const capPreview = await req('POST', '/api/dev/pricing/bulk/preview',
      { rate: 0.01, supplierId: String(supplier._id), category: 'all', onlyPending: false, ...ROUND_LEGACY }, dToken);
    const capItem = ((capPreview.data || {}).items || []).find(x => x.productId === String(pCap._id));
    check('成本线保护：加价率 1% < 3% 触发 capped', !!capItem && capItem.capped === true);
    check(`成本线保护：回落到硬地板 ${(capHardFloor * 100).toFixed(2)}% → ${capExpect}`,
      !!capItem && capItem.newSalePrice === capExpect, capItem ? 'newSalePrice=' + capItem.newSalePrice : '未找到');

    // 强制覆盖手动定价：forceOverride=true 时 P5 也进入改价清单
    const forcePreview = await req('POST', '/api/dev/pricing/bulk/preview',
      { rate: RATE, supplierId: String(supplier._id), category: 'all', onlyPending: false, forceOverride: true, ...ROUND_LEGACY }, dToken);
    const fSum = (forcePreview.data && forcePreview.data.summary) || {};
    const fManual = ((forcePreview.data || {}).items || []).find(x => x.productId === String(p4._id));
    check('强制覆盖：P5 手动定价进入改价清单',
      !!fManual && fManual.action === 'update' && fManual.overridesManual === true);
    check('强制覆盖：overriddenManual = 1', fSum.overriddenManual === 1, 'overriddenManual=' + fSum.overriddenManual);

    // 按勾选商品（productIds）：只影响勾选的商品，与供应商/品类筛选无关
    const pickedPreview = await req('POST', '/api/dev/pricing/bulk/preview',
      { rate: RATE, productIds: [String(p1._id), String(p2._id)], ...ROUND_LEGACY }, dToken);
    const pickedSum = (pickedPreview.data && pickedPreview.data.summary) || {};
    check('按勾选商品：只扫描并影响勾选的 2 件',
      pickedSum.affectedCount === 2 && pickedSum.totalScanned === 2,
      `affectedCount=${pickedSum.affectedCount} / totalScanned=${pickedSum.totalScanned}`);

    const scopeBase = { rate: RATE, supplierId: String(supplier._id), category: 'all', onlyPending: false };
    // 固定旧口径（向上取整到 .9 + 关闭取整保护），使下面的期望值可复现
    const scope = { ...scopeBase, ...ROUND_LEGACY };
    const preview = await req('POST', '/api/dev/pricing/bulk/preview', scope, dToken);
    check('预览成功', preview.success === true, preview.message);
    const sum = (preview.data && preview.data.summary) || {};
    check('预览影响 5 件（P1/P2/P3/P4/P7）', sum.affectedCount === 5, 'affectedCount=' + sum.affectedCount);
    check('预览跳过 1 件手动定价（P5）', sum.skippedManual === 1, 'skippedManual=' + sum.skippedManual);
    check('预览跳过 1 件供货价=0（P6）', sum.skippedNoCost === 1, 'skippedNoCost=' + sum.skippedNoCost);
    console.log('    平均加价率 =', (Number(sum.averageMarkupRate) * 100).toFixed(2) + '%',
      '｜预计毛利 = ¥' + Number(sum.estimatedMargin).toFixed(2));

    // ---------- 尾数取整选项（页面可选，服务端权威计算） ----------
    console.log('\n[第二部分-补充] 尾数取整选项（定价页面可选）');
    const defPreview = await req('POST', '/api/dev/pricing/bulk/preview', scopeBase, dToken);
    const defCfg = (defPreview.data && defPreview.data.config) || {};
    const defSum = (defPreview.data && defPreview.data.summary) || {};
    const defOf = id => (((defPreview.data || {}).items) || []).find(x => x.productId === String(id));
    check('不传选项 = 页面默认（四舍五入到角 + 取整保护开启）',
      defCfg.roundMode === 'round' && defCfg.roundTail === 9 && defCfg.roundGuard === true,
      `roundMode=${defCfg.roundMode} roundText=${defCfg.roundText} roundGuard=${defCfg.roundGuard}`);
    check('默认四舍五入到角：P1（成本 10、加价 10%）→ 11.00',
      !!defOf(p1._id) && defOf(p1._id).newSalePrice === 11,
      defOf(p1._id) ? 'newSalePrice=' + defOf(p1._id).newSalePrice : '未找到');
    check('加价率上限：P3（成本 1）保底 1.5 超上限 1.2，放弃保底 → 1.20',
      !!defOf(p3._id) && defOf(p3._id).floorDropped === true && defOf(p3._id).newSalePrice === 1.2,
      defOf(p3._id) ? `newSalePrice=${defOf(p3._id).newSalePrice} floorDropped=${defOf(p3._id).floorDropped}` : '未找到');
    check('取整保护：P3（成本 1）取整后加价率 50% > 15%，放弃取整（改用精确价 1.20）',
      !!defOf(p3._id) && defOf(p3._id).roundingSkipped === true && defOf(p3._id).newSalePrice === 1.2,
      defOf(p3._id) ? `newSalePrice=${defOf(p3._id).newSalePrice} roundingSkipped=${defOf(p3._id).roundingSkipped}` : '未找到');
    check('预览回显加价率上限配置（保底 0.5 元 / 上限 2 倍 / 上限加价率 20%）',
      Number(defCfg.minMarkupAmount) === 0.5 && Number(defCfg.markupCapMultiplier) === 2 && Number(defCfg.markupCapRate) === 0.2,
      `minMarkupAmount=${defCfg.minMarkupAmount} capMult=${defCfg.markupCapMultiplier} capRate=${defCfg.markupCapRate}`);
    check('预览统计「保底被上限截断」件数 ≥ 1', Number(defSum.floorDroppedCount) >= 1,
      'floorDroppedCount=' + defSum.floorDroppedCount);
    check('预览返回「取整前 → 取整后」平均加价率与保护拦下件数',
      typeof defSum.averageMarkupRateBeforeRound === 'number' && typeof defSum.averageMarkupRate === 'number' &&
      defSum.roundingSkippedCount >= 1,
      `取整前 ${(Number(defSum.averageMarkupRateBeforeRound) * 100).toFixed(2)}% → 取整后 ${(Number(defSum.averageMarkupRate) * 100).toFixed(2)}%（拦下 ${defSum.roundingSkippedCount} 件）`);

    // 自定义尾数：向上取整到 .8（不局限于 .9/.8/.7/.6，这里验 .8 档）
    const tailPreview = await req('POST', '/api/dev/pricing/bulk/preview',
      { ...scopeBase, roundMode: 'ceil', roundTail: 8, roundGuard: false }, dToken);
    const tailItem = (((tailPreview.data || {}).items) || []).find(x => x.productId === String(p1._id));
    check('自定义尾数：向上取整到 .8 → P1 = 11.80',
      !!tailItem && tailItem.newSalePrice === 11.8,
      tailItem ? 'newSalePrice=' + tailItem.newSalePrice : '未找到');

    // 不取整（精确到分）
    const nonePreview = await req('POST', '/api/dev/pricing/bulk/preview',
      { ...scopeBase, roundMode: 'none', roundGuard: true }, dToken);
    const noneItem = (((nonePreview.data || {}).items) || []).find(x => x.productId === String(p1._id));
    check('不取整（精确到分）→ P1 = 11.00',
      !!noneItem && noneItem.newSalePrice === 11,
      noneItem ? 'newSalePrice=' + noneItem.newSalePrice : '未找到');

    // ---------- 【2026-09】低价商品加价上限（保底加价额 / 上限倍数在定价页面可改） ----------
    console.log('\n[第二部分-补充] 低价商品加价上限（页面可改：保底加价额 / 上限倍数）');
    // 页面改成「上限 3 倍」：P3（成本 1）保底 1.5 被截断到 1×1.3=1.3；P1（成本 10）保底 10.5 未超上限 13 → 仍是 11
    const capOptPreview = await req('POST', '/api/dev/pricing/bulk/preview',
      { ...scopeBase, roundMode: 'none', roundGuard: false, minMarkupAmount: 0.5, markupCapMultiplier: 3 }, dToken);
    const capOptP3 = (((capOptPreview.data || {}).items) || []).find(x => x.productId === String(p3._id));
    const capOptP1 = (((capOptPreview.data || {}).items) || []).find(x => x.productId === String(p1._id));
    const capOptCfg = (capOptPreview.data && capOptPreview.data.config) || {};
    check('上限 3 倍：P3（成本 1）保底截断 → 1.30（加价 0.30 = 10%×3）',
      !!capOptP3 && capOptP3.newSalePrice === 1.3 && capOptP3.floorDropped === true,
      capOptP3 ? `newSalePrice=${capOptP3.newSalePrice} floorDropped=${capOptP3.floorDropped}` : '未找到');
    check('上限 3 倍：高价商品不受影响（P1 = 11.00）',
      !!capOptP1 && capOptP1.newSalePrice === 11 && capOptP1.floorDropped === false,
      capOptP1 ? `newSalePrice=${capOptP1.newSalePrice} floorDropped=${capOptP1.floorDropped}` : '未找到');
    check('回显页面传入的保底/上限（保底 0.5 元、上限 3 倍、上限加价率 30%）',
      Number(capOptCfg.minMarkupAmount) === 0.5 && Number(capOptCfg.markupCapMultiplier) === 3 && Number(capOptCfg.markupCapRate) === 0.3,
      `minMarkupAmount=${capOptCfg.minMarkupAmount} capMult=${capOptCfg.markupCapMultiplier} capRate=${capOptCfg.markupCapRate}`);
    // 非法上限倍数（< 1 倍）直接 400，不静默兜底
    const badCap = await req('POST', '/api/dev/pricing/bulk/preview',
      { ...scopeBase, minMarkupAmount: 0.5, markupCapMultiplier: 0.5 }, dToken);
    check('非法上限倍数（0.5 倍）被拒（400）', badCap.success === false && badCap.status === 400, badCap.message);

    const applied = await req('POST', '/api/dev/pricing/bulk/apply', scope, dToken);
    check('应用成功', applied.success === true, applied.message);

    const exp = {
      p1: dhConfig.computeBulkSalePrice(10, RATE).salePrice,     // 11.9
      p2: dhConfig.computeBulkSalePrice(37.4, RATE).salePrice,   // 41.9
      p3: dhConfig.computeBulkSalePrice(1, RATE).salePrice,      // 1.9（保底被上限截断 1.2 → 向上取整 .9）
      pCap: dhConfig.computeBulkSalePrice(100, RATE).salePrice,  // 110.9
      pUnder: dhConfig.computeBulkSalePrice(10, RATE).salePrice  // 11.9（拉回底线）
    };
    const db = {};
    for (const [k, p] of Object.entries({ p1, p2, p3, pCap, p4, pUnder })) {
      db[k] = await SupplyProduct.findById(p._id).lean();
    }
    check(`P1 卖价 = 公式值 ${exp.p1}`, db.p1.salePrice === exp.p1, '实际 ' + db.p1.salePrice);
    check(`P2 卖价 = 公式值 ${exp.p2}`, db.p2.salePrice === exp.p2, '实际 ' + db.p2.salePrice);
    check(`P3 卖价 = 公式值 ${exp.p3}（保底被加价率上限截断后取整）`, db.p3.salePrice === exp.p3, '实际 ' + db.p3.salePrice);
    check(`P4 卖价 = 公式值 ${exp.pCap}（成本线保护）`, db.pCap.salePrice === exp.pCap, '实际 ' + db.pCap.salePrice);
    check(`P7 卖价 = 公式值 ${exp.pUnder}（存量无加价被拉回）`, db.pUnder.salePrice === exp.pUnder, '实际 ' + db.pUnder.salePrice);
    check('P5 手动定价未被覆盖（仍 9.9）', db.p4.salePrice === 9.9 && db.p4.isManualPrice === true, '实际 ' + db.p4.salePrice);

    // ---------- 定完价后：商城可见 + 可下单 + 金额正确 ----------
    console.log('\n[验证] 定完价后商城展示 / 下单金额');
    list = await req('GET', `/api/supply-products?supplierId=${supplier._id}`);
    const row1 = (list.data || []).find(x => String(x._id) === String(p1._id));
    check('P1 已出现在采购商城', !!row1);
    check(`P1 商城展示卖价 = ${exp.p1}`, row1 && row1.salePrice === exp.p1, row1 ? String(row1.salePrice) : '未找到');
    check('商家视图不泄露供货价', row1 && row1.costPrice === undefined);

    const okOrder = await req('POST', '/api/purchase-orders', {
      supplierId: String(supplier._id), items: [{ productId: String(p1._id), quantity: 10 }], force: true
    }, mToken);
    check('定完价后可正常下单', okOrder.success === true, okOrder.message);
    if (okOrder.success) {
      const o = okOrder.data;
      check(`订单单价 = 卖价 ${exp.p1}`, o.items[0].unitPrice === exp.p1, 'unitPrice=' + o.items[0].unitPrice);
      check('订单总额 = 卖价×数量 = 119', o.totalAmount === +(exp.p1 * 10).toFixed(2), 'totalAmount=' + o.totalAmount);
      check('供货价总额 = 100', o.supplyAmount === 100, 'supplyAmount=' + o.supplyAmount);
      check('平台差价 = 总额 − 供货额', Math.abs(o.platformAmount - (o.totalAmount - o.supplyAmount)) < 0.001, 'platformAmount=' + o.platformAmount);
    }

    // ---------- 快照 + 回滚 ----------
    console.log('\n[验证] 一键撤销（回滚）');
    const snap = await req('GET', '/api/dev/pricing/bulk/snapshot', undefined, dToken);
    check('快照可查询（回滚按钮可用）',
      snap.success === true && !!snap.data && snap.data.affectedCount === 5,
      snap.data ? 'affectedCount=' + snap.data.affectedCount : 'null');

    const rb = await req('POST', '/api/dev/pricing/bulk/rollback', {}, dToken);
    check('回滚成功', rb.success === true, rb.message);

    const r1 = await SupplyProduct.findById(p1._id).lean();
    const r2 = await SupplyProduct.findById(p2._id).lean();
    const r3 = await SupplyProduct.findById(p3._id).lean();
    const rCap = await SupplyProduct.findById(pCap._id).lean();
    const rUnder = await SupplyProduct.findById(pUnder._id).lean();
    const r4 = await SupplyProduct.findById(p4._id).lean();
    check('P1 已恢复未定价（null）', r1.salePrice == null, 'salePrice=' + r1.salePrice);
    check('P2 已恢复未定价（null）', r2.salePrice == null, 'salePrice=' + r2.salePrice);
    check('P3 已恢复未定价（null）', r3.salePrice == null, 'salePrice=' + r3.salePrice);
    check('P4 已恢复未定价（null）', rCap.salePrice == null, 'salePrice=' + rCap.salePrice);
    check('P7 已恢复改价前的 10', rUnder.salePrice === 10, 'salePrice=' + rUnder.salePrice);
    check('P5 手动定价未受影响（仍 9.9）', r4.salePrice === 9.9, 'salePrice=' + r4.salePrice);

    list = await req('GET', `/api/supply-products?supplierId=${supplier._id}`);
    ids = (list.data || []).map(x => String(x._id));
    check('回滚后未定价商品重新从商城隐藏',
      !ids.includes(String(p1._id)) && !ids.includes(String(p2._id)) && !ids.includes(String(p3._id)));

    const snapAfter = await req('GET', '/api/dev/pricing/bulk/snapshot', undefined, dToken);
    check('回滚后快照已清空（不可二次回滚）', snapAfter.success === true && snapAfter.data === null);
  } finally {
    // ---------- 清理测试数据（仅删本次 TAG 生成的数据） ----------
    console.log('\n[清理] 删除本次测试数据');
    await SupplyProduct.deleteMany({ _id: { $in: created.products } });
    if (created.supplierId) await Supplier.deleteOne({ _id: created.supplierId });
    if (created.shopId) {
      await Setting.deleteMany({ shopId: created.shopId });
      await ShopAccount.deleteMany({ shopId: created.shopId });
      await PurchaseOrder.deleteMany({ shopId: created.shopId });
    }
    await PlatformConfig.updateOne({ key: 'platform' }, { $set: { lastBulkPricingSnapshot: null } });
    console.log('  已清理');

    console.log(`\n[合计] 通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
    await mongoose.disconnect();
    process.exit(fail > 0 ? 1 : 0);
  }
}

main().catch(async e => {
  console.error('脚本异常:', e);
  try { await mongoose.disconnect(); } catch (x) {}
  process.exit(1);
});
