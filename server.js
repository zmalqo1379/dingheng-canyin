require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const Category = require('./models/Category');
const Dish = require('./models/Dish');
const Table = require('./models/Table');
const Order = require('./models/Order');
const Setting = require('./models/Setting');

const app = express();

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ 公共 API ============

// 获取分类列表
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await Category.find().sort({ createdAt: 1 });
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取菜品列表（可按分类筛选）
app.get('/api/dishes', async (req, res) => {
  try {
    const { category } = req.query;
    const filter = {};
    if (category && category !== 'all') filter.category = category;
    const dishes = await Dish.find(filter).sort({ createdAt: 1 });
    res.json({ success: true, data: dishes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 创建订单
app.post('/api/orders', async (req, res) => {
  try {
    const { tableNumber, items } = req.body;
    if (!tableNumber || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: '桌号和菜品不能为空' });
    }
    let totalPrice = 0;
    items.forEach(item => {
      totalPrice += item.price * item.quantity;
    });
    const order = await Order.create({
      tableNumber,
      items,
      totalPrice,
      status: 'pending'
    });
    // 更新桌台状态
    await Table.findOneAndUpdate(
      { number: tableNumber },
      { status: 'occupied' },
      { upsert: true }
    );

    // ============ 通知引擎：根据店铺设置触发对应通知 ============
    // 读取设置（若无记录则自动创建一条默认记录）
    let setting = await Setting.findOne();
    if (!setting) setting = await Setting.create({});

    const notifyTriggered = [];

    // 1) 语音播报（后厨页面自动播报）
    if (setting.enableVoice) {
      notifyTriggered.push('voice');
    }
    // 2) 大屏弹窗（大屏页面自动显示新订单）
    if (setting.enableBigscreen) {
      notifyTriggered.push('bigscreen');
    }
    // 3) 云打印机（自动打印小票）
    if (setting.enablePrinter) {
      notifyTriggered.push('printer');
      // 预留：调用云打印机
      console.log('调用打印机', {
        sn: setting.printerSN,
        key: setting.printerKey,
        orderId: order._id,
        tableNumber: order.tableNumber,
        totalPrice: order.totalPrice
      });
    }
    // 4) 微信通知（新订单发送到手机）
    if (setting.enableWechat) {
      notifyTriggered.push('wechat');
      // 预留：发送微信通知
      console.log('发送微信通知', {
        phone: setting.notifyPhone,
        orderId: order._id,
        tableNumber: order.tableNumber,
        totalPrice: order.totalPrice
      });
    }

    // 返回给前端的订单数据里附带实际触发的通知类型
    const orderObj = order.toObject();
    orderObj.notifyTriggered = notifyTriggered;

    res.status(201).json({ success: true, data: orderObj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取订单列表（可按状态筛选）
app.get('/api/orders', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const orders = await Order.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 完成订单
app.put('/api/orders/:id/complete', async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: 'completed' },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
    // 更新桌台状态为空闲
    await Table.findOneAndUpdate(
      { number: order.tableNumber },
      { status: 'idle' }
    );
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 后台管理 API ============

// 新增菜品
app.post('/api/admin/dishes', async (req, res) => {
  try {
    const { name, price, category, image, isAvailable, description } = req.body;
    if (!name || price == null || !category) {
      return res.status(400).json({ success: false, message: '菜品名称、价格、分类不能为空' });
    }
    const dish = await Dish.create({
      name,
      price,
      category,
      image: image || '',
      isAvailable: isAvailable !== undefined ? isAvailable : true,
      description: description || ''
    });
    res.status(201).json({ success: true, data: dish });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 修改菜品
app.put('/api/admin/dishes/:id', async (req, res) => {
  try {
    const dish = await Dish.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!dish) return res.status(404).json({ success: false, message: '菜品不存在' });
    res.json({ success: true, data: dish });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 删除菜品
app.delete('/api/admin/dishes/:id', async (req, res) => {
  try {
    const dish = await Dish.findByIdAndDelete(req.params.id);
    if (!dish) return res.status(404).json({ success: false, message: '菜品不存在' });
    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取桌台列表
app.get('/api/admin/tables', async (req, res) => {
  try {
    const tables = await Table.find().sort({ number: 1 });
    res.json({ success: true, data: tables });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 新增桌台
app.post('/api/admin/tables', async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ success: false, message: '桌号不能为空' });
    const table = await Table.create({ number: String(number), status: 'idle' });
    res.status(201).json({ success: true, data: table });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 删除桌台
app.delete('/api/admin/tables/:id', async (req, res) => {
  try {
    const table = await Table.findByIdAndDelete(req.params.id);
    if (!table) return res.status(404).json({ success: false, message: '桌台不存在' });
    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 统计：今日订单数与营业额
app.get('/api/admin/stats', async (req, res) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const todayOrders = await Order.find({ createdAt: { $gte: start, $lte: end } });
    const orderCount = todayOrders.length;
    const revenue = todayOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const pendingCount = todayOrders.filter(o => o.status === 'pending').length;
    const completedCount = todayOrders.filter(o => o.status === 'completed').length;

    res.json({
      success: true,
      data: {
        orderCount,
        revenue,
        pendingCount,
        completedCount
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 店铺设置 API ============

// 获取设置
app.get('/api/settings', async (req, res) => {
  try {
    let setting = await Setting.findOne();
    if (!setting) setting = await Setting.create({});
    res.json({ success: true, data: setting });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 修改设置
app.put('/api/settings', async (req, res) => {
  try {
    console.log('[PUT /api/settings] req.body =', req.body);
    // 前端 checkbox/toggle 可能传来字符串 "true"/"false" 而非布尔值，统一转成布尔值
    const toBool = (v) => v === true || v === 'true';
    const update = { ...req.body };
    ['enableVoice', 'enableBigscreen', 'enablePrinter', 'enableWechat'].forEach((k) => {
      if (update[k] !== undefined) update[k] = toBool(update[k]);
    });
    const setting = await Setting.findOneAndUpdate(
      {},
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ success: true, data: setting });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 初始化默认数据 ============

async function initData() {
  try {
    const catCount = await Category.countDocuments();
    if (catCount > 0) {
      console.log('数据已存在，跳过初始化');
      return;
    }
    console.log('开始初始化默认数据...');

    // 分类
    const categories = await Category.insertMany([
      { name: '热菜' },
      { name: '凉菜' },
      { name: '主食' },
      { name: '汤品' },
      { name: '饮品' }
    ]);

    // 菜品
    const dishes = [
      { name: '宫保鸡丁', price: 38, category: '热菜', description: '经典川菜，鸡丁配花生', image: '' },
      { name: '鱼香肉丝', price: 32, category: '热菜', description: '酸甜微辣，下饭首选', image: '' },
      { name: '红烧肉', price: 42, category: '热菜', description: '肥而不腻，入口即化', image: '' },
      { name: '麻婆豆腐', price: 26, category: '热菜', description: '麻辣鲜香', image: '' },
      { name: '凉拌黄瓜', price: 12, category: '凉菜', description: '清爽开胃', image: '' },
      { name: '皮蛋豆腐', price: 16, category: '凉菜', description: '香滑爽口', image: '' },
      { name: '米饭', price: 3, category: '主食', description: '东北珍珠米', image: '' },
      { name: '蛋炒饭', price: 18, category: '主食', description: '粒粒分明', image: '' },
      { name: '番茄蛋汤', price: 15, category: '汤品', description: '酸甜可口', image: '' },
      { name: '紫菜蛋花汤', price: 12, category: '汤品', description: '清淡鲜美', image: '' },
      { name: '可乐', price: 6, category: '饮品', description: '冰镇可口可乐', image: '' },
      { name: '酸梅汤', price: 8, category: '饮品', description: '消暑解腻', image: '' }
    ];
    await Dish.insertMany(dishes);

    // 桌台
    const tables = [];
    for (let i = 1; i <= 10; i++) {
      tables.push({ number: String(i), status: 'idle' });
    }
    await Table.insertMany(tables);

    // 设置
    await Setting.create({
      shopName: '鼎恒餐饮',
      adminPassword: 'admin123',
      enableVoice: true,
      enableBigscreen: true,
      enablePrinter: false,
      enableWechat: false,
      printerSN: '',
      printerKey: '',
      notifyPhone: ''
    });

    console.log('默认数据初始化完成');
  } catch (err) {
    console.error('初始化数据失败：', err);
  }
}

// ============ 启动服务 ============

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log('MongoDB 已连接:', MONGODB_URI);
    await initData();
    app.listen(PORT, () => {
      console.log(`服务器已启动: http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB 连接失败:', err.message);
    process.exit(1);
  });
