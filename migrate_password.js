/**
 * 密码哈希迁移脚本
 * 用法：node migrate_password.js
 *
 * 功能：
 *   扫描 ShopAccount（商家）、Supplier（供应商）、Admin（开发者）三个集合，
 *   将仍为明文存储的密码用 bcryptjs（10 轮 salt）哈希后回写。
 *
 * 明文判断：密码非空且不以 $2a$ / $2b$ / $2y$ 开头（bcrypt 哈希特征）即视为明文。
 * 已哈希的记录自动跳过，因此脚本可重复运行（幂等）。
 *
 * 说明：回写使用原生 collection.updateOne，绕过 mongoose pre-save 钩子，
 *       与模型层的「已哈希则跳过」保护形成双保险，绝不会二次哈希。
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ShopAccount = require('./models/ShopAccount');
const Supplier = require('./models/Supplier');
const Admin = require('./models/Admin');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';
const SALT_ROUNDS = 10;

// 判断是否已是 bcrypt 哈希（$2a$/$2b$/$2y$ 开头）
function isHashed(pwd) {
  return typeof pwd === 'string' && /^\$2[aby]\$/.test(pwd);
}

/**
 * 迁移单个集合
 * @returns {{total:number, migrated:number, skipped:number, empty:number}}
 */
async function migrateCollection(Model, label) {
  // 只取密码字段；密码为空/不存在的记录无需处理
  const docs = await Model.find({ password: { $nin: [null, ''] } }).select('password');
  let migrated = 0;
  let skipped = 0;

  for (const doc of docs) {
    if (isHashed(doc.password)) {
      skipped++;
      continue;
    }
    const hash = await bcrypt.hash(doc.password, SALT_ROUNDS);
    // 原生 update 绕过 mongoose 中间件，避免任何二次哈希风险
    await Model.collection.updateOne({ _id: doc._id }, { $set: { password: hash } });
    migrated++;
  }

  const totalAll = await Model.countDocuments();
  const empty = totalAll - docs.length;
  console.log(
    `[${label}] 总记录 ${totalAll} 条：明文已迁移 ${migrated} 条，已是哈希跳过 ${skipped} 条，无密码不处理 ${empty} 条`
  );
  return { total: totalAll, migrated, skipped, empty };
}

async function main() {
  console.log('正在连接数据库:', MONGODB_URI.replace(/\/\/.*@/, '//***@'));
  await mongoose.connect(MONGODB_URI);
  console.log('数据库连接成功，开始扫描并迁移密码...\n');

  const summary = {};
  summary.ShopAccount = await migrateCollection(ShopAccount, 'ShopAccount 商家账户');
  summary.Supplier = await migrateCollection(Supplier, 'Supplier 供应商账户');
  summary.Admin = await migrateCollection(Admin, 'Admin 开发者账户');

  console.log('\n========== 迁移完成汇总 ==========');
  console.table(summary);

  await mongoose.disconnect();
  console.log('数据库连接已关闭。');
}

// 直接运行时执行迁移；被 require 时仅导出方法（便于测试/复用）
if (require.main === module) {
  main().catch(err => {
    console.error('迁移失败:', err);
    process.exit(1);
  });
}

module.exports = { main, migrateCollection, isHashed, SALT_ROUNDS };
