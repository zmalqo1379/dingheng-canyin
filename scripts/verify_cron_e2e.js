// 采购草稿超时 + 券锁超时 端到端验证（上线加固第一批）
//
// 诊断结论：两个任务均已在 utils/dhCron.js 实现：
//   - cleanupUnpaidDrafts()  L109-L151（草稿 24h 软删 + 券锁 30 分钟释放）
//   - cron.schedule('*/5 * * * *', ...)  L288  每 5 分钟触发一次
//   - server.js  L43 require, L1278 startDhCron()
//
// Coupon 模型已有字段：status:['unused','locked','used','expired'], lockedOrderId, lockedAt  (models/Coupon.js)
//
// 本脚本不依赖 cron 调度，直接调用 dhCron.cleanupUnpaidDrafts() 验证逻辑。
// 阈值通过环境变量覆盖（默认 24h / 30min）：
//   DRAFT_ORDER_TTL_HOURS=0.083  COUPON_LOCK_MINUTES=0.083  （约 5 分钟，避免浮点容差问题）
// 用完把 dhConfig 常量恢复为 24 / 30。
require('dotenv').config();
const mongoose = require('mongoose');
const Setting = require('../models/Setting');
const ShopAccount = require('../models/ShopAccount');
const Supplier = require('../models/Supplier');
const SupplyProduct = require('../models/SupplyProduct');
const PurchaseOrder = require('../models/PurchaseOrder');
const Coupon = require('../models/Coupon');
const NotificationLog = require('../models/NotificationLog');
const dhCron = require('../utils/dhCron');

const PASSWORD = 'CronE2E123456';
const TAG = Date.now().toString().slice(-8);
const SHOP_NAME = 'CronE2E商家' + TAG;
const SUPPLIER_NAME = 'CronE2E供应商' + TAG;

// 直接对接 cleanupUnpaidDrafts 的实现：它读 dhConfig 阈值，
// 这里手工覆盖常量（不污染 dhConfig 文件本身；结束再恢复）
const dhConfig = require('../utils/dhConfig');
const ORIG_DRAFT = dhConfig.DRAFT_ORDER_TTL_HOURS;
const ORIG_LOCK = dhConfig.COUPON_LOCK_MINUTES;

const BASE = 'http://localhost:' + (process.env.PORT || 3000);
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let res = null; try { res = await r.json(); } catch {}
  return { status: r.status, body: res || {} };
}

async function main() {
  console.log('===== 定时任务 E2E 验证（草稿超时 + 券锁释放）=====');
  console.log(`ORIG DRAFT_ORDER_TTL_HOURS=${ORIG_DRAFT}  COUPON_LOCK_MINUTES=${ORIG_LOCK}`);

  // ---------- 临时把阈值改成 ~5 分钟（留足浮点容差），结束务必恢复 24/30 ----------
  const newDraftHours = process.env.DRAFT_ORDER_TTL_HOURS != null ? Number(process.env.DRAFT_ORDER_TTL_HOURS) : 0.083; // ≈5min
  const newLockMin    = process.env.COUPON_LOCK_MINUTES != null ? Number(process.env.COUPON_LOCK_MINUTES) : 0.083;
  dhConfig.DRAFT_ORDER_TTL_HOURS = newDraftHours;
  dhConfig.COUPON_LOCK_MINUTES = newLockMin;
  console.log(`[临时覆盖] DRAFT_ORDER_TTL_HOURS=${newDraftHours}  COUPON_LOCK_MINUTES=${newLockMin}`);

  await mongoose.connect(process.env.MONGODB_URI);
  // 清理上次测试残留
  const staleSuppliers = await Supplier.find({ name: /^CronE2E供应商/ }).select('_id').lean();
  const staleSupplierIds = staleSuppliers.map(s => s._id);
  if (staleSupplierIds.length) {
    await SupplyProduct.deleteMany({ supplierId: { $in: staleSupplierIds } });
    await Supplier.deleteMany({ _id: { $in: staleSupplierIds } });
  }
  const staleShops = await ShopAccount.find({ shopName: /^CronE2E商家/ }).select('shopId').lean();
  if (staleShops.length) {
    const staleShopIds = staleShops.map(s => s.shopId);
    await PurchaseOrder.deleteMany({ shopId: { $in: staleShopIds } });
    await Coupon.deleteMany({ shopId: { $in: staleShopIds } });
    await Setting.deleteMany({ shopId: { $in: staleShopIds } });
    await ShopAccount.deleteMany({ shopId: { $in: staleShopIds } });
  }

  // 注册商家 / 供应商
  const mReg = await req('POST', '/api/auth/merchant/register', {
    shopName: SHOP_NAME, contactName: '测试员',
    phone: '1' + Date.now().toString().slice(-10), password: PASSWORD, confirm: PASSWORD
  });
  if (!mReg.body.success) throw new Error('商家注册失败: ' + mReg.body.message);
  const mToken = mReg.body.data.token;
  const shopId = mReg.body.data.shopId;

  const sReg = await req('POST', '/api/auth/supplier/register', {
    name: SUPPLIER_NAME, contact: '测试员',
    phone: '1' + (Date.now() + 1).toString().slice(-10),
    password: PASSWORD, confirm: PASSWORD, categories: ['蔬菜']
  });
  if (!sReg.body.success) throw new Error('供应商注册失败: ' + sReg.body.message);
  const sToken = sReg.body.data.token;
  const supplierId = sReg.body.data.supplierId;
  await Supplier.updateOne({ _id: supplierId }, { status: 'active', agreementSigned: true, orderEnabled: true, minOrderAmount: 100 });
  const product = await SupplyProduct.create({
    name: 'Cron测试菜' + TAG, category: '蔬菜', unit: 'kg',
    costPrice: 10, salePrice: 20, marketPrice: 20, supplierId, supplierName: SUPPLIER_NAME
  });
  console.log(`[准备] shopId=${shopId} productId=${product._id}\n`);

  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '（' + detail + '）' : ''}`);
    ok ? pass++ : fail++;
  };

  // ---------- 准备数据 ----------
  const coupon = await Coupon.create({
    shopId, type: 'discount', name: '满减券' + TAG,
    faceValue: 30, minOrder: 100, expireDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    status: 'unused'
  });
  console.log(`[准备] 抵用券 ${coupon._id} faceValue=30`);

  // ---------- 场景 1：订单超时 → status「已取消」（软删） ----------
  console.log('\n===== 场景 1：草稿 24h 超时软删 =====');
  const o1 = await PurchaseOrder.create({
    shopId, supplierId, supplierName: SUPPLIER_NAME,
    orderNo: 'CRON-D-' + TAG,
    items: [{ productId: product._id, name: product.name, quantity: 5, unitPrice: 20, totalPrice: 100 }],
    totalAmount: 100, payStatus: 'unpaid', status: '待支付', orderType: 'customer',
    contactName: '测试', contactPhone: '13800000000',
    appliedCouponId: String(coupon._id)
  });
  await Coupon.updateOne({ _id: coupon._id }, { $set: { status: 'locked', lockedOrderId: String(o1._id), lockedAt: new Date() } });

  let r = await dhCron.cleanupUnpaidDrafts();
  let o1Db = await PurchaseOrder.findById(o1._id).lean();
  let cDb = await Coupon.findById(coupon._id).lean();
  check('1.1 即时执行: 草稿仍在 待支付', o1Db.status === '待支付', `status=${o1Db.status}`);
  check('1.1 即时执行: 券仍锁定', cDb.status === 'locked', `status=${cDb.status}`);

  // 倒推 createdAt 到 10 分钟前（绕开 mongoose timestamps 用 raw collection）
  await PurchaseOrder.collection.updateOne(
    { _id: o1._id },
    { $set: { createdAt: new Date(Date.now() - 10 * 60 * 1000), updatedAt: new Date(Date.now() - 10 * 60 * 1000) } }
  );

  r = await dhCron.cleanupUnpaidDrafts();
  o1Db = await PurchaseOrder.findById(o1._id).lean();
  cDb = await Coupon.findById(coupon._id).lean();
  check('1.2 超时执行: 草稿 → 已取消（软删）', o1Db.status === '已取消', `status=${o1Db.status}`);
  check('1.2 记录 cancelReason', o1Db.cancelReason && o1Db.cancelReason.includes('超时未支付'));
  check('1.2 草稿物理行仍在（软删）', o1Db != null);
  check('1.2 草稿的券锁定已随单释放', cDb.status === 'unused', `status=${cDb.status}`);
  check('1.2 释放后 lockedOrderId 已清空', !cDb.lockedOrderId);

  // ---------- 场景 2：券锁定 30min 超时释放（订单本身保留） ----------
  console.log('\n===== 场景 2：券锁 30min 超时释放（订单保留） =====');
  const coupon2 = await Coupon.create({
    shopId, type: 'discount', name: '满减券2-' + TAG,
    faceValue: 50, minOrder: 100, expireDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    status: 'unused'
  });
  const o2 = await PurchaseOrder.create({
    shopId, supplierId, supplierName: SUPPLIER_NAME,
    orderNo: 'CRON-L-' + TAG,
    items: [{ productId: product._id, name: product.name, quantity: 5, unitPrice: 20, totalPrice: 100 }],
    totalAmount: 100, payStatus: 'unpaid', status: '待支付', orderType: 'customer',
    contactName: '测试', contactPhone: '13800000000',
    appliedCouponId: String(coupon2._id)
  });
  await Coupon.updateOne({ _id: coupon2._id }, { $set: { status: 'locked', lockedOrderId: String(o2._id), lockedAt: new Date() } });

  r = await dhCron.cleanupUnpaidDrafts();
  let o2Db = await PurchaseOrder.findById(o2._id).lean();
  let c2Db = await Coupon.findById(coupon2._id).lean();
  check('2.1 即时执行: 订单仍 待支付', o2Db.status === '待支付', `status=${o2Db.status}`);
  check('2.1 即时执行: 券仍 锁定', c2Db.status === 'locked', `status=${c2Db.status}`);

  await Coupon.updateOne({ _id: coupon2._id }, { $set: { lockedAt: new Date(Date.now() - 10 * 60 * 1000) } });

  r = await dhCron.cleanupUnpaidDrafts();
  o2Db = await PurchaseOrder.findById(o2._id).lean();
  c2Db = await Coupon.findById(coupon2._id).lean();
  check('2.2 券锁超时: 订单仍 待支付（订单保留）', o2Db.status === '待支付', `status=${o2Db.status}`);
  check('2.2 券锁超时: 券 → 未使用', c2Db.status === 'unused', `status=${c2Db.status}`);
  check('2.2 释放后 lockedOrderId 已清空', !c2Db.lockedOrderId);
  check('2.2 释放后 lockedAt 已清空', c2Db.lockedAt == null);

  // ---------- 场景 3：幂等性（重复执行无副作用） ----------
  console.log('\n===== 场景 3：重复执行幂等 =====');
  const o3 = await PurchaseOrder.create({
    shopId, supplierId, supplierName: SUPPLIER_NAME,
    orderNo: 'CRON-I-' + TAG,
    items: [{ productId: product._id, name: product.name, quantity: 5, unitPrice: 20, totalPrice: 100 }],
    totalAmount: 100, payStatus: 'unpaid', status: '待支付', orderType: 'customer',
    contactName: '测试', contactPhone: '13800000000'
  });
  await PurchaseOrder.collection.updateOne(
    { _id: o3._id },
    { $set: { createdAt: new Date(Date.now() - 10 * 60 * 1000), updatedAt: new Date(Date.now() - 10 * 60 * 1000) } }
  );
  const r1 = await dhCron.cleanupUnpaidDrafts();
  const o3Db1 = await PurchaseOrder.findById(o3._id).lean();
  const firstCancelledAt = o3Db1.cancelledAt && o3Db1.cancelledAt.getTime();
  const r2 = await dhCron.cleanupUnpaidDrafts();
  const o3Db2 = await PurchaseOrder.findById(o3._id).lean();
  check('3 二次执行: 状态仍 已取消（未回退）', o3Db2.status === '已取消', `status=${o3Db2.status}`);
  check('3 二次执行: cancelledAt 未被改写（幂等）', firstCancelledAt && o3Db2.cancelledAt && firstCancelledAt === o3Db2.cancelledAt.getTime(),
    `首次=${firstCancelledAt}  二次=${o3Db2.cancelledAt && o3Db2.cancelledAt.getTime()}`);
  check('3 二次执行: r2 返回 cancelled=0（已无 待支付 超时草稿）', r2.cancelled === 0, `cancelled=${r2.cancelled}`);

  // ---------- 清理 & 恢复常量 ----------
  console.log('\n[恢复] 把常量改回 24h / 30min');
  dhConfig.DRAFT_ORDER_TTL_HOURS = ORIG_DRAFT;
  dhConfig.COUPON_LOCK_MINUTES = ORIG_LOCK;
  console.log(`[恢复] DRAFT_ORDER_TTL_HOURS=${dhConfig.DRAFT_ORDER_TTL_HOURS}  COUPON_LOCK_MINUTES=${dhConfig.COUPON_LOCK_MINUTES}`);

  console.log('[清理] 删除测试数据');
  await PurchaseOrder.deleteMany({ shopId });
  await SupplyProduct.deleteMany({ supplierId });
  await Supplier.deleteOne({ _id: supplierId });
  await Coupon.deleteMany({ shopId });
  await ShopAccount.deleteOne({ shopId });
  await Setting.deleteOne({ shopId });
  await NotificationLog.deleteMany({ content: { $regex: SUPPLIER_NAME } });

  await mongoose.disconnect();
  console.log(`\n===== 定时任务 E2E 结果：${pass} 通过 / ${fail} 失败 =====`);
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  try {
    const dhConfig = require('../utils/dhConfig');
    dhConfig.DRAFT_ORDER_TTL_HOURS = ORIG_DRAFT;
    dhConfig.COUPON_LOCK_MINUTES = ORIG_LOCK;
    await mongoose.disconnect();
  } catch {}
  console.error('异常:', e);
  process.exit(1);
});