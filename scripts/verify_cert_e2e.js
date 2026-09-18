// 商家认证门控端到端验证（上线加固第一批 · 第二轮）：
//   A1: 未认证 + 无地址 + 300 元 → 必须被拦截（首单直通不再放行缺地址的订单）
//   A2: 未认证 + 有地址+定位+手机号 + 300 元 → 直通成功，供应商收到推送
//   B:  未认证 + 800 元 → 409 CERT_REQUIRED，missing 拆 blocking + skippable
//   C:  已认证 + 任意金额 → 畅通
//   D:  完整闭环：被拦截 → 点进认证页（POST /api/admin/certification/submit） → 认证成功 → 重新下单成功
//   注：手机号验证默认关闭（dhConfig.REQUIRE_PHONE_VERIFIED=false），已注册手机号即视为已验证
//
// 【2026-09 上线加固调整 · 地图选点不可用的兜底方案】
//   门店定位（经纬度）从 fulfillment 降级为 optional：
//     - 详细地址是履约必需项（供应商按文字地址即可配送），经纬度缺失不再拦截下单；
//     - 提交认证时只填文字地址 → 后端用高德 Web 服务地理编码自动换算经纬度（utils/geocode.js）；
//     - 换算失败仍返回 200（不阻断），失败原因记录在 certification.geoStatus / geoMessage。
//   对应断言调整：A1/D1 只校验「详细地址」在 blocking、「门店定位」在 missingOptional；
//                 D5/D6 改为校验「缺经纬度也能认证通过 + 自动换算」。
require('dotenv').config();
const BASE = 'http://localhost:' + (process.env.PORT || 3000);
const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const SupplyProduct = require('../models/SupplyProduct');
const Setting = require('../models/Setting');
const ShopAccount = require('../models/ShopAccount');
const NotificationLog = require('../models/NotificationLog');
const dhConfig = require('../utils/dhConfig');

const PASSWORD = 'CertE2E123456';
const TAG = Date.now().toString().slice(-8);
const SUPPLIER_NAME = '认证E2E供应商' + TAG;

// 带状态码的请求封装（需区分 200 / 201 / 409 CERT_REQUIRED / 400 字段错误）
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j || {} };
}

// 供应商收到的 order_created 推送条数（webhook 未配置时记 skipped 日志，同样视为已推送）
async function supplierNotifyCount() {
  return NotificationLog.countDocuments({ event: 'order_created', content: `供应商 ${SUPPLIER_NAME}` });
}

async function main() {
  console.log('===== 认证门控 E2E 验证（路径 A1/A2/B/C/D · 上线加固第二批） =====');
  console.log(`FIRST_ORDER_NO_AUTH_LIMIT = ${dhConfig.FIRST_ORDER_NO_AUTH_LIMIT}`);
  console.log(`REQUIRE_PHONE_VERIFIED    = ${dhConfig.REQUIRE_PHONE_VERIFIED}`);
  console.log(`CERT_GATING.fulfillment   = ${dhConfig.CERT_GATING.fulfillment.join(',')}`);
  console.log(`CERT_GATING.compliance    = ${dhConfig.CERT_GATING.compliance.join(',')}`);
  console.log(`CERT_GATING.optional      = ${(dhConfig.CERT_GATING.optional || []).join(',')}\n`);

  // ---------- 环境准备 ----------
  await mongoose.connect(process.env.MONGODB_URI);
  const staleSuppliers = await Supplier.find({ name: /^认证E2E供应商/ }).select('_id').lean();
  const staleSupplierIds = staleSuppliers.map(s => s._id);
  if (staleSupplierIds.length) {
    await SupplyProduct.deleteMany({ supplierId: { $in: staleSupplierIds } });
    await Supplier.deleteMany({ _id: { $in: staleSupplierIds } });
  }
  const staleShops = await ShopAccount.find({ shopName: /^认证E2E商家/ }).select('shopId').lean();
  if (staleShops.length) {
    const staleShopIds = staleShops.map(s => s.shopId);
    await PurchaseOrder.deleteMany({ shopId: { $in: staleShopIds } });
    await Setting.deleteMany({ shopId: { $in: staleShopIds } });
    await ShopAccount.deleteMany({ shopId: { $in: staleShopIds } });
  }
  await NotificationLog.deleteMany({ content: /^供应商 认证E2E供应商/ });

  console.log('[准备] 注册测试商家 + 供应商 + 商品');
  const mReg = await req('POST', '/api/auth/merchant/register', {
    shopName: '认证E2E商家' + TAG, contactName: '测试员',
    phone: '1' + Date.now().toString().slice(-10), password: PASSWORD, confirm: PASSWORD
  });
  if (!mReg.body.success) { console.log('  商家注册失败:', mReg.body.message); return; }
  const mToken = mReg.body.data.token;
  const shopId = mReg.body.data.shopId;

  const sReg = await req('POST', '/api/auth/supplier/register', {
    name: SUPPLIER_NAME, contact: '测试员',
    phone: '1' + (Date.now() + 1).toString().slice(-10),
    password: PASSWORD, confirm: PASSWORD, categories: ['蔬菜']
  });
  if (!sReg.body.success) { console.log('  供应商注册失败:', sReg.body.message); return; }
  const sToken = sReg.body.data.token;
  const supplierId = sReg.body.data.supplierId;

  await Supplier.updateOne({ _id: supplierId }, { status: 'active', agreementSigned: true, orderEnabled: true, minOrderAmount: 300 });
  const product = await SupplyProduct.create({
    name: '认证测试菜' + TAG, category: '蔬菜', unit: 'kg',
    costPrice: 10, salePrice: 20, marketPrice: 20, supplierId, supplierName: SUPPLIER_NAME
  });
  const item = (qty) => ({ productId: String(product._id), quantity: qty });
  const orderBody = (qty) => ({ supplierId, items: [item(qty)], force: true });
  console.log(`  商家 shopId=${shopId} 供应商=${supplierId} 商品单价(卖价)=20\n`);

  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '（' + detail + '）' : ''}`);
    ok ? pass++ : fail++;
  };
  const dbg = (label, r) => { if (!r.body || r.body.success !== true) console.log(`    [debug] ${label} HTTP ${r.status} →`, JSON.stringify(r.body).slice(0, 300)); };

  // ============================================================
  // 路径 A1：未认证 + 完全无资料 + 300 元 → 必须被拦截（首单直通不再放行）
  // ============================================================
  console.log(`\n===== 路径 A1：未认证商家（无地址无门头照无定位）+ ${15 * 20} 元（≤ ${dhConfig.FIRST_ORDER_NO_AUTH_LIMIT}）必须被拦截 =====`);
  const stA1 = await req('GET', `/api/admin/certification/status?amount=300`, null, mToken);
  check('A1-0 GET 状态: 影响放行的缺失项 >= 3（地址 + 门头照 + 营业执照）', (stA1.body.data?.missing || []).length >= 3,
    `missing=${(stA1.body.data?.missing || []).join('、')}`);
  check('A1-0 状态: blocking 只含 详细地址（定位已降为选填）',
    (stA1.body.data?.missingBlocking || []).includes('门店详细地址') && !(stA1.body.data?.missingBlocking || []).includes('门店定位'),
    `blocking=${(stA1.body.data?.missingBlocking || []).join('、')}`);
  check('A1-0 状态: 门店定位 落在 missingOptional（不拦截）', (stA1.body.data?.missingOptional || []).includes('门店定位'),
    `optional=${(stA1.body.data?.missingOptional || []).join('、')}`);
  const a1Create = await req('POST', '/api/purchase-orders', orderBody(15), mToken);
  check('A1 POST / 返回 409 CERT_REQUIRED', a1Create.status === 409 && a1Create.body.code === 'CERT_REQUIRED',
    `HTTP ${a1Create.status} code=${a1Create.body.code}`);
  check('A1 missingBlocking 含 门店详细地址', (a1Create.body.data?.missingBlocking || []).includes('门店详细地址'),
    `blocking=${(a1Create.body.data?.missingBlocking || []).join('、')}`);
  check('A1 missingSkippable 含 营业执照（合规可暂缓）', (a1Create.body.data?.missingSkippable || []).includes('营业执照'),
    `skippable=${(a1Create.body.data?.missingSkippable || []).join('、')}`);
  const a1OrderId = a1Create.body.data?.orderId;
  const a1Db = await PurchaseOrder.findById(a1OrderId).lean();
  check('A1 订单挂起: 待支付/unpaid', a1Db?.status === '待支付' && a1Db?.payStatus === 'unpaid');
  check('A1 未推送供应商', !a1Db?.supplierNotifiedAt);
  const notifyA1 = await supplierNotifyCount();
  check('A1 供应商推送日志 0 条', notifyA1 === 0, `推送 ${notifyA1} 条`);

  // ============================================================
  // 路径 A2：未认证 + 有地址+定位+手机号 + 300 元 → 直通成功，供应商收到推送
  // （手机号验证 REQUIRE_PHONE_VERIFIED=false 默认即视为已通过，所以填地址+定位就直通）
  // ============================================================
  console.log(`\n===== 路径 A2：未认证商家（已补履约资料：地址+定位） + ${15 * 20} 元（≤ ${dhConfig.FIRST_ORDER_NO_AUTH_LIMIT}）首单直通 =====`);
  await Setting.updateOne({ shopId }, {
    shopAddress: '测试路 88 号',
    shopLongitude: 117.736,
    shopLatitude: 36.961
  });
  const stA2 = await req('GET', `/api/admin/certification/status?amount=300`, null, mToken);
  check('A2-0 状态: missingBlocking 空（仅缺合规项）', (stA2.body.data?.missingBlocking || []).length === 0,
    `blocking=${(stA2.body.data?.missingBlocking || []).join('、') || '空'}`);
  check('A2-0 gate 判定 first_order 直通', stA2.body.data?.gate?.via === 'first_order',
    `via=${stA2.body.data?.gate?.via}`);

  const a2Create = await req('POST', '/api/purchase-orders', orderBody(15), mToken);
  check('A2 POST / 下单成功(200/201)', (a2Create.status === 200 || a2Create.status === 201) && a2Create.body.success === true, `HTTP ${a2Create.status}`);
  const orderA2 = a2Create.body.data || {};
  const payA2 = await req('POST', `/api/purchase-orders/${orderA2._id}/pay`, {}, mToken);
  check('A2 POST /:id/pay 支付成功', payA2.status === 200 && payA2.body.success === true, `HTTP ${payA2.status}`);
  const dbA2 = await PurchaseOrder.findById(orderA2._id).lean();
  check('A2 订单落库: 待确认/paid', dbA2?.status === '待确认' && dbA2?.payStatus === 'paid',
    `status=${dbA2?.status} payStatus=${dbA2?.payStatus}`);
  check('A2 供应商已推送(supplierNotifiedAt)', !!dbA2?.supplierNotifiedAt);
  const notifyA2 = await supplierNotifyCount();
  check('A2 供应商收到 order_created 推送', notifyA2 === 1, `推送 ${notifyA2} 条`);

  // ============================================================
  // 路径 B：未认证 + 800 元 → 409 CERT_REQUIRED（首单已用，缺资料被拦）
  // ============================================================
  console.log(`\n===== 路径 B：未认证商家（首单直通已用），${40 * 20} 元 > ${dhConfig.FIRST_ORDER_NO_AUTH_LIMIT} 必须被拦截 =====`);
  const bCreate = await req('POST', '/api/purchase-orders', orderBody(40), mToken);
  check('B1 POST / 返回 409 CERT_REQUIRED', bCreate.status === 409 && bCreate.body.code === 'CERT_REQUIRED',
    `HTTP ${bCreate.status} code=${bCreate.body.code}`);
  check('B2 missingBlocking 与 missingSkippable 分别返回', Array.isArray(bCreate.body.data?.missingBlocking) && Array.isArray(bCreate.body.data?.missingSkippable),
    `blocking=${(bCreate.body.data?.missingBlocking || []).join('、')} skippable=${(bCreate.body.data?.missingSkippable || []).join('、')}`);
  const orderBId = bCreate.body.data?.orderId;
  const dbB1 = await PurchaseOrder.findById(orderBId).lean();
  check('B3 订单挂起: 待支付/unpaid', dbB1?.status === '待支付' && dbB1?.payStatus === 'unpaid');
  check('B4 未推送供应商', !dbB1?.supplierNotifiedAt);

  const payB = await req('POST', `/api/purchase-orders/${orderBId}/pay`, {}, mToken);
  check('B5 支付接口二次复核同样 409', payB.status === 409 && payB.body.code === 'CERT_REQUIRED', `HTTP ${payB.status}`);
  const notifyB = await supplierNotifyCount();
  check('B6 供应商推送日志无新增', notifyB === 1, `推送仍为 ${notifyB} 条`);

  const stB = await req('GET', `/api/admin/certification/status?amount=800`, null, mToken);
  check('B7 认证状态: firstOrder.used=true 且 gate 拦截', stB.body.data?.firstOrder?.used === true && stB.body.data?.gate?.pass === false,
    `gate.via=${stB.body.data?.gate?.via}`);

  // ============================================================
  // 路径 C：已认证 + 任意金额 → 畅通（直接 setStatus approved 模拟「认证完成后」）
  // ============================================================
  console.log(`\n===== 路径 C：已认证（approved）后，${40 * 20} 元畅通 =====`);
  await Setting.updateOne({ shopId }, { 'certification.status': 'approved', 'certification.submittedAt': new Date(), 'certification.reviewedAt': new Date() });
  const stC = await req('GET', `/api/admin/certification/status?amount=800`, null, mToken);
  check('C1 认证状态 certified=true', stC.body.data?.certified === true);
  check('C1 missingSkippable 与 missingBlocking 字段存在', Array.isArray(stC.body.data?.missingBlocking) && Array.isArray(stC.body.data?.missingSkippable));
  check('C1 gate 判定 certified（via=certified）', stC.body.data?.gate?.via === 'certified',
    `via=${stC.body.data?.gate?.via}`);

  const cCreate = await req('POST', '/api/purchase-orders', orderBody(40), mToken);
  check('C2 POST / 下单成功(200/201)', (cCreate.status === 200 || cCreate.status === 201) && cCreate.body.success === true, `HTTP ${cCreate.status}`);
  const orderC = cCreate.body.data || {};
  const payC = await req('POST', `/api/purchase-orders/${orderC._id}/pay`, {}, mToken);
  check('C3 POST /:id/pay 支付成功', payC.status === 200 && payC.body.success === true, `HTTP ${payC.status}`);
  const dbC = await PurchaseOrder.findById(orderC._id).lean();
  check('C4 订单落库: 待确认/paid', dbC?.status === '待确认' && dbC?.payStatus === 'paid');
  const notifyC = await supplierNotifyCount();
  check('C5 供应商收到推送', notifyC === 2, `推送 ${notifyC} 条`);

  const confNo = await req('POST', `/api/purchase-orders/${orderC._id}/confirm`, {}, sToken);
  check('C6 确认不带 contactConfirmed 被拒(400)', confNo.status === 400, `HTTP ${confNo.status}`);
  const confYes = await req('POST', `/api/purchase-orders/${orderC._id}/confirm`, { contactConfirmed: true }, sToken);
  check('C7 带 contactConfirmed=true 确认成功', confYes.status === 200 && confYes.body.success === true);

  // ============================================================
  // 路径 D：完整闭环（被拦截 → POST /api/admin/certification/submit → 重新下单成功）
  // 先重置商家状态为「未认证 + 无资料」
  // ============================================================
  console.log(`\n===== 路径 D：完整闭环（被拦 → 走提交接口认证 → 重新下单成功） =====`);
  await Setting.updateOne({ shopId }, {
    shopAddress: '', shopLongitude: null, shopLatitude: null, storeFrontPhoto: '',
    streetViewPhoto: '',
    'certification.status': 'none',
    'certification.businessLicense': '',
    'certification.submittedAt': null, 'certification.reviewedAt': null,
    'certification.geoStatus': 'none', 'certification.geoFrom': '', 'certification.geoMessage': '',
    'certification.geoAttemptedAt': null
  });
  // 清理历史订单，确保 firstOrder.used 重新可用
  await PurchaseOrder.deleteMany({ shopId, status: '待支付' });

  // D1：先下 300 元单 → 必被拦（履约资料全缺）
  const d1Create = await req('POST', '/api/purchase-orders', orderBody(15), mToken);
  check('D1 重新下 300 元 → 409 CERT_REQUIRED', d1Create.status === 409 && d1Create.body.code === 'CERT_REQUIRED',
    `HTTP ${d1Create.status} code=${d1Create.body.code}`);
  check('D1 missingBlocking 含 详细地址、不含 门店定位（定位为选填项）',
    (d1Create.body.data?.missingBlocking || []).includes('门店详细地址') && !(d1Create.body.data?.missingBlocking || []).includes('门店定位'),
    `blocking=${(d1Create.body.data?.missingBlocking || []).join('、')}`);

  // D2：商家走提交接口（模拟在 admin.html / uni-app 端点开认证 modal 提交）
  // 入参：完整履约 + 合规资料；提交即认证通过
  const d2Submit = await req('POST', '/api/admin/certification/submit', {
    shopAddress: '测试路 88 号',
    shopLongitude: 117.736,
    shopLatitude: 36.961,
    storeFrontPhoto: '/uploads/test_front.jpg',
    businessLicense: '/uploads/test_license.jpg'
  }, mToken);
  check('D2 提交认证 200', d2Submit.status === 200 && d2Submit.body.success === true, `HTTP ${d2Submit.status} msg=${d2Submit.body.message}`);
  check('D2 提交后 certified=true', d2Submit.body.data?.certified === true);
  check('D2 提交后 status=approved', d2Submit.body.data?.status === 'approved');

  // D3：验证库内确实落库 approved
  const dbSetting = await Setting.findOne({ shopId }).lean();
  check('D3 数据库 Setting.certification.status=approved', dbSetting?.certification?.status === 'approved');
  check('D3 数据库 reviewedAt/submittedAt 写入',
    !!dbSetting?.certification?.submittedAt && !!dbSetting?.certification?.reviewedAt);

  // D4：再下 800 元 → 应畅通
  const d4Create = await req('POST', '/api/purchase-orders', orderBody(40), mToken);
  check('D4 认证后 800 元下单成功', (d4Create.status === 200 || d4Create.status === 201) && d4Create.body.success === true, `HTTP ${d4Create.status}`);
  const orderD = d4Create.body.data || {};
  const payD = await req('POST', `/api/purchase-orders/${orderD._id}/pay`, {}, mToken);
  check('D4 支付成功', payD.status === 200 && payD.body.success === true, `HTTP ${payD.status}`);
  const dbD = await PurchaseOrder.findById(orderD._id).lean();
  check('D4 订单落库: 待确认/paid', dbD?.status === '待确认' && dbD?.payStatus === 'paid');
  const notifyD = await supplierNotifyCount();
  check('D4 供应商收到推送', notifyD === 3, `推送 ${notifyD} 条`);

  // ============================================================
  // D5 / D6：经纬度改为「选填 + 后端自动地理编码换算」
  //   D5：只填文字地址（真实可识别地址） → 认证通过 且 经纬度被后端自动填上
  //   D6：只填文字地址（无法识别的地址） → 认证通过（不阻断）且 记录换算失败
  // ============================================================
  console.log('\n===== D5/D6：只填文字地址、不填经纬度（自动地理编码兜底） =====');
  // 清掉经纬度，确保是「后端自动换算」而不是沿用旧值
  await Setting.updateOne({ shopId }, {
    shopLongitude: null, shopLatitude: null,
    'certification.geoStatus': 'none', 'certification.geoFrom': '', 'certification.geoMessage': ''
  });

  const REAL_ADDR = '山东省泰安市泰山区东岳大街1号';
  const d5 = await req('POST', '/api/admin/certification/submit', {
    shopAddress: REAL_ADDR,
    // 经纬度故意不给
    storeFrontPhoto: '/uploads/test_front.jpg',
    businessLicense: '/uploads/test_license.jpg'
  }, mToken);
  const d5Geo = d5.body.data?.geoResult || null;
  check('D5 只填地址、不填经纬度 → 200 认证通过（不阻断）',
    d5.status === 200 && d5.body.success === true && d5.body.data?.certified === true,
    `HTTP ${d5.status} msg=${d5.body.message}`);
  const dbD5 = await Setting.findOne({ shopId }).select('shopLongitude shopLatitude certification').lean();
  const d5Ok = d5Geo && d5Geo.ok;
  check('D5 后端自动换算经纬度成功（或 Key 未配置时明确记录失败）',
    d5Ok
      ? (dbD5?.shopLongitude != null && dbD5?.shopLatitude != null && dbD5?.certification?.geoStatus === 'ok')
      : (dbD5?.certification?.geoStatus === 'failed' && !!dbD5?.certification?.geoMessage),
    d5Ok
      ? `lng=${dbD5?.shopLongitude} lat=${dbD5?.shopLatitude} geoStatus=${dbD5?.certification?.geoStatus}`
      : `geoStatus=${dbD5?.certification?.geoStatus} reason=${dbD5?.certification?.geoMessage}`);
  check('D6 换算失败也不影响认证状态 approved', dbD5?.certification?.status === 'approved',
    `status=${dbD5?.certification?.status}`);

  // D6：会让高德返回 ENGINE_RESPONSE_DATA_ERROR 的地址（实测确认无法换算）→ 必须仍然 200，
  //     经纬度保持为空、失败原因记录在 certification.geoMessage
  await Setting.updateOne({ shopId }, {
    shopLongitude: null, shopLatitude: null,
    'certification.geoStatus': 'none', 'certification.geoFrom': '', 'certification.geoMessage': ''
  });
  const d6 = await req('POST', '/api/admin/certification/submit', {
    shopAddress: '测试测试测试测试测试',
    storeFrontPhoto: '/uploads/test_front.jpg',
    businessLicense: '/uploads/test_license.jpg'
  }, mToken);
  const dbD6 = await Setting.findOne({ shopId }).select('shopLongitude shopLatitude certification').lean();
  check('D6 换算失败 → 仍 200 认证通过（技术原因不卡商家）',
    d6.status === 200 && d6.body.success === true && d6.body.data?.certified === true,
    `HTTP ${d6.status} msg=${d6.body.message}`);
  check('D6 换算失败被记录（geoStatus=failed + geoMessage）且经纬度留空',
    dbD6?.certification?.geoStatus === 'failed' && !!dbD6?.certification?.geoMessage
      && dbD6?.shopLongitude == null && dbD6?.shopLatitude == null,
    `geoStatus=${dbD6?.certification?.geoStatus} reason=${dbD6?.certification?.geoMessage}`);
  check('D6 换算失败的经纬度不影响下单（认证状态仍 approved）',
    dbD6?.certification?.status === 'approved', `status=${dbD6?.certification?.status}`);

  // D7：合规项缺失仍必须 400（合规项未被本次改动影响）
  const d7MissingLicense = await req('POST', '/api/admin/certification/submit', {
    shopAddress: '测试路 88 号',
    storeFrontPhoto: '/uploads/test_front.jpg'
    // 营业执照故意不给
  }, mToken);
  check('D7 缺营业执照 → 400 MISSING_COMPLIANCE', d7MissingLicense.status === 400 && d7MissingLicense.body.code === 'MISSING_COMPLIANCE',
    `HTTP ${d7MissingLicense.status} code=${d7MissingLicense.body.code}`);

  // D8：缺详细地址仍必须 400（详细地址是履约必需项，未被削弱）
  const d8MissingAddr = await req('POST', '/api/admin/certification/submit', {
    storeFrontPhoto: '/uploads/test_front.jpg',
    businessLicense: '/uploads/test_license.jpg'
  }, mToken);
  check('D8 缺详细地址 → 400 MISSING_BLOCKING', d8MissingAddr.status === 400 && d8MissingAddr.body.code === 'MISSING_BLOCKING',
    `HTTP ${d8MissingAddr.status} code=${d8MissingAddr.body.code}`);

  // ============================================================
  // D9：下单门控不因「经纬度缺失」误拦（详细地址在，则首单可直通）
  // ============================================================
  console.log('\n===== D9：经纬度缺失但详细地址在 → 下单门控不误拦截 =====');
  await Setting.updateOne({ shopId }, {
    shopAddress: '测试路 88 号',
    shopLongitude: null, shopLatitude: null,
    'certification.status': 'none',
    'certification.businessLicense': '/uploads/test_license.jpg',
    storeFrontPhoto: '/uploads/test_front.jpg',
    'certification.geoStatus': 'failed', 'certification.geoFrom': '测试路 88 号'
  });
  await PurchaseOrder.deleteMany({ shopId });
  const stD9 = await req('GET', `/api/admin/certification/status?amount=300`, null, mToken);
  check('D9 状态: blocking 为空（只有地址必需，已满足）', (stD9.body.data?.missingBlocking || []).length === 0,
    `blocking=${(stD9.body.data?.missingBlocking || []).join('、') || '空'}`);
  const d9Create = await req('POST', '/api/purchase-orders', orderBody(15), mToken);
  check('D9 经纬度缺失 → 300 元首单仍可直通（不再误拦）',
    (d9Create.status === 200 || d9Create.status === 201) && d9Create.body.success === true,
    `HTTP ${d9Create.status} code=${d9Create.body.code || '-'}`);

  // ============================================================
  // E：店铺设置保存时的定位自动换算兜底（PUT /api/settings）
  //    E1 只填地址、库内无定位 → 保存成功 + 自动换算并落库
  //    E2 换算失败 → 保存仍成功（地址照常保存），经纬度留空 + 记录 failed
  //    E3 商家已带经纬度 → 直接用商家值、不触发换算（不浪费配额）
  // ============================================================
  console.log('\n===== E：店铺设置保存的定位自动换算兜底 =====');
  await Setting.updateOne({ shopId }, {
    shopLongitude: null, shopLatitude: null,
    'certification.geoStatus': 'none', 'certification.geoFrom': '', 'certification.geoMessage': ''
  });
  const e1 = await req('PUT', '/api/settings', { shopAddress: '山东省泰安市泰山区东岳大街1号' }, mToken);
  const dbE1 = await Setting.findOne({ shopId }).select('shopLongitude shopLatitude certification').lean();
  check('E1 PUT /api/settings 只填地址 → 保存成功', e1.status === 200 && e1.body.success === true, `HTTP ${e1.status}`);
  check('E1 地址 → 经纬度自动换算并落库',
    dbE1?.shopLongitude != null && dbE1?.shopLatitude != null && dbE1?.certification?.geoStatus === 'ok',
    `lng=${dbE1?.shopLongitude} lat=${dbE1?.shopLatitude} geoStatus=${dbE1?.certification?.geoStatus}`);

  await Setting.updateOne({ shopId }, {
    shopLongitude: null, shopLatitude: null,
    'certification.geoStatus': 'none', 'certification.geoFrom': ''
  });
  const e2 = await req('PUT', '/api/settings', { shopAddress: '测试测试测试测试测试' }, mToken);
  const dbE2 = await Setting.findOne({ shopId }).select('shopAddress shopLongitude shopLatitude certification').lean();
  check('E2 换算失败 → 保存仍成功（不阻断，地址照常落库）',
    e2.status === 200 && e2.body.success === true && dbE2?.shopAddress === '测试测试测试测试测试',
    `HTTP ${e2.status} addr=${dbE2?.shopAddress}`);
  check('E2 换算失败被记录且经纬度留空',
    dbE2?.certification?.geoStatus === 'failed' && dbE2?.shopLongitude == null && dbE2?.shopLatitude == null,
    `geoStatus=${dbE2?.certification?.geoStatus} reason=${dbE2?.certification?.geoMessage}`);

  const e3 = await req('PUT', '/api/settings', {
    shopAddress: '山东省泰安市泰山区东岳大街1号',
    shopLongitude: 118.123456,
    shopLatitude: 36.654321
  }, mToken);
  const dbE3 = await Setting.findOne({ shopId }).select('shopLongitude shopLatitude').lean();
  check('E3 商家自带经纬度 → 直接用商家值、不触发换算',
    e3.status === 200 && !e3.body.geo
      && Math.abs(Number(dbE3?.shopLongitude) - 118.123456) < 1e-6
      && Math.abs(Number(dbE3?.shopLatitude) - 36.654321) < 1e-6,
    `lng=${dbE3?.shopLongitude} lat=${dbE3?.shopLatitude} geo=${JSON.stringify(e3.body.geo)}`);

  // ---------- 汇总与清理 ----------
  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);

  console.log('\n[清理] 删除测试数据');
  await PurchaseOrder.deleteMany({ shopId });
  await SupplyProduct.deleteMany({ supplierId });
  await Supplier.deleteOne({ _id: supplierId });
  await ShopAccount.deleteOne({ shopId });
  await Setting.deleteOne({ shopId });
  await NotificationLog.deleteMany({ content: `供应商 ${SUPPLIER_NAME}` });
  console.log('  已清理（订单/商品/供应商/商家账号/设置/通知日志）');
  await mongoose.disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('异常:', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});