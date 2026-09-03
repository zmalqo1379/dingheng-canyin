/**
 * 多商家 shopId 数据迁移脚本
 * 用途：为 Category / Dish / Table / Order / Setting 中没有 shopId 的旧记录
 *       统一补上 ShopAccount 集合中「第一个商家」的 shopId。
 * 特性：可重复运行（已有 shopId 的记录跳过）。
 * 运行：node migrate_shopid.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Category = require('./models/Category');
const Dish = require('./models/Dish');
const Table = require('./models/Table');
const Order = require('./models/Order');
const Setting = require('./models/Setting');
const ShopAccount = require('./models/ShopAccount');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';

async function migrateCollection(Model, collectionName, defaultShopId) {
  // 只处理 shopId 不存在或为空字符串的记录（可重复运行：已补过的跳过）
  const filter = { $or: [{ shopId: { $exists: false } }, { shopId: '' }, { shopId: null }] };
  const needFix = await Model.find(filter).select('_id').lean();
  const total = needFix.length;
  if (total === 0) {
    console.log(`[${collectionName}] 无需要补 shopId 的记录，跳过`);
    return 0;
  }
  const ids = needFix.map(x => x._id);
  // 分批更新避免超时
  const BATCH = 200;
  let updated = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const res = await Model.updateMany(
      { _id: { $in: batch } },
      { $set: { shopId: defaultShopId } }
    );
    updated += (res.nModified || res.modifiedCount || 0);
  }
  console.log(`[${collectionName}] 补 shopId 完成：${updated} / ${total} 条`);
  return updated;
}

async function main() {
  console.log('========================================');
  console.log(' 鼎恒餐饮 · shopId 数据迁移脚本启动');
  console.log('========================================');
  console.log('MongoDB:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI);
  console.log('MongoDB 连接成功\n');

  try {
    // 1. 查出 ShopAccount 里现有的商家，取第一个（按创建时间最早）
    const merchants = await ShopAccount.find().sort({ createdAt: 1 }).lean();
    if (!merchants.length) {
      console.log('⚠️  ShopAccount 集合中没有任何商家记录，无法进行迁移。');
      console.log('   请先注册一个商家，或在开发者控制台创建后再运行本脚本。');
      process.exit(1);
    }
    const firstMerchant = merchants[0];
    const defaultShopId = firstMerchant.shopId;
    console.log(`将使用第一个商家作为默认 shopId：`);
    console.log(`  shopId   : ${defaultShopId}`);
    console.log(`  shopName : ${firstMerchant.shopName || '(未命名)'}`);
    console.log(`  联系电话 : ${firstMerchant.phone || '(无)'}`);
    console.log(`  商家总数 : ${merchants.length}\n`);

    // 2. 逐集合迁移
    const summary = {};
    summary.Category = await migrateCollection(Category, 'Category', defaultShopId);
    summary.Dish = await migrateCollection(Dish, 'Dish', defaultShopId);
    summary.Table = await migrateCollection(Table, 'Table', defaultShopId);
    summary.Order = await migrateCollection(Order, 'Order', defaultShopId);
    summary.Setting = await migrateCollection(Setting, 'Setting', defaultShopId);

    // 3. 汇总
    console.log('\n========================================');
    console.log(' 迁移结果汇总');
    console.log('========================================');
    let totalFixed = 0;
    for (const [name, count] of Object.entries(summary)) {
      console.log(`  ${name.padEnd(12)} : ${count} 条`);
      totalFixed += count;
    }
    console.log(`  ${'合计'.padEnd(12)} : ${totalFixed} 条`);
    console.log('\n✅ 迁移完成。脚本可重复运行，下次运行将跳过已补 shopId 的记录。');
  } catch (err) {
    console.error('❌ 迁移失败：', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
