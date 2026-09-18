/**
 * 鼎恒餐饮 · 示例商品初始化脚本
 * 运行方式：node seedProducts.js
 * 功能：查找或创建「鼎恒农贸」供应商，并批量插入各分类的示例商品
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const Supplier = require('../models/Supplier');
const SupplyProduct = require('../models/SupplyProduct');

// 示例供应商密码从环境变量读取（.env 的 SEED_SUPPLIER_PASSWORD），不再硬编码
const SEED_SUPPLIER_PASSWORD = process.env.SEED_SUPPLIER_PASSWORD;

// 示例商品清单：全部关联到「鼎恒农贸」
const PRODUCT_SEEDS = [
  // 蔬菜
  { name: '西红柿', category: '蔬菜', unit: '500g', costPrice: 3.50, description: '新鲜蔬菜，当日配送' },
  { name: '大白菜', category: '蔬菜', unit: '棵', costPrice: 2.00, description: '叶大饱满，口感清甜' },
  { name: '芹菜', category: '蔬菜', unit: '500g', costPrice: 4.00, description: '茎脆叶嫩，香味浓郁' },
  { name: '土豆', category: '蔬菜', unit: '500g', costPrice: 2.50, description: '黄心土豆，淀粉含量高' },
  { name: '黄瓜', category: '蔬菜', unit: '500g', costPrice: 3.00, description: '脆嫩爽口，瓜蒂新鲜' },
  // 肉类
  { name: '五花肉', category: '肉类', unit: '500g', costPrice: 25.00, description: '肥瘦相间，适合红烧' },
  { name: '后腿肉', category: '肉类', unit: '500g', costPrice: 22.00, description: '瘦肉为主，肉质紧实' },
  { name: '鸡胸肉', category: '肉类', unit: '500g', costPrice: 15.00, description: '低脂高蛋白，健身首选' },
  { name: '排骨', category: '肉类', unit: '500g', costPrice: 35.00, description: '鲜猪排骨，炖汤佳品' },
  // 冻品
  { name: '冻虾仁', category: '冻品', unit: '500g', costPrice: 45.00, description: '深海虾仁，速冻锁鲜' },
  { name: '冻鸡腿', category: '冻品', unit: '500g', costPrice: 12.00, description: '优质鸡腿肉，冷冻保鲜' },
  { name: '冻带鱼段', category: '冻品', unit: '500g', costPrice: 18.00, description: '东海带鱼切段，去头尾' },
  // 海鲜
  { name: '鲜活草鱼', category: '海鲜', unit: '条', costPrice: 18.00, description: '活鱼现杀，肉质鲜嫩' },
  { name: '花蛤', category: '海鲜', unit: '500g', costPrice: 10.00, description: '鲜活花蛤，吐沙干净' },
  // 粮油酱料
  { name: '大豆油5L', category: '粮油酱料', unit: '桶', costPrice: 48.00, description: '非转基因大豆油，5L家庭装' },
  { name: '生抽酱油1.9L', category: '粮油酱料', unit: '瓶', costPrice: 18.00, description: '酿造生抽，酱香浓郁' },
  { name: '东北大米10kg', category: '粮油酱料', unit: '袋', costPrice: 55.00, description: '东北长粒香米，10kg装' },
  { name: '食用盐500g', category: '粮油酱料', unit: '袋', costPrice: 2.50, description: '加碘精制盐' },
  // 一次性用品
  { name: '打包盒750ml', category: '一次性用品', unit: '个', costPrice: 0.35, description: '食品级PP材质，750ml方形' },
  { name: '一次性筷子100双', category: '一次性用品', unit: '包', costPrice: 8.00, description: '竹制筷子，100双/包' },
  { name: '纸巾盒装', category: '一次性用品', unit: '盒', costPrice: 3.00, description: '抽式纸巾，三层加厚' },
];

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ 未找到 MONGODB_URI，请检查 .env 文件');
    process.exit(1);
  }

  try {
    console.log('⏳ 正在连接数据库...');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ 数据库连接成功');

    // 1. 查找或创建「鼎恒农贸」供应商
    console.log('🔍 查找供应商「鼎恒农贸」...');
    let supplier = await Supplier.findOne({ name: '鼎恒农贸' });
    if (!supplier) {
      if (!SEED_SUPPLIER_PASSWORD) {
        console.error('❌ 未设置 SEED_SUPPLIER_PASSWORD 环境变量，拒绝创建示例供应商（请在 .env 配置后重跑）');
        process.exit(1);
      }
      console.log('➕ 供应商不存在，正在创建...');
      const hashedPwd = await bcrypt.hash(SEED_SUPPLIER_PASSWORD, 10);
      supplier = await Supplier.create({
        name: '鼎恒农贸',
        contact: '张经理',
        phone: '13800138000',
        loginAccount: 'dingheng_nongmao',
        password: hashedPwd,
        categories: ['蔬菜', '肉类', '粮油'],
        rebateRate: 0.05,
        balance: 0,
      });
      console.log('✅ 已创建供应商「鼎恒农贸」，登录账号: dingheng_nongmao / 密码: 见 .env 的 SEED_SUPPLIER_PASSWORD');
    } else {
      console.log('✅ 供应商「鼎恒农贸」已存在');
    }

    const supplierId = supplier._id;

    // 2. 删除该供应商下已有的同名商品（避免重复）
    const existingNames = PRODUCT_SEEDS.map(p => p.name);
    const delResult = await SupplyProduct.deleteMany({
      supplierId,
      name: { $in: existingNames },
    });
    if (delResult.deletedCount > 0) {
      console.log(`🗑️ 已清理 ${delResult.deletedCount} 条同名旧商品`);
    }

    // 3. 批量插入示例商品
    const now = new Date();
    const docs = PRODUCT_SEEDS.map(p => ({
      name: p.name,
      category: p.category,
      unit: p.unit,
      costPrice: Number(p.costPrice),
      marketPrice: Number((p.costPrice * 1.2).toFixed(2)),
      rebateRate: supplier.rebateRate || 0,
      supplierId,
      supplierName: supplier.name,
      stock: 999,
      status: '上架',
      image: '',
      description: p.description,
      createdAt: now,
      updatedAt: now,
    }));

    const inserted = await SupplyProduct.insertMany(docs);
    console.log(`✅ 示例商品初始化完成，共插入 ${inserted.length} 条商品`);

    // 按分类统计
    const byCat = {};
    PRODUCT_SEEDS.forEach(p => { byCat[p.category] = (byCat[p.category] || 0) + 1; });
    console.log('\n📊 分类统计:');
    Object.entries(byCat).forEach(([cat, cnt]) => console.log(`   ${cat}: ${cnt} 条`));

    // 4. 最终汇总
    const totalProducts = await SupplyProduct.countDocuments({ supplierId });
    console.log(`\n📦 「鼎恒农贸」当前商品总数: ${totalProducts}`);
    console.log('🎉 初始化完成！可启动服务后到「采购商城」查看');
  } catch (err) {
    console.error('❌ 初始化失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 数据库连接已关闭');
  }
}

run();