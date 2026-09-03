/**
 * 多商家数据隔离诊断脚本 check_data.js
 * 只诊断不修改任何数据。输出：
 *  1. ShopAccount 所有商家列表（shopId / shopName / phone）
 *  2. Dish / Table / Order / Category / Setting 五个集合的总记录数
 *  3. 每个集合里 shopId 的分布：各不同值 × 条数
 *  4. 每个集合里 shopId 为空/null/不存在 的条数
 *
 * 运行：node check_data.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Dish = require('./models/Dish');
const Table = require('./models/Table');
const Order = require('./models/Order');
const Category = require('./models/Category');
const Setting = require('./models/Setting');
const ShopAccount = require('./models/ShopAccount');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';

const COLLECTIONS = [
  { name: 'Dish',     Model: Dish,     label: '菜品 Dish' },
  { name: 'Table',    Model: Table,    label: '桌台 Table' },
  { name: 'Order',    Model: Order,    label: '订单 Order' },
  { name: 'Category', Model: Category, label: '分类 Category' },
  { name: 'Setting',  Model: Setting,  label: '设置 Setting' }
];

function section(title) {
  console.log('\n' + '='.repeat(72));
  console.log(` ${title}`);
  console.log('='.repeat(72));
}

async function analyzeShopIdDistribution(Model, label) {
  // 1. 总数
  const total = await Model.countDocuments();
  console.log(`\n  【${label}】 总记录数 : ${total}`);

  if (total === 0) {
    console.log('    （空集合，无需进一步分析）');
    return;
  }

  // 2. shopId 不存在 / null / 空串 的数量
  const badFilter = {
    $or: [
      { shopId: { $exists: false } },
      { shopId: null },
      { shopId: '' }
    ]
  };
  const badCount = await Model.countDocuments(badFilter);

  // 按细分
  const notExist = await Model.countDocuments({ shopId: { $exists: false } });
  const isNull   = await Model.countDocuments({ shopId: null });
  const isEmpty  = await Model.countDocuments({ shopId: '' });

  console.log(`  ┌────────────────────────────────────────────────────────────────┐`);
  console.log(`  │  ❌ shopId 异常（空/null/不存在）合计 : ${String(badCount).padStart(6)} 条       │`);
  if (badCount > 0) {
    console.log(`  │      - shopId 字段不存在             : ${String(notExist).padStart(6)} 条       │`);
    console.log(`  │      - shopId = null                 : ${String(isNull).padStart(6)} 条       │`);
    console.log(`  │      - shopId = "" (空串)            : ${String(isEmpty).padStart(6)} 条       │`);
  }

  // 3. shopId 分布聚合
  const agg = await Model.aggregate([
    { $group: {
        _id: { $cond: [
          { $or: [
            { $eq: ['$shopId', null] },
            { $eq: ['$shopId', ''] },
            { $not: ['$shopId'] }
          ]},
          '⚠️_NULL_OR_EMPTY',
          '$shopId'
        ]},
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1 } }
  ]);

  console.log(`  │                                                                │`);
  console.log(`  │  shopId 分布：                                                 │`);
  agg.forEach(row => {
    const key = String(row._id);
    const count = row.count;
    const pct = ((count / total) * 100).toFixed(1);
    // 截断长 shopId 显示
    const displayKey = key.length > 42 ? key.slice(0, 39) + '...' : key;
    console.log(`  │    ${displayKey.padEnd(45)} ${String(count).padStart(6)} 条 (${pct.padStart(5)}%) │`);
  });
  console.log(`  └────────────────────────────────────────────────────────────────┘`);
}

async function main() {
  console.log('====================================================================');
  console.log('  鼎恒餐饮 · 多商家 shopId 数据诊断报告');
  console.log('  MongoDB : ' + MONGODB_URI);
  console.log('  时间    : ' + new Date().toLocaleString('zh-CN'));
  console.log('====================================================================');

  await mongoose.connect(MONGODB_URI);
  console.log('✅ MongoDB 连接成功\n');

  try {
    // =============== 一、ShopAccount 商家列表 ===============
    section('一、商家列表（ShopAccount）');
    const merchants = await ShopAccount.find().sort({ createdAt: 1 }).lean();
    if (!merchants.length) {
      console.log('⚠️  没有任何商家！请先注册至少一个商家。');
    } else {
      console.log(`共 ${merchants.length} 个商家（按创建时间升序，迁移脚本默认取第一个）：\n`);
      console.log('  序号  shopId'.padEnd(48) + 'shopName'.padEnd(20) + 'phone');
      console.log('  ' + '-'.repeat(90));
      merchants.forEach((m, idx) => {
        const sid = String(m.shopId || '(无 shopId 字段!)');
        const sname = String(m.shopName || '').slice(0, 18) || '(未命名)';
        const sp = String(m.phone || '(无)');
        const mark = idx === 0 ? '  ★迁移默认' : '';
        console.log(
          `  ${String(idx + 1).padEnd(4)} ${sid.padEnd(44)} ${sname.padEnd(20)} ${sp.padEnd(15)} ${mark}`
        );
      });
    }

    // =============== 二、五个集合总览 ===============
    section('二、五个集合总记录数');
    for (const c of COLLECTIONS) {
      const n = await c.Model.countDocuments();
      console.log(`  ${c.label.padEnd(18)} : ${String(n).padStart(6)} 条`);
    }

    // =============== 三、每个集合 shopId 分布 ===============
    section('三、shopId 分布详细诊断');
    for (const c of COLLECTIONS) {
      await analyzeShopIdDistribution(c.Model, c.label);
    }

    // =============== 四、一致性预警 ===============
    section('四、一致性快速检查');
    const merchantIds = merchants.map(m => String(m.shopId)).filter(Boolean);
    console.log('');
    if (!merchantIds.length) {
      console.log('  ⚠️  无商家可对比，跳过一致性检查。');
    } else {
      console.log(`  商家 shopId 白名单（${merchantIds.length} 个）: ${merchantIds.join('  ·  ')}`);
      console.log('');
      for (const c of COLLECTIONS) {
        // 找 shopId 不在白名单里的记录数
        const bad = await c.Model.countDocuments({
          $and: [
            { shopId: { $exists: true } },
            { shopId: { $nin: [...merchantIds, '', null] } }
          ]
        });
        const empty = await c.Model.countDocuments({
          $or: [{ shopId: { $exists: false } }, { shopId: '' }, { shopId: null }]
        });
        let status = '✅';
        if (empty > 0) status = '❌';
        else if (bad > 0) status = '⚠️ ';
        console.log(`  ${status} ${c.label.padEnd(18)} | 空/null/缺: ${String(empty).padStart(5)} | 不在白名单: ${String(bad).padStart(5)}`);
      }
    }

    console.log('\n====================================================================');
    console.log('  诊断完成。本脚本只读取、不修改任何数据。');
    console.log('====================================================================');
  } catch (err) {
    console.error('❌ 诊断中途失败：', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
