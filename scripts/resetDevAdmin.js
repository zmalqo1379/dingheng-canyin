/**
 * 开发者（Admin）账号一次性重置脚本
 * 用法：
 *   PowerShell:  $env:DEV_ADMIN_USER="admin"; $env:DEV_ADMIN_PASSWORD="新密码"; node scripts/resetDevAdmin.js
 *   bash:        DEV_ADMIN_USER=admin DEV_ADMIN_PASSWORD=新密码 node scripts/resetDevAdmin.js
 *
 * 背景：旧的 /api/auth/dev/seed 播种接口已删除，但历史代码可能已在数据库中
 *       留下密码为公开弱口令（dingheng2024）的管理员账号，等于门户大开。
 *
 * 功能：读取环境变量 DEV_ADMIN_USER / DEV_ADMIN_PASSWORD；
 *       - 数据库中存在该用户名的管理员 → 更新其密码（bcrypt 哈希，pre-save 钩子处理）
 *       - 不存在 → 创建该管理员账号
 *       两个环境变量任一未设置时拒绝执行；不删库、不改动任何其他数据。
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/Admin');

async function main() {
  const username = String(process.env.DEV_ADMIN_USER || '').trim();
  const password = String(process.env.DEV_ADMIN_PASSWORD || '');

  if (!username || !password) {
    console.error('[拒绝执行] 未设置环境变量 DEV_ADMIN_USER / DEV_ADMIN_PASSWORD。');
    console.error('  本脚本用于创建或重置开发者（Admin）账号，为避免弱口令，不提供任何默认账号或默认密码。');
    console.error('  请先通过环境变量指定账号与密码，例如（PowerShell）：');
    console.error('    $env:DEV_ADMIN_USER="admin"; $env:DEV_ADMIN_PASSWORD="你的强密码"; node scripts/resetDevAdmin.js');
    process.exit(1);
  }

  if (String(password).length < 6) {
    console.error('[拒绝执行] DEV_ADMIN_PASSWORD 至少需要 6 位。');
    process.exit(1);
  }

  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';
  await mongoose.connect(MONGODB_URI);

  const existing = await Admin.findOne({ username });
  if (existing) {
    // 明文赋值，模型 pre-save 钩子自动 bcrypt 哈希
    existing.password = password;
    await existing.save();
    console.log(`[完成] 开发者账号「${username}」已存在，密码已重置。`);
  } else {
    await Admin.create({ username, password, name: '系统管理员' });
    console.log(`[完成] 开发者账号「${username}」不存在，已创建。`);
  }

  await mongoose.disconnect();
  console.log('脚本执行完毕，未改动任何其他数据。');
}

main().catch((err) => {
  console.error('执行失败：', err.message);
  process.exit(1);
});
