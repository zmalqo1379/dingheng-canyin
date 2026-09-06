/**
 * 返点模式 / 毛利档字段历史数据迁移脚本
 * 用法：node migrate_rebate_mode.js
 *
 * 背景：双阶梯返点体系上线（统一 unified / 分类 byCategory）后新增两个字段：
 *   1. Supplier.rebateMode（'unified' | 'byCategory'，默认 'unified'）
 *      —— mongoose default 只对新文档生效，历史供应商文档需显式回填。
 *   2. RebateSettlement.rebateMode（顶层）与 RebateSettlement.details[].marginType
 *      （'unified' | 'lowMargin' | 'midMargin' | 'highMargin'，默认 'unified'）
 *      —— 历史结算单均按统一全品类口径生成，回填 'unified'。
 *
 * 原则：
 *   - 只补「字段缺失」的文档，已有字段（含 byCategory / 各毛利档）一律不动；
 *   - 使用原生 collection.updateMany/updateOne 绕过 mongoose 钩子；
 *   - 脚本可重复运行（幂等）。
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Supplier = require('./models/Supplier');
const RebateSettlement = require('./models/RebateSettlement');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';

// 1) 供应商：rebateMode 缺失或非法值 → 回填 'unified'
async function migrateSuppliers() {
  const filter = {
    $or: [
      { rebateMode: { $exists: false } },
      { rebateMode: null },
      { rebateMode: { $nin: ['unified', 'byCategory'] } }
    ]
  };
  const pending = await Supplier.countDocuments(filter);
  if (pending > 0) {
    await Supplier.collection.updateMany(filter, { $set: { rebateMode: 'unified' } });
  }
  const total = await Supplier.countDocuments();
  console.log(`[Supplier 供应商] 总记录 ${total} 条：回填 rebateMode='unified' ${pending} 条，其余跳过`);
  return { total, migrated: pending };
}

// 2) 结算单：顶层 rebateMode 缺失 → 'unified'；明细 marginType 缺失 → 'unified'
async function migrateSettlements() {
  // 2a. 顶层 rebateMode 批量回填
  const topFilter = {
    $or: [
      { rebateMode: { $exists: false } },
      { rebateMode: null },
      { rebateMode: { $nin: ['unified', 'byCategory'] } }
    ]
  };
  const topPending = await RebateSettlement.countDocuments(topFilter);
  if (topPending > 0) {
    await RebateSettlement.collection.updateMany(topFilter, { $set: { rebateMode: 'unified' } });
  }

  // 2b. 明细数组中 marginType 缺失的逐条回填（历史明细均为统一口径 → 'unified'）
  const detailFilter = { 'details.marginType': { $exists: false } };
  const docsNeedDetailFix = await RebateSettlement.find(detailFilter).select('details').lean();
  let detailFixed = 0;
  for (const doc of docsNeedDetailFix) {
    const details = Array.isArray(doc.details) ? doc.details : [];
    let changed = false;
    const next = details.map(d => {
      if (d && (d.marginType == null || !['unified', 'lowMargin', 'midMargin', 'highMargin'].includes(d.marginType))) {
        changed = true;
        return { ...d, marginType: 'unified' };
      }
      return d;
    });
    if (changed) {
      await RebateSettlement.collection.updateOne(
        { _id: doc._id },
        { $set: { details: next } }
      );
      detailFixed++;
    }
  }

  const total = await RebateSettlement.countDocuments();
  console.log(`[RebateSettlement 结算单] 总记录 ${total} 条：回填顶层 rebateMode ${topPending} 条，回填明细 marginType ${detailFixed} 条，其余跳过`);
  return { total, topMigrated: topPending, detailMigrated: detailFixed };
}

async function main() {
  console.log('正在连接数据库:', MONGODB_URI.replace(/\/\/.*@/, '//***@'));
  await mongoose.connect(MONGODB_URI);
  console.log('数据库连接成功，开始回填返点模式默认值...\n');

  const summary = {};
  summary.Supplier = await migrateSuppliers();
  summary.RebateSettlement = await migrateSettlements();

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

module.exports = { main, migrateSuppliers, migrateSettlements };
