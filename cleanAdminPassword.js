/**
 * Setting 集合 adminPassword 字段清理脚本
 * 用法：node cleanAdminPassword.js
 *
 * 背景：Setting.adminPassword（默认 admin123）为历史遗留死代码，
 *       登录鉴权已统一走 JWT。该字段在数据库中仍是明文，存在泄露风险。
 *
 * 功能：将 Setting 集合中所有文档的 adminPassword 字段用 $unset 移除。
 * 字段不存在时 $unset 无副作用，因此脚本可重复运行（幂等）。
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';

async function main() {
  await mongoose.connect(MONGODB_URI);
  const col = mongoose.connection.collection('settings');

  const result = await col.updateMany(
    { adminPassword: { $exists: true } },
    { $unset: { adminPassword: '' } }
  );

  console.log(`扫描 Setting 文档 ${result.matchedCount} 条，移除 adminPassword 字段 ${result.modifiedCount} 条。`);
  await mongoose.disconnect();
  console.log('清理完成。');
}

main().catch((err) => {
  console.error('清理失败：', err.message);
  process.exit(1);
});
