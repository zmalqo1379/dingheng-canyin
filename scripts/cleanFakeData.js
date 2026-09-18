/**
 * 紧急清理数据库假数据脚本
 * 用法：node cleanFakeData.js
 *
 * 清理规则：
 *   1. ShopAccount   只保留 shopName 包含「鼎恒餐饮」的真实商家
 *   2. Supplier      只保留 name 包含「鼎恒农贸」的真实供应商
 *   3. PurchaseOrder 只保留属于真实商家且属于真实供应商的订单
 *   4. Coupon / CoinHistory 清理关联到已删除假商家的记录
 */
require('dotenv').config();
const mongoose = require('mongoose');

const ShopAccount = require('../models/ShopAccount');
const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');
const Coupon = require('../models/Coupon');
const CoinHistory = require('../models/CoinHistory');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';

async function main() {
  console.log('正在连接数据库:', MONGODB_URI.replace(/\/\/.*@/, '//***@'));
  await mongoose.connect(MONGODB_URI);
  console.log('数据库连接成功\n');

  // ============ 1. 清理假商家 ============
  const realMerchants = await ShopAccount.find({ shopName: { $regex: '鼎恒餐饮' } });
  const keptShopIds = realMerchants.map(m => m.shopId);
  const fakeMerchants = await ShopAccount.find({
    _id: { $nin: realMerchants.map(m => m._id) }
  }).select('shopId shopName');
  const fakeShopIds = fakeMerchants.map(m => m.shopId);

  if (fakeMerchants.length > 0) {
    console.log('将删除的假商家:');
    fakeMerchants.forEach(m => console.log(`  - [${m.shopId}] ${m.shopName || '(未命名)'}`));
  }
  const deletedMerchants = fakeMerchants.length
    ? (await ShopAccount.deleteMany({ _id: { $nin: realMerchants.map(m => m._id) } })).deletedCount
    : 0;

  // ============ 2. 清理假供应商 ============
  const realSuppliers = await Supplier.find({ name: { $regex: '鼎恒农贸' } });
  const keptSupplierIds = realSuppliers.map(s => s._id.toString());
  const fakeSuppliers = await Supplier.find({
    _id: { $nin: realSuppliers.map(s => s._id) }
  }).select('name');
  const fakeSupplierIds = fakeSuppliers.map(s => s._id.toString());

  if (fakeSuppliers.length > 0) {
    console.log('\n将删除的假供应商:');
    fakeSuppliers.forEach(s => console.log(`  - ${s.name || '(未命名)'}`));
  }
  const deletedSuppliers = fakeSuppliers.length
    ? (await Supplier.deleteMany({ _id: { $nin: realSuppliers.map(s => s._id) } })).deletedCount
    : 0;

  // ============ 3. 清理虚假采购订单 ============
  // 只保留：shopId 属于真实商家 且 supplierId 属于真实供应商
  const keptShopIdSet = new Set(keptShopIds);
  const keptSupplierIdSet = new Set(keptSupplierIds);
  const allOrders = await PurchaseOrder.find().select('orderNo shopId shopName supplierId');
  const fakeOrderIds = [];
  allOrders.forEach(o => {
    const orderSupplierId = o.supplierId ? o.supplierId.toString() : '';
    if (!keptShopIdSet.has(o.shopId) || !keptSupplierIdSet.has(orderSupplierId)) {
      fakeOrderIds.push(o._id);
    }
  });

  if (fakeOrderIds.length > 0) {
    console.log(`\n将删除的虚假采购订单: ${fakeOrderIds.length} 笔`);
  }
  const deletedOrders = fakeOrderIds.length
    ? (await PurchaseOrder.deleteMany({ _id: { $in: fakeOrderIds } })).deletedCount
    : 0;

  // ============ 4. 清理关联假商家的 Coupon / CoinHistory ============
  let deletedCoupons = 0;
  let deletedCoinHistory = 0;
  if (fakeShopIds.length > 0) {
    deletedCoupons = (
      await Coupon.deleteMany({ shopId: { $in: fakeShopIds } })
    ).deletedCount;
    deletedCoinHistory = (
      await CoinHistory.deleteMany({ shopId: { $in: fakeShopIds } })
    ).deletedCount;
    console.log(`\n已清理假商家的抵用券 ${deletedCoupons} 张、鼎恒币流水 ${deletedCoinHistory} 条`);
  }

  // ============ 汇总 ============
  const keptOrderCount = await PurchaseOrder.countDocuments();

  console.log('\n========================================');
  console.log(
    `清理完成。保留真实商家${realMerchants.length}家、真实供应商${realSuppliers.length}家、真实订单${keptOrderCount}笔。` +
    `已删除假商家${deletedMerchants}家、假供应商${deletedSuppliers}家、假订单${deletedOrders}笔。`
  );
  console.log('========================================');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('清理失败:', err.message);
  process.exit(1);
});
