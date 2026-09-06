require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const Category = require('./models/Category');
const Dish = require('./models/Dish');
const Table = require('./models/Table');
const Order = require('./models/Order');
const Setting = require('./models/Setting');
const Supplier = require('./models/Supplier');
const SupplyProduct = require('./models/SupplyProduct');
const PurchaseOrder = require('./models/PurchaseOrder');
const ShopAccount = require('./models/ShopAccount');
const Member = require('./models/Member');
const CoinHistory = require('./models/CoinHistory');
const Coupon = require('./models/Coupon');
const CustomerPoint = require('./models/CustomerPoint');

const purchaseOrdersRouter = require('./routes/purchaseOrders');
const coinRouter = require('./routes/coin');
const authRouter = require('./routes/auth');
const devRouter = require('./routes/dev');
const supplierRouter = require('./routes/supplier');
const supplyProductsRouter = require('./routes/supplyProducts');
const marketingRouter = require('./routes/marketing');
const customerPointsRouter = require('./routes/customerPoints');
const { getPointConfig, settlePointsForOrder, isValidPhone } = customerPointsRouter;
const Admin = require('./models/Admin');
const { startDhCron } = require('./utils/dhCron');
const Marketing = require('./models/Marketing');
const { computeDiscount } = require('./utils/marketingCalc');
const {
  extractPublicShopId,
  requirePublicShopId,
  requireMerchant,
  requireSupplier,
} = require('./middlewares/auth');

const app = express();

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ 菜品图片上传 ============
// 图片统一存到项目 uploads/ 目录，通过 /uploads/xxx.jpg 静态访问
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      // 统一重命名为 时间戳+随机串，避免中文/重名问题
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `dish_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB 上限（前端已压缩）
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png'].includes(file.mimetype);
    if (!ok) return cb(new Error('仅支持 jpg/png 格式图片'));
    cb(null, true);
  }
});

// 菜品图片上传（商家后台专用，需登录；前端已压缩到 2MB 内）
app.post('/api/admin/upload', requireMerchant, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '图片超过 2MB，请压缩后再试' : err.message;
      return res.status(400).json({ success: false, message: msg });
    }
    if (!req.file) return res.status(400).json({ success: false, message: '未收到图片文件' });
    res.json({ success: true, data: { url: `/uploads/${req.file.filename}` } });
  });
});

// 供应商资质图片上传（供应商控制台专用，需供应商登录；用于营业执照/门头/环境/货品 4 张核验照片）
const qualUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `qual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png'].includes(file.mimetype);
    if (!ok) return cb(new Error('仅支持 jpg/png 格式图片'));
    cb(null, true);
  }
});
app.post('/api/supplier/upload', requireSupplier, (req, res) => {
  qualUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '图片超过 2MB，请压缩后再试' : err.message;
      return res.status(400).json({ success: false, message: msg });
    }
    if (!req.file) return res.status(400).json({ success: false, message: '未收到图片文件' });
    res.json({ success: true, data: { url: `/uploads/${req.file.filename}` } });
  });
});
// 全局公开接口 shopId 提取中间件（只提取不校验，需要校验的路由再套 requirePublicShopId）
app.use(extractPublicShopId);

// ============ 公共 API（顾客点餐 / 后厨看单 / 大屏展示 用） ============
// 所有查询按 req.publicShopId 过滤；缺少 shopId 返回 400（requirePublicShopId 中间件）

// 获取分类列表（顾客/后台通用：按 shopId 过滤）
app.get('/api/categories', requirePublicShopId, async (req, res) => {
  try {
    const categories = await Category.find({ shopId: req.publicShopId }).sort({ createdAt: 1 });
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取菜品列表（顾客/后台通用：按 shopId 过滤，可按分类筛选）
app.get('/api/dishes', requirePublicShopId, async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { shopId: req.publicShopId };
    if (category && category !== 'all') filter.category = category;
    const dishes = await Dish.find(filter).sort({ createdAt: 1 });
    res.json({ success: true, data: dishes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取桌台列表（顾客端选桌用：按 shopId 过滤）
app.get('/api/tables', requirePublicShopId, async (req, res) => {
  try {
    const tables = await Table.find({ shopId: req.publicShopId }).sort({ number: 1 });
    res.json({ success: true, data: tables });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 创建订单（顾客端）：shopId 取自公开标识，下单时写入订单
app.post('/api/orders', requirePublicShopId, async (req, res) => {
  try {
    const { tableNumber, items, remark, phone, usePoints } = req.body;
    if (!tableNumber || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: '桌号和菜品不能为空' });
    }
    const shopId = req.publicShopId;
    // 拉取当前生效的满减/折扣活动，后端权威计算优惠金额（前端只负责展示）
    const now = new Date();
    const activeRules = await Marketing.find({
      shopId,
      type: { $in: ['fullReduction', 'discount'] },
      enabled: true,
      $or: [{ endTime: null }, { endTime: { $gte: now } }],
      startTime: { $lte: now }
    }).lean();
    const calc = computeDiscount(items, activeRules);

    // ============ 积分抵现（进阶版权益，后端权威计算） ============
    let finalTotal = calc.finalTotal;
    let pointsUsed = 0;
    let pointsDiscount = 0;
    const phoneStr = String(phone || '').trim();
    const validPhone = isValidPhone(phoneStr);
    if (validPhone && usePoints && finalTotal > 0) {
      const pointCfg = await getPointConfig(shopId);
      if (pointCfg.enabled && pointCfg.deductEnabled) {
        const cp = await CustomerPoint.findOne({ shopId, phone: phoneStr }).lean();
        if (cp && cp.points > 0) {
          // 单笔最多抵 maxPercent%（按抵现比例换算成积分上限）
          const maxDiscountAmount = finalTotal * pointCfg.maxPercent / 100;
          const maxUsablePoints = Math.floor(maxDiscountAmount * pointCfg.deductPoints);
          pointsUsed = Math.min(cp.points, maxUsablePoints);
          if (pointsUsed > 0) {
            pointsDiscount = Math.round(pointsUsed / pointCfg.deductPoints * 100) / 100;
            finalTotal = Math.max(0, +(finalTotal - pointsDiscount).toFixed(2));
          }
        }
      }
    }

    const order = await Order.create({
      tableNumber,
      items,
      totalPrice: finalTotal,
      originalTotal: calc.originalTotal,
      discountAmount: +Math.max(0, calc.originalTotal - finalTotal).toFixed(2),
      discountDetail: {
        itemDiscount: calc.itemDiscountAmount,
        fullReduction: calc.fullReductionAmount,
        pointsDiscount,
        finalTotal,
        appliedRules: activeRules.map(r => ({
          type: r.type,
          threshold: r.threshold,
          reduce: r.reduce,
          rate: r.rate,
          category: r.category,
          title: r.title
        }))
      },
      remark: String(remark || '').slice(0, 200),
      customerPhone: validPhone ? phoneStr : '',
      pointsUsed,
      pointsDiscount,
      status: 'pending',
      shopId
    });
    // 更新桌台状态：同 shopId + 同桌号（unique 复合索引保证不会串到其他商家）
    await Table.findOneAndUpdate(
      { shopId, number: tableNumber },
      { status: 'occupied' },
      { upsert: true }
    );

    // ============ 顾客积分结算：扣抵现积分 + 按实付累计积分 ============
    let pointsEarned = 0;
    let pointsBalance = null;
    if (validPhone) {
      try {
        const settled = await settlePointsForOrder({
          shopId,
          phone: phoneStr,
          payAmount: finalTotal,
          pointsUsed,
          orderId: String(order._id)
        });
        pointsEarned = settled.pointsEarned || 0;
        pointsBalance = settled.pointsBalance;
        if (pointsEarned > 0) {
          // 回写订单积分字段（成功页播报与商家对账用）
          await Order.updateOne({ _id: order._id }, { pointsEarned });
        }
      } catch (e) {
        console.error('顾客积分结算失败（不影响下单）', e);
      }
    }

    // ============ 通知引擎：根据店铺设置触发对应通知 ============
    let setting = await Setting.findOne({ shopId });
    if (!setting) setting = await Setting.create({ shopId, shopName: (ShopAccount.findOne ? '' : '') });

    const notifyTriggered = [];
    if (setting.enableVoice) notifyTriggered.push('voice');
    if (setting.enableBigscreen) notifyTriggered.push('bigscreen');
    if (setting.enablePrinter) {
      notifyTriggered.push('printer');
      console.log('调用打印机', {
        sn: setting.printerSN,
        key: setting.printerKey,
        orderId: order._id,
        tableNumber: order.tableNumber,
        totalPrice: order.totalPrice
      });
    }
    if (setting.enableWechat) {
      notifyTriggered.push('wechat');
      console.log('发送微信通知', {
        phone: setting.notifyPhone,
        orderId: order._id,
        tableNumber: order.tableNumber,
        totalPrice: order.totalPrice
      });
    }

    const orderObj = order.toObject();
    orderObj.notifyTriggered = notifyTriggered;
    // 顾客积分播报数据（未填手机号时为空）
    orderObj.pointsEarned = pointsEarned;
    orderObj.pointsBalance = pointsBalance;
    res.status(201).json({ success: true, data: orderObj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取订单列表（后厨/大屏/顾客通用：按 shopId 过滤，可按状态筛选）
app.get('/api/orders', requirePublicShopId, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { shopId: req.publicShopId };
    if (status) filter.status = status;
    const orders = await Order.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 完成订单（后厨/后台通用：必须匹配 shopId + _id，防止改到别人的订单）
app.put('/api/orders/:id/complete', requirePublicShopId, async (req, res) => {
  try {
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, shopId: req.publicShopId },
      { status: 'completed' },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
    // 更新同商家同桌号的桌台状态为空闲
    await Table.findOneAndUpdate(
      { shopId: req.publicShopId, number: order.tableNumber },
      { status: 'idle' }
    );
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取设置（公开读取：后厨/大屏/顾客端读店铺名称与通知开关）
app.get('/api/settings', requirePublicShopId, async (req, res) => {
  try {
    const shopId = req.publicShopId;
    let setting = await Setting.findOne({ shopId });
    if (!setting) {
      // 店铺设置不存在时自动按 shopId 创建一份（默认值由模型 schema 兜底）
      setting = await Setting.create({ shopId });
    }
    res.json({ success: true, data: setting });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 公开统计（后厨/大屏用：今日订单数/营业额/待处理数，仅按指定 shopId 聚合）
app.get('/api/admin/stats', requirePublicShopId, async (req, res) => {
  try {
    const shopId = req.publicShopId;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const todayOrders = await Order.find({ shopId, createdAt: { $gte: start, $lte: end } });
    const orderCount = todayOrders.length;
    const revenue = todayOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const pendingCount = todayOrders.filter(o => o.status === 'pending').length;
    const completedCount = todayOrders.filter(o => o.status === 'completed').length;

    res.json({
      success: true,
      data: { orderCount, revenue, pendingCount, completedCount }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 商家后台 API（requireMerchant：校验 JWT + shopId 一致） ============
// 所有查询用 req.shopId（JWT 内）过滤；所有写入写入 req.shopId；
// 所有修改/删除条件里必须带 shopId，防止改到别人的数据。

// --- 分类管理 ---

app.get('/api/admin/categories', requireMerchant, async (req, res) => {
  try {
    const categories = await Category.find({ shopId: req.shopId }).sort({ createdAt: 1 });
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/categories', requireMerchant, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: '分类名称不能为空' });
    }
    const cat = await Category.create({ name: String(name).trim(), shopId: req.shopId });
    res.status(201).json({ success: true, data: cat });
  } catch (err) {
    // 同商家同名分类唯一索引冲突
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: '该分类已存在' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/admin/categories/:id', requireMerchant, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: '分类名称不能为空' });
    }
    const cat = await Category.findOneAndUpdate(
      { _id: req.params.id, shopId: req.shopId },
      { name: String(name).trim() },
      { new: true, runValidators: true }
    );
    if (!cat) return res.status(404).json({ success: false, message: '分类不存在' });
    res.json({ success: true, data: cat });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: '该分类已存在' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/categories/:id', requireMerchant, async (req, res) => {
  try {
    const cat = await Category.findOneAndDelete({ _id: req.params.id, shopId: req.shopId });
    if (!cat) return res.status(404).json({ success: false, message: '分类不存在' });
    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- 菜品管理 ---

app.get('/api/admin/dishes', requireMerchant, async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { shopId: req.shopId };
    if (category && category !== 'all') filter.category = category;
    const dishes = await Dish.find(filter).sort({ createdAt: 1 });
    res.json({ success: true, data: dishes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 新增菜品（必须写入当前商家 shopId）
app.post('/api/admin/dishes', requireMerchant, async (req, res) => {
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
      description: description || '',
      shopId: req.shopId
    });
    res.status(201).json({ success: true, data: dish });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 修改菜品（条件必须带 shopId）
app.put('/api/admin/dishes/:id', requireMerchant, async (req, res) => {
  try {
    const dish = await Dish.findOneAndUpdate(
      { _id: req.params.id, shopId: req.shopId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!dish) return res.status(404).json({ success: false, message: '菜品不存在' });
    res.json({ success: true, data: dish });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 删除菜品（条件必须带 shopId）
app.delete('/api/admin/dishes/:id', requireMerchant, async (req, res) => {
  try {
    const dish = await Dish.findOneAndDelete({ _id: req.params.id, shopId: req.shopId });
    if (!dish) return res.status(404).json({ success: false, message: '菜品不存在' });
    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- 桌台管理 ---

app.get('/api/admin/tables', requireMerchant, async (req, res) => {
  try {
    const tables = await Table.find({ shopId: req.shopId }).sort({ number: 1 });
    res.json({ success: true, data: tables });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 新增桌台（写入 shopId，同 shopId+number 唯一）
app.post('/api/admin/tables', requireMerchant, async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ success: false, message: '桌号不能为空' });
    const table = await Table.create({ number: String(number), status: 'idle', shopId: req.shopId });
    res.status(201).json({ success: true, data: table });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: '该桌号已存在' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// 删除桌台（条件带 shopId）
app.delete('/api/admin/tables/:id', requireMerchant, async (req, res) => {
  try {
    const table = await Table.findOneAndDelete({ _id: req.params.id, shopId: req.shopId });
    if (!table) return res.status(404).json({ success: false, message: '桌台不存在' });
    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- 订单管理（商家后台）---

app.get('/api/admin/orders', requireMerchant, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { shopId: req.shopId };
    if (status) filter.status = status;
    const orders = await Order.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- 商家后台统计（req.shopId 来自 JWT，无需前端传）---

app.get('/api/admin/merchant-stats', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const todayOrders = await Order.find({ shopId, createdAt: { $gte: start, $lte: end } });
    const orderCount = todayOrders.length;
    const revenue = todayOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const pendingCount = todayOrders.filter(o => o.status === 'pending').length;
    const completedCount = todayOrders.filter(o => o.status === 'completed').length;

    res.json({
      success: true,
      data: { orderCount, revenue, pendingCount, completedCount }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- 新手开张引导（开张四步曲）---
// 任务状态实时检测：菜品 / 装修 由数据库实时判定；预览 / 逛商城 为动作上报标记；
// 500 鼎恒币开张礼全局仅发一次（ShopAccount.onboardGiftClaimed + CoinHistory 双重防重）。

const ONBOARDING_GIFT_COIN = 500;

// 装修任务判定：主题 / 排版 / 字体任一被修改，或已上传自定义头图 / LOGO / 优惠海报
function isDecorateDone(setting) {
  if (!setting) return false;
  return setting.theme !== 'classic' ||
    setting.layout !== 'list' ||
    setting.shopNameFont !== 'modern' ||
    !!(setting.bannerImage) ||
    !!(setting.logoImage) ||
    !!(setting.promoPoster);
}

// 赠送体验期判定（与 /api/coin/status 口径一致：memberIsTrial 且会员未到期；
// 新商家赠送的是 30 天基础版体验；老数据无字段时按"进阶版且剩余不足 31 天"兜底识别）
function isTrialActive(member, now) {
  if (!member) return false;
  if (member.memberIsTrial === true) {
    return !!(member.memberExpire && member.memberExpire > now);
  }
  if (member.memberIsTrial == null) {
    return member.memberLevel === 'advanced' &&
      !!member.memberExpire &&
      member.memberExpire > now &&
      (member.memberExpire - now) <= 31 * 24 * 60 * 60 * 1000;
  }
  return false;
}

// GET /api/admin/onboarding 新手任务状态
app.get('/api/admin/onboarding', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const [dishCount, setting, account, memberDoc, giftDoc] = await Promise.all([
      Dish.countDocuments({ shopId }),
      Setting.findOne({ shopId }).lean(),
      ShopAccount.findOne({ shopId }).lean(),
      Member.findOne({ shopId }),
      CoinHistory.findOne({ shopId, type: 'new_shop_gift' }).lean()
    ]);
    // 会员档案不存在则创建（pre-save 钩子自动赠送首月 30 天基础版体验），
    // 保证新商家注册后首次进入后台即可看到金色欢迎礼提示
    const member = memberDoc
      ? memberDoc.toObject()
      : (await Member.create({ shopId })).toObject();

    const dishDone = dishCount > 0;
    const decorateDone = isDecorateDone(setting);
    const previewDone = !!(account && account.onboardPreview);
    const mallDone = !!(account && account.onboardMallVisited);
    const giftClaimed = !!(account && account.onboardGiftClaimed) || !!giftDoc;
    const now = new Date();
    const trialActive = isTrialActive(member, now);

    const tasks = { dish: dishDone, decorate: decorateDone, preview: previewDone, mall: mallDone };
    const allDone = dishDone && decorateDone && previewDone && mallDone;

    res.json({
      success: true,
      data: {
        tasks,
        allDone,
        giftClaimed,
        giftCoin: ONBOARDING_GIFT_COIN,
        trial: {
          active: trialActive,
          memberExpire: member ? member.memberExpire : null
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/onboarding/step 动作上报：{ step: 'preview' | 'mall' }
app.post('/api/admin/onboarding/step', requireMerchant, async (req, res) => {
  try {
    const step = String((req.body && req.body.step) || '');
    const field = step === 'preview' ? 'onboardPreview'
      : step === 'mall' ? 'onboardMallVisited' : '';
    if (!field) {
      return res.status(400).json({ success: false, message: 'step 仅支持 preview / mall' });
    }
    await ShopAccount.updateOne({ shopId: req.shopId }, { $set: { [field]: true } });
    res.json({ success: true, data: { step, done: true } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/onboarding/claim-gift 四步全部完成后领取 500 鼎恒币（幂等，防重复发放）
app.post('/api/admin/onboarding/claim-gift', requireMerchant, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const shopId = req.shopId;

    // 幂等快速返回：已发过（标记位或流水任一存在）则不再发放
    const [account, giftDoc] = await Promise.all([
      ShopAccount.findOne({ shopId }).session(session),
      CoinHistory.findOne({ shopId, type: 'new_shop_gift' }).session(session)
    ]);
    if ((account && account.onboardGiftClaimed) || giftDoc) {
      const m = await Member.findOne({ shopId }).session(session);
      return res.json({
        success: true,
        data: { alreadyClaimed: true, coin: ONBOARDING_GIFT_COIN, balance: m ? m.dinghengCoin : 0 }
      });
    }

    // 服务端复核四个任务全部完成（菜品 / 装修查库权威判定，预览 / 逛商城取动作标记）
    const [dishCount, setting] = await Promise.all([
      Dish.countDocuments({ shopId }).session(session),
      Setting.findOne({ shopId }).session(session)
    ]);
    const tasksDone = dishCount > 0 &&
      isDecorateDone(setting) &&
      !!(account && account.onboardPreview) &&
      !!(account && account.onboardMallVisited);
    if (!tasksDone) {
      return res.status(400).json({ success: false, message: '还有新手任务未完成，完成后再来领奖' });
    }

    const result = await session.withTransaction(async () => {
      // 会员币账户（不存在则创建）并发加币
      let member = await Member.findOne({ shopId }).session(session);
      if (!member) {
        const [m] = await Member.create([{ shopId }], { session });
        member = m;
      }
      member.dinghengCoin = (member.dinghengCoin || 0) + ONBOARDING_GIFT_COIN;
      member.totalEarnedCoin = (member.totalEarnedCoin || 0) + ONBOARDING_GIFT_COIN;
      await member.save({ session });

      // 流水（FIFO 扣减依据 remaining；有效期 90 天，与采购返币一致）
      const expireAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      await CoinHistory.create([{
        shopId,
        amount: ONBOARDING_GIFT_COIN,
        type: 'new_shop_gift',
        balanceAfter: member.dinghengCoin,
        expireAt,
        remaining: ONBOARDING_GIFT_COIN,
        isExpired: false,
        description: '新手开张礼：完成开张四步曲奖励'
      }], { session });

      // 发放标记位（防重复发放的第二道保险）
      await ShopAccount.updateOne(
        { shopId },
        { $set: { onboardGiftClaimed: true } }
      ).session(session);

      return { balance: member.dinghengCoin };
    });

    res.json({
      success: true,
      data: { alreadyClaimed: false, coin: ONBOARDING_GIFT_COIN, balance: result.balance }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
});

// --- 商家后台修改设置（按 JWT shopId 匹配，绝不窜改他人店铺）---

// 店铺装修权限：主题按会员等级锁定，自定义图片为进阶版及以上可用
const PREMIUM_THEMES = ['dark', 'green', 'redgold']; // 进阶版及以上可用
const IMAGE_NEED_LEVEL = 'advanced';                 // 自定义横幅图/LOGO 需进阶版及以上

// 读取当前商家会员等级（Member 不存在时自动创建，注册赠送进阶版体验期）
async function getMemberLevel(shopId) {
  let member = await Member.findOne({ shopId });
  if (!member) member = await Member.create({ shopId });
  return member.memberLevel;
}

app.put('/api/settings', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const toBool = (v) => v === true || v === 'true';
    const update = { ...req.body };
    // 绝不允许前端修改 shopId
    delete update.shopId;
    ['enableVoice', 'enableBigscreen', 'enablePrinter', 'enableWechat'].forEach((k) => {
      if (update[k] !== undefined) update[k] = toBool(update[k]);
    });

    // ---- 店铺装修：主题等级校验 ----
    if (update.theme !== undefined) {
      // 非法主题直接剔除（模型 enum 也会兜底）
      if (!['classic', 'minimal', ...PREMIUM_THEMES].includes(update.theme)) {
        delete update.theme;
      } else if (PREMIUM_THEMES.includes(update.theme)) {
        const level = await getMemberLevel(shopId);
        if (!['advanced', 'premium'].includes(level)) {
          return res.status(403).json({
            success: false,
            message: '升级会员解锁全部店铺风格 →',
            needUpgrade: true
          });
        }
      }
    }

    // ---- 店铺装修：店名字体 / 菜单排版（所有会员等级可用，非法值剔除） ----
    if (update.shopNameFont !== undefined &&
        !['modern', 'serif', 'round', 'hand'].includes(update.shopNameFont)) {
      delete update.shopNameFont;
    }
    if (update.layout !== undefined &&
        !['list', 'large', 'grid'].includes(update.layout)) {
      delete update.layout;
    }

    // ---- 顾客积分配置（进阶版权益）：字段清洗 + 等级校验 ----
    const POINT_FIELDS = ['pointEnabled', 'pointSpendPerPoint', 'pointDeductEnabled', 'pointDeductPoints',
      'pointDeductMaxPercent', 'pointExchangeDishes'];
    const touchesPoints = POINT_FIELDS.some(k => update[k] !== undefined);
    if (touchesPoints) {
      const level = await getMemberLevel(shopId);
      if (!['advanced', 'premium'].includes(level)) {
        return res.status(403).json({
          success: false,
          message: '顾客积分为进阶版权益，请先升级会员',
          needUpgrade: true
        });
      }
    }
    ['pointSpendPerPoint', 'pointDeductPoints', 'pointDeductMaxPercent'].forEach((k) => {
      if (update[k] !== undefined) {
        const n = Number(update[k]);
        if (!isFinite(n) || n < 0) { delete update[k]; return; }
        update[k] = n;
      }
    });
    if (update.pointSpendPerPoint !== undefined) update.pointSpendPerPoint = Math.min(1000, update.pointSpendPerPoint);
    if (update.pointDeductPoints !== undefined) update.pointDeductPoints = Math.max(1, Math.min(100000, Math.round(update.pointDeductPoints)));
    if (update.pointDeductMaxPercent !== undefined) update.pointDeductMaxPercent = Math.min(100, update.pointDeductMaxPercent);
    if (update.pointDeductEnabled !== undefined) update.pointDeductEnabled = toBool(update.pointDeductEnabled);
    if (update.pointEnabled !== undefined) update.pointEnabled = toBool(update.pointEnabled);
    if (update.pointExchangeDishes !== undefined) {
      if (!Array.isArray(update.pointExchangeDishes)) {
        delete update.pointExchangeDishes;
      } else {
        update.pointExchangeDishes = update.pointExchangeDishes.slice(0, 20).map(d => ({
          dishId: String((d && d.dishId) || ''),
          dishName: String((d && d.dishName) || '').slice(0, 50),
          points: Math.max(1, Math.round(Number(d && d.points) || 1))
        })).filter(d => d.dishId);
      }
    }

    // ---- 店铺装修：自定义图片进阶版及以上（置空/恢复默认不限等级）----
    const wantsImage = (update.bannerImage && update.bannerImage !== '') ||
                       (update.logoImage && update.logoImage !== '') ||
                       (update.promoPoster && update.promoPoster !== '');
    if (wantsImage) {
      const level = await getMemberLevel(shopId);
      if (!['advanced', 'premium'].includes(level)) {
        return res.status(403).json({
          success: false,
          message: '开通会员，上传你店的专属头图与 logo，让顾客记住你的店',
          needUpgrade: true
        });
      }
    }

    // ---- 店铺装修：优惠海报尺寸（非法值剔除，模型 enum 兜底）----
    if (update.promoPosterSize !== undefined &&
        !['small', 'medium', 'large'].includes(update.promoPosterSize)) {
      delete update.promoPosterSize;
    }

    const setting = await Setting.findOneAndUpdate(
      { shopId },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ success: true, data: setting });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 供应链全自动模块 API ============

app.use('/api/purchase-orders', purchaseOrdersRouter);
app.use('/api/auth', authRouter);
app.use('/api/dev', devRouter);
app.use('/api/supplier', supplierRouter);
app.use('/api', coinRouter);
app.use('/api/supply-products', supplyProductsRouter);
app.use('/api/marketing', marketingRouter);
app.use('/api/points', customerPointsRouter);

// 供应商列表（公开浏览 + 管理端展示，不涉及多商家隔离）
// 采购商城可见的供应商列表：仅 status=active && agreementSigned && orderEnabled
// pending/frozen/rejected、未签协议、未开通接单的供应商一律不出现
app.get('/api/suppliers', async (req, res) => {
  try {
    const suppliers = await Supplier.find({
      status: 'active',
      agreementSigned: true,
      orderEnabled: true
    })
      .select('name contact phone categories minOrderAmount createdAt')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: suppliers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 新增供应商（开发者/后台管理用，当前无鉴权要求）
app.post('/api/suppliers', async (req, res) => {
  try {
    const { name, contact, phone, loginAccount, password, webhookUrl, rebateRate } = req.body;
    if (!name || !loginAccount || !password) {
      return res.status(400).json({ success: false, message: 'name、loginAccount、password 不能为空' });
    }
    const exists = await Supplier.findOne({ loginAccount: loginAccount.toLowerCase() });
    if (exists) {
      return res.status(400).json({ success: false, message: '登录账号已存在' });
    }
    const supplier = await Supplier.create({
      name,
      contact: contact || '',
      phone: phone || '',
      loginAccount,
      password,
      webhookUrl: webhookUrl || '',
      rebateRate: rebateRate != null ? Number(rebateRate) : 0
    });
    const obj = supplier.toObject();
    delete obj.password;
    res.status(201).json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 商家账户积分查询（按 path shopId）
app.get('/api/shop-accounts/:shopId', async (req, res) => {
  try {
    let account = await ShopAccount.findOne({ shopId: req.params.shopId });
    if (!account) account = await ShopAccount.create({ shopId: req.params.shopId });
    // 安全：返回前剔除密码哈希，不向前端泄露
    const data = account.toObject();
    delete data.password;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 启动服务 ============

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dingheng_canyin';

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log('MongoDB 已连接:', MONGODB_URI);
    // 注意：旧的 initData() 已移除——多商家模式下，
    // 默认分类/桌台/菜品/设置都在「商家注册」时为该商家独立创建。
    try {
      const existingAdmin = await Admin.findOne({ username: 'admin' });
      if (existingAdmin) {
        console.log('默认开发者账号已存在，已跳过创建');
      } else {
        await Admin.create({ username: 'admin', password: 'dingheng2024', name: '系统管理员' });
        console.log('默认开发者账号创建成功：admin / dingheng2024');
      }
    } catch (e) {
      console.error('创建默认开发者账号失败：', e.message);
    }
    startDhCron();
    app.listen(PORT, () => {
      console.log(`服务器已启动: http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB 连接失败:', err.message);
    process.exit(1);
  });
