// 支付资金流（supplier_first / platform_first）+ 供应商进件 + 人工分账降级 端到端验证（隔离测试，用完即删）
// 运行前置：1) 已启动后端（默认 http://localhost:3000）2) .env 配好 MONGODB_URI / DEV_ADMIN_* / TEST_SUPPLIER_PASSWORD
// 覆盖链路：下单 → 支付成功回调 → 分账（mock）→ 供应商收款
//   A) 供应商未进件 → 订单「待人工分账」（不阻断）→ 开发者后台可见 → 标记结算 → 分账成功
//   B) 供应商进件（提交 → 驳回 → 重新提交 → 通过并录入特约商户号），敏感字段密文落库校验
//   C) 已进件供应商 → 钱进供应商（supplier_first）→ 分账成功，平台抽加价部分
//   D) 切换开关 → 钱进平台（platform_first）→ 同一批订单走不同分支，金额口径不变
//   E) 支付模式开关：mock 演示模式拒绝真实接口；切 wechat 后走真实分支（凭证未配置则明确报错）
require('dotenv').config();
const mongoose = require('mongoose');
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const payRuntime = require('../utils/payRuntime');
const paymentProvider = require('../utils/paymentProvider');
const cryptoBox = require('../utils/cryptoBox');

const DEV_ADMIN_USER = process.env.DEV_ADMIN_USER;
const DEV_ADMIN_PASSWORD = process.env.DEV_ADMIN_PASSWORD;
// 测试供应商密码：优先取 .env，未配置时用与既有脚本一致的兜底值
const TEST_SUPPLIER_PASSWORD = process.env.TEST_SUPPLIER_PASSWORD || 'Test@Test123456';

let pass = 0;
let fail = 0;

function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' → ' + extra : ''}`); }
}

async function req(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.json();
}
const post = (p, b, t) => req('POST', p, b, t);
const put = (p, b, t) => req('PUT', p, b, t);
const get = (p, t) => req('GET', p, undefined, t);

// 造一笔「待支付」订单（供货价 30 ×5 = 150，卖价 36 ×5 = 180，平台加价 30）
async function createDraftOrder(supplierId, tag) {
  return PurchaseOrder.create({
    orderNo: 'PAYFLOW' + tag + Date.now() + Math.floor(Math.random() * 1000),
    shopId: 'shop_payflow_test',
    shopName: '资金流测试店',
    supplierId,
    items: [{
      productId: new mongoose.Types.ObjectId(),
      name: '测试五花肉', category: '肉类', quantity: 5,
      unitPrice: 36, totalPrice: 180, supplyPrice: 30, salePrice: 36,
      supplyLineTotal: 150, saleLineTotal: 180
    }],
    supplyAmount: 150,
    totalAmount: 180,
    actualPayAmount: 180,
    status: '待支付',
    payStatus: 'unpaid'
  });
}

// 走真实支付回调入口（mock 渠道：handleCallback 后落账 + 发起分账）
async function payViaCallback(order, tag) {
  const r = await post(`/api/purchase-orders/${order._id}/split/callback`, {
    payNo: 'MOCKPAY' + tag + Date.now(),
    orderNo: order.orderNo,
    status: 'paid',
    transactionId: 'MOCKTX' + tag + Date.now(),
    amountFen: 18000
  });
  return r;
}

async function main() {
  console.log('===== 支付资金流 / 供应商进件 / 人工分账 端到端验证 =====\n');

  // ---------- 0. 准备账号 ----------
  const phone = '1' + Date.now().toString().slice(-10);
  const reg = await post('/api/auth/supplier/register', {
    name: '资金流测试供应商', contact: '测试员', phone, password: TEST_SUPPLIER_PASSWORD,
    confirm: TEST_SUPPLIER_PASSWORD, categories: ['肉类']
  });
  if (!reg.success) { console.log('供应商注册失败:', reg.message); process.exit(1); }
  const sToken = reg.data.token;
  const supplierId = reg.data.supplierId;
  const dLogin = await post('/api/auth/dev/login', { username: DEV_ADMIN_USER, password: DEV_ADMIN_PASSWORD });
  if (!dLogin.success) { console.log('开发者登录失败:', dLogin.message); process.exit(1); }
  const dToken = dLogin.data.token;
  // 进件提交前置：供应商需已激活（status=active）。先经开发者审核通过（模拟正常入驻流程）
  const approveSupplier = await put(`/api/dev/suppliers/${supplierId}/approve`, {}, dToken);
  if (!approveSupplier.success) { console.log('供应商审核通过失败:', approveSupplier.message); process.exit(1); }
  console.log('准备完成：supplierId=', supplierId, '\n');

  await mongoose.connect(process.env.MONGODB_URI);
  await payRuntime.setPayMode('mock');                  // 全程 mock：不会真实扣款/打款
  await payRuntime.setPaymentFlowMode('supplier_first'); // 默认资金流

  // ---------- A. 未进件 → 待人工分账（不阻断业务） ----------
  console.log('[A] 供应商未进件：下单 → 支付成功 → 应转「待人工分账」');
  const orderA = await createDraftOrder(supplierId, 'A');
  const cbA = await payViaCallback(orderA, 'A');
  ok('支付回调成功', cbA.success === true, cbA.message);
  let oA = await PurchaseOrder.findById(orderA._id);
  ok('订单已支付（不阻断下单）', oA.payStatus === 'paid' && oA.status === '待确认', `payStatus=${oA.payStatus} status=${oA.status}`);
  ok('分账状态 = 待人工分账', oA.splitStatus === '待人工分账', oA.splitStatus);
  ok('manualSettlement 标记为 true', oA.manualSettlement === true);
  ok('降级原因已记录', /未完成微信进件/.test(oA.manualSettleReason || ''), oA.manualSettleReason);
  ok('金额口径不变：供货价150归供应商', oA.supplierShare === 150, String(oA.supplierShare));
  ok('金额口径不变：加价30归平台', oA.platformShare === 30, String(oA.platformShare));

  const msList = await get('/api/dev/manual-settlements', dToken);
  ok('开发者后台「待人工分账」列表可见该单', msList.success && msList.data.some(x => String(x._id) === String(oA._id) && x.supplierShare === 150));
  const settle = await post(`/api/dev/manual-settlements/${oA._id}/settle`, {}, dToken);
  ok('标记人工结算成功', settle.success === true, settle.message);
  oA = await PurchaseOrder.findById(orderA._id);
  ok('结算后分账状态 = 分账成功', oA.splitStatus === '分账成功', oA.splitStatus);
  ok('人工结算时间已记录', !!oA.manualSettledAt);

  // ---------- B. 供应商进件流程（提交 → 驳回 → 重提 → 通过） ----------
  console.log('\n[B] 供应商微信进件流程（敏感字段加密 + 状态机 + 人工录入特约商户号）');
  const BANK_NO = '6222020200112345678';
  const obBody = {
    businessLicenseUrl: '/uploads/test_license.jpg',
    legalPerson: '张三',
    idCardFrontUrl: '/uploads/test_id_front.jpg',
    idCardBackUrl: '/uploads/test_id_back.jpg',
    bankAccountName: '资金流测试供应商有限公司',
    bankAccountNo: BANK_NO,
    bankName: '中国工商银行',
    bankBranch: '邹平支行',
    contactName: '测试员',
    contactPhone: phone,
    category: '肉类',
    address: '山东省滨州市邹平市测试路 1 号'
  };
  const sub1 = await post('/api/supplier/wechat-onboarding/submit', obBody, sToken);
  ok('进件资料提交成功（状态审核中）', sub1.success && sub1.data.status === 'pending', sub1.message);

  let supDb = await Supplier.findById(supplierId);
  ok('银行账号密文落库（enc:v1: 前缀）', String(supDb.wechatOnboarding.bankAccountNoEnc).startsWith('enc:v1:'));
  ok('库中不含银行账号明文', !String(supDb.wechatOnboarding.bankAccountNoEnc).includes(BANK_NO));
  ok('解密回原文一致', cryptoBox.decrypt(supDb.wechatOnboarding.bankAccountNoEnc) === BANK_NO);
  const obGet = await get('/api/supplier/wechat-onboarding', sToken);
  ok('供应商端查询银行账号已脱敏', obGet.data.bankAccountNoMasked === cryptoBox.maskBankAccount(BANK_NO), obGet.data.bankAccountNoMasked);
  const dupSubmit = await post('/api/supplier/wechat-onboarding/submit', obBody, sToken);
  ok('审核中重复提交被拒', dupSubmit.success === false, dupSubmit.message);

  const rej = await put(`/api/dev/suppliers/${supplierId}/wechat-onboarding/review`, { action: 'reject', reason: '营业执照照片不清晰' }, dToken);
  ok('开发者驳回进件成功', rej.success === true, rej.message);
  const obRej = await get('/api/supplier/wechat-onboarding', sToken);
  ok('供应商端看到驳回原因', obRej.data.status === 'rejected' && /不清晰/.test(obRej.data.rejectReason));
  const sub2 = await post('/api/supplier/wechat-onboarding/submit', obBody, sToken);
  ok('被驳回后可重新提交', sub2.success === true, sub2.message);

  const badApprove = await put(`/api/dev/suppliers/${supplierId}/wechat-onboarding/review`, { action: 'approve', subMchId: 'abc' }, dToken);
  ok('非法特约商户号被拒', badApprove.success === false, badApprove.message);
  const SUB_MCHID = '1900001234';
  const appr = await put(`/api/dev/suppliers/${supplierId}/wechat-onboarding/review`, { action: 'approve', subMchId: SUB_MCHID }, dToken);
  ok('开发者通过并录入特约商户号', appr.success === true, appr.message);
  supDb = await Supplier.findById(supplierId);
  ok('供应商 wechatSubMchId 已写入', supDb.wechatSubMchId === SUB_MCHID);
  ok('进件状态 = approved', supDb.wechatOnboarding.status === 'approved');

  // ---------- C. 已进件 → 钱进供应商（supplier_first） ----------
  console.log('\n[C] 已进件供应商 · 钱进供应商模式：货款进供应商账户，平台分账抽加价');
  const orderC = await createDraftOrder(supplierId, 'C');
  const cbC = await payViaCallback(orderC, 'C');
  ok('支付回调成功', cbC.success === true, cbC.message);
  let oC = await PurchaseOrder.findById(orderC._id);
  ok('分账成功（走渠道分账）', oC.splitStatus === '分账成功', `${oC.splitStatus} / ${oC.splitError}`);
  ok('资金流快照 = supplier_first', oC.paymentFlowMode === 'supplier_first', oC.paymentFlowMode);
  ok('收款方（供应商特约商户号）已快照', oC.supplierWechatSubMchId === SUB_MCHID, oC.supplierWechatSubMchId);
  ok('供应商实得 150（供货价一分不少）', oC.supplierShare === 150, String(oC.supplierShare));
  ok('平台实得 30（加价部分）', oC.platformShare === 30, String(oC.platformShare));
  ok('分账日志标注「钱进供应商」', (oC.splitLogs || []).some(l => /钱进供应商/.test(l.message || '')));
  const mockResC = await paymentProvider.applyProfitSharing({ totalAmount: 180, actualPayAmount: 180, items: oC.items }, {
    supplierShareFen: 15000, platformShareFen: 3000, supplierMchId: SUB_MCHID, platformMchId: 'SP_MCH_TEST'
  });
  ok('mock 分账接收方 = 平台（抽加价 30 元）', mockResC.receivers.length === 1 && mockResC.receivers[0].role === 'platform' && mockResC.receivers[0].amountFen === 3000);
  ok('mock 收款方 = 供应商特约商户号', mockResC.payeeMchId === SUB_MCHID, mockResC.payeeMchId);

  // ---------- D. 开关切换 → 钱进平台（platform_first） ----------
  console.log('\n[D] 切换开关 platform_first：同一订单走不同资金分支（金额口径不变）');
  const sw = await put('/api/dev/config', { paymentFlowMode: 'platform_first', confirmFlowSwitch: true }, dToken);
  ok('开发者后台切换资金流成功', sw.success && sw.data.paymentFlowMode === 'platform_first', JSON.stringify(sw.data || sw.message));
  // 服务端运行时已生效：重新拉取 /api/dev/config（读的是服务端 payRuntime 缓存，证明无需重启）
  const cfgSrv = await get('/api/dev/config', dToken);
  ok('服务端运行时已生效（无需重启）', cfgSrv.success && cfgSrv.data.paymentFlowMode === 'platform_first', cfgSrv.data && cfgSrv.data.paymentFlowMode);
  // 本脚本为独立进程：同步本进程缓存后，mock 分支才会按 platform_first 构造（用于验证分支逻辑）
  await payRuntime.setPaymentFlowMode('platform_first');

  const orderD = await createDraftOrder(supplierId, 'D');
  await payViaCallback(orderD, 'D');
  const oD = await PurchaseOrder.findById(orderD._id);
  ok('新订单分账成功', oD.splitStatus === '分账成功', `${oD.splitStatus} / ${oD.splitError}`);
  ok('资金流快照 = platform_first', oD.paymentFlowMode === 'platform_first', oD.paymentFlowMode);
  ok('分账日志标注「钱进平台」', (oD.splitLogs || []).some(l => /钱进平台/.test(l.message || '')));
  ok('金额口径依旧：供应商 150 / 平台 30', oD.supplierShare === 150 && oD.platformShare === 30);
  const mockResD = await paymentProvider.applyProfitSharing({ totalAmount: 180, actualPayAmount: 180, items: oD.items }, {
    supplierShareFen: 15000, platformShareFen: 3000, supplierMchId: SUB_MCHID, platformMchId: 'SP_MCH_TEST'
  });
  ok('platform_first：mock 收款方 = 平台', mockResD.payeeMchId === 'SP_MCH_TEST', mockResD.payeeMchId);
  ok('platform_first：mock 分账接收方 = 供应商（供货价 150 元）', mockResD.receivers[0].role === 'supplier' && mockResD.receivers[0].amountFen === 15000);
  const swBack = await put('/api/dev/config', { paymentFlowMode: 'supplier_first' }, dToken);
  ok('切回 supplier_first 成功', swBack.success && swBack.data.paymentFlowMode === 'supplier_first');
  await payRuntime.setPaymentFlowMode('supplier_first'); // 同步本进程缓存

  // ---------- E. 支付模式开关（mock / wechat） ----------
  console.log('\n[E] 支付模式开关：演示模式禁止真实接口；切 wechat 走真实分支');
  const pm = await get('/api/pay-mode');
  ok('公共接口 /api/pay-mode 返回演示模式', pm.success && pm.data.payMode === 'mock' && pm.data.demo === true);
  ok('mock 模式下 provider = mock', paymentProvider.providerType() === 'mock');
  let demoBlocked = '';
  try { paymentProvider.assertRealProvider(); } catch (e) { demoBlocked = e.code || e.message; }
  ok('演示模式下调用真实微信接口被直接拒绝', demoBlocked === 'DEMO_MODE_FORBIDDEN', demoBlocked);

  const swWechat = await put('/api/dev/config', { payMode: 'wechat' }, dToken);
  ok('未配置微信凭证时切 wechat 被拒（保护）', swWechat.success === false, swWechat.message);
  await payRuntime.setPayMode('wechat'); // 直改运行时：验证分支确实切换到真实适配器
  ok('切 wechat 后 provider = wechat_sp', paymentProvider.providerType() === 'wechat_sp', paymentProvider.providerType());
  let realErr = '';
  try { paymentProvider.assertRealProvider(); } catch (e) { realErr = e.code || e.message; }
  ok('真实分支因缺少 WXPAY_* 凭证明确报错（证明走的是真实分支）', realErr === 'WXPAY_NOT_CONFIGURED', realErr);
  await payRuntime.setPayMode('mock');
  ok('切回 mock 立即生效', paymentProvider.providerType() === 'mock' && payRuntime.isDemoMode() === true);

  // ---------- 清理 ----------
  console.log('\n[清理] 删除测试订单与供应商，配置复位');
  await PurchaseOrder.deleteMany({ _id: { $in: [orderA._id, orderC._id, orderD._id] } });
  await Supplier.deleteOne({ _id: supplierId });
  await payRuntime.setPayMode('mock');
  await payRuntime.setPaymentFlowMode('supplier_first');
  await mongoose.disconnect();
  console.log('  已清理\n');

  console.log(`===== 验证结束：通过 ${pass} 项，失败 ${fail} 项 =====`);
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('异常:', e);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
