/**
 * 双产品线（点餐线 + 采购线）历史数据迁移脚本
 *
 * 用法：
 *   node migrate_dual_product.js           # dry-run，只打印将要处理的清单，不写库
 *   node migrate_dual_product.js --apply   # 实际执行
 *
 * 背景：2026-09「采购为核心」重构，会员从单一 memberLevel 拆为两条独立产品线：
 *   点餐线 memberLevel/memberExpire（basic 永久免费；advanced/premium 付费）
 *   采购线 purchaseLevel/purchaseExpire（free 永久免费；plus/pro 付费）
 *   同时 MembershipOrder 新增 productLine（pos/purchase）。
 *
 * 迁移口径（老商家零震动：两条线都按当前点餐等级对齐赠送）：
 *   1. 点餐线：付费档且未过期 → 保留；basic 或已过期 → 回落 basic 永久免费（memberExpire=null）
 *   2. 采购线：按点餐线等级映射 advanced→plus、premium→pro，purchaseExpire=memberExpire；
 *              点餐为 basic/已过期 → purchaseLevel='free'
 *   3. 历史购卡订单：productLine 缺失一律回填 'pos'（重构前只有点餐线一条）
 *
 * 安全原则：
 *   - 只处理 purchaseLevel 字段「缺失」的 Member（重构后的新数据不动），可重复运行（幂等）；
 *   - 使用原生 collection.updateOne 绕过 mongoose pre-save 钩子，避免误改余额等字段；
 *   - 先 dry-run 核对清单，再 --apply。
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Member = require('./models/Member');
const MembershipOrder = require('./models/MembershipOrder');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';
const APPLY = process.argv.includes('--apply');

// 点餐线等级 → 采购线等级映射（按秩对齐，老商家两边同送）
const POS_TO_PURCHASE = { advanced: 'plus', premium: 'pro' };

function isFuture(d) {
  return !!d && new Date(d).getTime() > Date.now();
}

async function migrateMembers() {
  // 仅迁移「采购线字段缺失」的历史 Member
  const filter = {
    $or: [
      { purchaseLevel: { $exists: false } },
      { purchaseLevel: null }
    ]
  };

  const docs = await Member.find(filter).select('shopId shopName memberLevel memberExpire memberIsTrial').lean();
  console.log(`\n[Member] 待迁移 ${docs.length} 条（采购线字段缺失）`);

  let posPaid = 0;
  let posFallback = 0;

  for (const m of docs) {
    const paidActive = ['advanced', 'premium'].includes(m.memberLevel) && isFuture(m.memberExpire);
    let set;
    if (paidActive) {
      // 点餐线保留；采购线按映射同送
      set = {
        memberLevel: m.memberLevel,
        memberExpire: m.memberExpire,
        memberIsTrial: !!m.memberIsTrial,
        purchaseLevel: POS_TO_PURCHASE[m.memberLevel] || 'free',
        purchaseExpire: m.memberExpire,
        purchaseIsTrial: !!m.memberIsTrial,
        purchaseSource: 'coin'
      };
      posPaid++;
      console.log(`  · [保留双线] ${m.shopName || m.shopId} | 点餐=${m.memberLevel} → 采购=${set.purchaseLevel}，到期 ${m.memberExpire ? new Date(m.memberExpire).toISOString().slice(0, 10) : '-'}`);
    } else {
      // 点餐线回落 basic 永久免费；采购线免费
      set = {
        memberLevel: 'basic',
        memberExpire: null,
        memberIsTrial: false,
        purchaseLevel: 'free',
        purchaseExpire: null,
        purchaseIsTrial: false,
        purchaseSource: 'coin'
      };
      posFallback++;
      console.log(`  · [回落免费] ${m.shopName || m.shopId} | 点餐=basic(永久免费) / 采购=free`);
    }
    if (APPLY) {
      await Member.collection.updateOne({ _id: m._id }, { $set: set });
    }
  }

  console.log(`[Member] 小计：保留双线 ${posPaid} 条，回落免费 ${posFallback} 条${APPLY ? '（已写入）' : '（dry-run 未写入）'}`);
  return { total: docs.length, posPaid, posFallback };
}

async function migrateMembershipOrders() {
  const filter = {
    $or: [
      { productLine: { $exists: false } },
      { productLine: null }
    ]
  };
  const pending = await MembershipOrder.collection.countDocuments(filter);
  const total = await MembershipOrder.collection.countDocuments();
  console.log(`\n[MembershipOrder] 总订单 ${total} 条：回填 productLine='pos' ${pending} 条`);
  if (APPLY && pending > 0) {
    await MembershipOrder.collection.updateMany(filter, { $set: { productLine: 'pos' } });
  }
  return { total, migrated: pending };
}

(async () => {
  console.log(`==== 双产品线迁移 ${APPLY ? '【APPLY 实际写入】' : '【DRY-RUN 只读预览】'} ====`);
  console.log(`MongoDB: ${MONGODB_URI.replace(/\/\/.*@/, '//***@')}`);
  await mongoose.connect(MONGODB_URI);
  try {
    const r1 = await migrateMembers();
    const r2 = await migrateMembershipOrders();
    console.log('\n==== 汇总 ====');
    console.log(`Member: 处理 ${r1.total} 条（保留双线 ${r1.posPaid} / 回落 ${r1.posFallback}）`);
    console.log(`MembershipOrder: 回填 ${r2.migrated} / 共 ${r2.total} 条`);
    if (!APPLY) {
      console.log('\n当前为 dry-run，未写入任何数据。确认清单无误后执行：node migrate_dual_product.js --apply');
    } else {
      console.log('\n迁移完成。');
    }
  } catch (e) {
    console.error('迁移失败：', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
