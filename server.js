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
const StoredValue = require('./models/StoredValue');
const DishBom = require('./models/DishBom');
const ShopInventory = require('./models/ShopInventory');

const purchaseOrdersRouter = require('./routes/purchaseOrders');
const coinRouter = require('./routes/coin');
const authRouter = require('./routes/auth');
const devRouter = require('./routes/dev');
const supplierRouter = require('./routes/supplier');
const supplyProductsRouter = require('./routes/supplyProducts');
const marketingRouter = require('./routes/marketing');
const membershipRouter = require('./routes/membership');
const reportsRouter = require('./routes/reports');
const storedValueRouter = require('./routes/storedValue');
const customerPointsRouter = require('./routes/customerPoints');
const procurementMonitorRouter = require('./routes/procurementMonitor');
const supplierPriceRouter = require('./routes/supplierPrice');
const serviceTicketsRouter = require('./routes/serviceTickets');
const smartReplenishRouter = require('./routes/smartReplenish');
const bomRouter = require('./routes/bom');
const purchaseBrainRouter = require('./routes/purchaseBrain');
// 拍照上传商品 / 拍照上传菜单：图片或粘贴文字 → 结构化清单（供应商/商家两端共用一套识别服务）
const aiRouter = require('./routes/ai');
const { getPointConfig, settlePointsForOrder, isValidPhone } = customerPointsRouter;
const Admin = require('./models/Admin');
const { startDhCron } = require('./utils/dhCron');
const priceRule = require('./utils/priceRule');
const notify = require('./utils/notify');
const Marketing = require('./models/Marketing');
const { computeDiscount } = require('./utils/marketingCalc');
const entitlements = require('./utils/entitlements');
const certification = require('./utils/certification');
// 门店定位自动换算（文字地址 → 经纬度）：高德 Web 服务地理编码，失败不阻断业务
const geocode = require('./utils/geocode');
const {
  extractPublicShopId,
  requirePublicShopId,
  requireMerchant,
  requireSupplier,
} = require('./middlewares/auth');

const app = express();

// 中间件
app.use(cors());
// 保留原始请求体字符串：微信支付回调验签需要原始 body（express.json 解析后无法还原）
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    if (buf && buf.length) req.rawBody = buf.toString('utf8');
  }
}));
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
    const { tableNumber, items, remark, phone, usePoints, useStoredValue } = req.body;
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

    // ============ 储值抵扣（线下充值余额，后端权威计算） ============
    // 抵扣金额在订单创建后由「原子条件扣减」确定并回填，此处不再预读余额（防并发超扣）

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
        storedValueUsed: 0,
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
      storedValueUsed: 0,
      storedValuePhone: '',
      status: 'pending',
      shopId
    });
    // 更新桌台状态：同 shopId + 同桌号（unique 复合索引保证不会串到其他商家）
    await Table.findOneAndUpdate(
      { shopId, number: tableNumber },
      { status: 'occupied' },
      { upsert: true }
    );

    // ============ 按 BOM 扣减商家库存（未配 BOM 的菜品跳过；库存可扣到负数表示欠料） ============
    try {
      for (const dishItem of items) {
        const bom = await DishBom.findOne({ shopId, dishName: dishItem.dishName }).lean();
        if (!bom || !bom.items || !bom.items.length) continue;
        for (const bomItem of bom.items) {
          const consume = Number(bomItem.quantity) * Number(dishItem.quantity);
          if (consume > 0) {
            await ShopInventory.findOneAndUpdate(
              { shopId, productId: bomItem.productId },
              { $inc: { quantity: -consume } },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );
          }
        }
      }
    } catch (e) {
      console.error('按 BOM 扣减库存失败（不影响下单）', e);
    }

    // ============ 原子扣减储值余额（$inc + 条件更新）：并发下余额不足即扣 0，绝不超扣 ============
    // 不再使用「先下单后回退」的补偿逻辑：先按当前余额算出可扣金额，再用
    // { balance: { $gte: amount } } 条件原子扣减，未命中（并发已变动）则重取余额重试一次。
    let storedValueUsed = 0;
    if (validPhone && useStoredValue && finalTotal > 0) {
      const orderIdStr = String(order._id);
      for (let attempt = 0; attempt < 2 && storedValueUsed === 0; attempt++) {
        const sv = await StoredValue.findOne({ shopId, phone: phoneStr }).select('balance').lean();
        if (!sv || !(sv.balance > 0)) break;
        const amount = +Math.min(sv.balance, finalTotal).toFixed(2);
        if (amount <= 0) break;
        const updated = await StoredValue.findOneAndUpdate(
          { shopId, phone: phoneStr, balance: { $gte: amount } },
          { $inc: { balance: -amount } },
          { new: true }
        );
        if (updated) {
          storedValueUsed = amount;
          // 追加消费流水（仅追加，不影响余额）
          await StoredValue.updateOne(
            { _id: updated._id },
            {
              $push: {
                history: {
                  type: 'consume',
                  amount: -amount,
                  balance: updated.balance,
                  orderId: orderIdStr,
                  note: '点餐储值抵扣'
                }
              }
            }
          );
        }
      }
      if (storedValueUsed > 0) {
        // 回填订单实际抵扣金额（原子扣减结果为准）
        await Order.updateOne(
          { _id: order._id },
          { $set: { storedValueUsed, storedValuePhone: phoneStr, 'discountDetail.storedValueUsed': storedValueUsed } }
        );
        order.storedValueUsed = storedValueUsed;
        order.storedValuePhone = phoneStr;
        if (order.discountDetail) order.discountDetail.storedValueUsed = storedValueUsed;
      }
    }

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

    const notifyTriggered = await notify.notifyOrderCreated({ shopId, setting, order });

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

// ============ 前端地图选点配置（高德 JS API Key，浏览器端公开） ============
// 仅下发公开的浏览器端 Key；未配置时前端退化为经纬度手输
app.get('/api/config/map', (req, res) => {
  res.json({
    success: true,
    data: {
      // 优先 AMAP_JS_KEY（Web端 JS API Key），未配置时回退旧变量名 AMAP_KEY
      amapKey: process.env.AMAP_JS_KEY || process.env.AMAP_KEY || '',
      amapSecurityCode: process.env.AMAP_SECURITY_CODE || ''
    }
  });
});

// ============ 公开支付模式查询（无鉴权，供前端演示横幅判断）============
// payMode=mock → 各端显示「当前为演示模式」横幅；只下发模式标志，不含任何商户号/密钥信息。
// 模式切换（开发者后台）写穿更新缓存，本接口即时反映，无需重启。
app.get('/api/pay-mode', (req, res) => {
  const payRuntime = require('./utils/payRuntime');
  const payMode = payRuntime.getPayMode();
  res.json({ success: true, data: { payMode, demo: payMode === 'mock' } });
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

// 批量新增菜品（拍照上传菜单 / 粘贴文字后一键新增）
// 一份纸质菜单几十道菜，一道一道点"新增"太折磨人。识别完在这里一次性落库。
// 同名菜品自动跳过不报错；价格或分类没填的单独列出来，前端留在表里让他补。
app.post('/api/admin/dishes/batch', requireMerchant, async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: '没有要新增的菜品' });
    }
    if (items.length > 200) {
      return res.status(400).json({ success: false, message: '一次最多新增 200 道菜，请分批来' });
    }

    // 查重底表：本店已有的菜名
    const exist = await Dish.find({ shopId: req.shopId }).select('name');
    const seen = new Set(exist.map(d => String(d.name || '').replace(/\s/g, '').toLowerCase()));

    const created = [], skipped = [], failed = [];
    for (const raw of items) {
      const name = String((raw && raw.name) || '').trim();
      if (!name) { failed.push({ name: '（空行）', reason: '菜名为空' }); continue; }
      const key = name.replace(/\s/g, '').toLowerCase();
      if (seen.has(key)) { skipped.push({ name, reason: '已经有同名菜品了' }); continue; }
      const price = Number(raw && raw.price);
      if (!isFinite(price) || price < 0) { failed.push({ name, reason: '还没填价格' }); continue; }
      const category = String((raw && raw.category) || '').trim();
      if (!category) { failed.push({ name, reason: '还没选分类' }); continue; }

      const dish = await Dish.create({
        name,
        price: Number(price),
        category,
        image: (raw && raw.image) || '',
        isAvailable: true,
        description: (raw && raw.description) || '',
        shopId: req.shopId
      });
      seen.add(key);
      created.push(dish);
    }

    res.status(201).json({
      success: true,
      data: { created, skipped, failed, count: created.length },
      message: `已新增 ${created.length} 道` + (skipped.length ? `，跳过 ${skipped.length} 道同名` : '') + (failed.length ? `，${failed.length} 道缺价格或分类` : '')
    });
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

// 门店资料完善判定：地址、门头照齐全视为完善（经纬度定位选填，收货方式有默认值）
// 用于新手任务第一步"完善门店信息"及首次登录强制引导状态检测
function isStoreInfoDone(setting) {
  if (!setting) return false;
  return !!(setting.shopAddress && setting.shopAddress.trim()) &&
    !!(setting.storeFrontPhoto);
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
    const storeInfoDone = !!(account && account.storeInfoCompleted) || isStoreInfoDone(setting);
    const storeInfoFirstPrompted = !!(account && account.storeInfoFirstPrompted);
    // 新商家判定：账号创建于 5 分钟内且从未弹过引导 → 首次登录强制完善（不可跳过）
    // 老商家（注册早于本功能）firstPrompted 同为 false 但 createdAt 较早 → 允许跳过
    const isNewMerchant = !!(account && account.createdAt &&
      (Date.now() - new Date(account.createdAt).getTime() < 5 * 60 * 1000));
    const giftClaimed = !!(account && account.onboardGiftClaimed) || !!giftDoc;
    const now = new Date();
    const trialActive = isTrialActive(member, now);

    const tasks = { storeInfo: storeInfoDone, dish: dishDone, decorate: decorateDone, preview: previewDone, mall: mallDone };
    const allDone = storeInfoDone && dishDone && decorateDone && previewDone && mallDone;

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
        },
        // 门店资料完善引导状态：
        //   completed=已完善；firstPrompted=已弹过引导；isNewMerchant=刚注册的新商家
        //   前端判定：未完善 + 未弹过 + 新商家 → 强制弹窗（不可跳过）
        //            未完善 + 未弹过 + 老商家 → 弹窗可跳过 → 跳过后黄条
        //            未完善 + 已弹过 → 常驻黄条提醒
        storeInfo: {
          completed: storeInfoDone,
          firstPrompted: storeInfoFirstPrompted,
          isNewMerchant: isNewMerchant
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

    // 服务端复核五个任务全部完成（门店资料 / 菜品 / 装修查库权威判定，预览 / 逛商城取动作标记）
    const [dishCount, setting] = await Promise.all([
      Dish.countDocuments({ shopId }).session(session),
      Setting.findOne({ shopId }).session(session)
    ]);
    const tasksDone = isStoreInfoDone(setting) &&
      dishCount > 0 &&
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

// POST /api/admin/store-info/complete 标记门店资料已完善（首次引导保存后调用）
// 同时置 storeInfoFirstPrompted=true，防止再次弹出强制引导
app.post('/api/admin/store-info/complete', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const setting = await Setting.findOne({ shopId }).lean();
    if (!isStoreInfoDone(setting)) {
      return res.status(400).json({ success: false, message: '门店资料尚不完整（地址/门头照/定位），请补全后再提交' });
    }
    await ShopAccount.updateOne(
      { shopId },
      { $set: { storeInfoCompleted: true, storeInfoFirstPrompted: true } }
    );
    res.json({ success: true, data: { completed: true } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/store-info/skip 老商家跳过首次完善引导（仅标记 firstPrompted，不标 completed）
// 跳过后后台顶部常驻黄色提醒条直至补全
app.post('/api/admin/store-info/skip', requireMerchant, async (req, res) => {
  try {
    await ShopAccount.updateOne(
      { shopId: req.shopId },
      { $set: { storeInfoFirstPrompted: true } }
    );
    res.json({ success: true, data: { skipped: true } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/admin/certification/status 商家认证状态聚合视图（上线加固第一批） ============
// 返回：认证状态（certified/status）、各项资料是否齐全（items）、手机号是否验证、缺失清单（missing）、
//       首单直通信息（firstOrder：阈值/是否已用过）。
// 供「下单认证判定（utils/certification.checkOrderCertGate，与下单/支付接口同口径）」
// 和「前端引导（缺什么补什么）」共用；认证数据内嵌 Setting.certification。
// 第二批预留项（items 中 reserved=true）：地图选点定位、营业执照 OCR、手机号验证（等 AppID），本轮不拦截已认证商家。
app.get('/api/admin/certification/status', requireMerchant, async (req, res) => {
  try {
    const amount = Number(req.query.amount);
    const data = await certification.getCertificationStatus(
      req.shopId,
      isFinite(amount) && amount > 0 ? amount : undefined
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/admin/certification/submit 提交商家认证（上线加固第一批） ============
// 入参（multipart 也可，但本轮全部走 JSON，文件由前端先 POST /api/admin/upload 上传再传 URL）：
//   shopAddress        详细地址（必填 · 履约必需）
//   shopLongitude      经度（**选填**，不填则由后端按 shopAddress 自动地理编码换算）
//   shopLatitude       纬度（**选填**，同上）
//   storeFrontPhoto    门头照 URL（必填，本轮必传；OCR/合规项后续可放宽）
//   businessLicense    营业执照 URL（必填；OCR 自动识别本轮不做，仅占位留口子）
// 资料齐全 → certification.status='approved'（本轮不需要人工审核，提交即认证通过）
// 已认证（approved）的商家再调用本接口会刷新 submittedAt（重新提交），状态保持 approved；
// 被驳回（rejected）的商家可重新提交，状态重新置 approved。
// 【2026-09 上线加固】门店定位改为「选填 + 后端自动换算」：
//   商家只填文字地址即可，后端调 utils/geocode.js（高德 Web 服务地理编码）换算经纬度；
//   换算失败 **不阻断提交**（认证照常通过、经纬度保留原值不抹掉），失败原因写入
//   Setting.certification.geoStatus / geoMessage，供后续补全。
app.post('/api/admin/certification/submit', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const {
      shopAddress,
      shopLongitude,
      shopLatitude,
      storeFrontPhoto,
      businessLicense
    } = req.body || {};

    // 履约必需项必填校验（详细地址：供应商按文字地址即可配送）
    if (!shopAddress || !String(shopAddress).trim()) {
      return res.status(400).json({ success: false, code: 'MISSING_BLOCKING', message: '请填写详细地址', field: 'shopAddress' });
    }
    // 合规项必填校验（门头照 / 营业执照）
    if (!storeFrontPhoto || !String(storeFrontPhoto).trim()) {
      return res.status(400).json({ success: false, code: 'MISSING_COMPLIANCE', message: '请上传门头照', field: 'storeFrontPhoto' });
    }
    if (!businessLicense || !String(businessLicense).trim()) {
      return res.status(400).json({ success: false, code: 'MISSING_COMPLIANCE', message: '请上传营业执照', field: 'businessLicense' });
    }

    const address = String(shopAddress).trim().slice(0, 200);
    const now = new Date();

    // ---- 门店定位（经纬度）：选填。前端地图选点自带则直接用；否则按文字地址自动换算 ----
    let lng = Number(shopLongitude);
    let lat = Number(shopLatitude);
    let hasLngLat = isFinite(lng) && isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
    let geoUpdate = {};
    let geoResult = null;

    if (hasLngLat) {
      geoUpdate = {
        'certification.geoStatus': 'provided',
        'certification.geoMessage': '',
        'certification.geoFrom': address,
        'certification.geoAttemptedAt': now
      };
      geoResult = { ok: true, source: 'provided', longitude: lng, latitude: lat };
    } else {
      const r = await geocode.geocodeAddress(address);
      if (r.ok) {
        lng = r.longitude;
        lat = r.latitude;
        hasLngLat = true;
        geoUpdate = {
          'certification.geoStatus': 'ok',
          'certification.geoMessage': '',
          'certification.geoFrom': address,
          'certification.geoAttemptedAt': now
        };
        geoResult = {
          ok: true, source: 'geocode', longitude: lng, latitude: lat,
          formattedAddress: r.formattedAddress || '', level: r.level || ''
        };
      } else {
        // 换算失败：不阻断提交，只记录状态供后续补全
        const reason = String(r.reason || '换算失败').slice(0, 200);
        geoUpdate = {
          'certification.geoStatus': 'failed',
          'certification.geoMessage': reason,
          'certification.geoFrom': address,
          'certification.geoAttemptedAt': now
        };
        geoResult = { ok: false, source: 'geocode', reason };
        console.warn(`[certification] 门店定位自动换算失败 shopId=${shopId}：${reason}`);
      }
    }

    const update = {
      shopAddress: address,
      storeFrontPhoto: String(storeFrontPhoto).trim().slice(0, 500),
      'certification.businessLicense': String(businessLicense).trim().slice(0, 500),
      // 提交即认证通过（本轮不做人工审核 / OCR）
      'certification.status': 'approved',
      'certification.submittedAt': now,
      'certification.reviewedAt': now,
      'certification.rejectReason': '',
      ...geoUpdate
    };
    // 只有拿到有效经纬度（自带或换算成功）才写；换算失败保留库中原值，避免抹掉已有定位
    if (hasLngLat) {
      update.shopLongitude = lng;
      update.shopLatitude = lat;
    }

    await Setting.findOneAndUpdate(
      { shopId },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );

    const data = await certification.getCertificationStatus(shopId);
    res.json({
      success: true,
      message: (geoResult && geoResult.ok && geoResult.source === 'geocode')
        ? '认证资料已提交，认证通过（门店位置已自动识别）'
        : '认证资料已提交，认证通过',
      data: Object.assign({}, data, { geoResult })
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- 商家后台修改设置（按 JWT shopId 匹配，绝不窜改他人店铺）---

// 店铺装修权限（双产品线：装修属点餐线权益）
// 主题：高级主题属点餐线 premiumTheme（进阶版+）；自定义头图/LOGO 同权益
const PREMIUM_THEMES = ['dark', 'green', 'redgold']; // 进阶版及以上可用

// 读取当前商家会员档案（Member 不存在时自动创建，新商家注册赠送 30 天进阶+省钱卡体验）
async function getPosMember(shopId) {
  let member = await Member.findOne({ shopId });
  if (!member) member = await Member.create({ shopId });
  return member;
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
        const member = await getPosMember(shopId);
        if (!entitlements.hasPosFeature('premiumTheme', member)) {
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

    // ---- 顾客积分配置：点餐线免费权益（basic 起永久开放），不再按等级拦截，仅做字段清洗 ----
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
    if (update.pointExpiryMode !== undefined) {
      if (!['permanent', 'fixed'].includes(update.pointExpiryMode)) {
        delete update.pointExpiryMode;
      }
    }
    if (update.pointExpiryDays !== undefined) {
      const d = Number(update.pointExpiryDays);
      if (!isFinite(d) || d < 1) { delete update.pointExpiryDays; }
      else { update.pointExpiryDays = Math.min(3650, Math.round(d)); }
    }
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

    // ---- 店铺装修：自定义图片属点餐线 premiumTheme 权益（置空/恢复默认不限等级）----
    const wantsImage = (update.bannerImage && update.bannerImage !== '') ||
                       (update.logoImage && update.logoImage !== '') ||
                       (update.promoPoster && update.promoPoster !== '');
    if (wantsImage) {
      const member = await getPosMember(shopId);
      if (!entitlements.hasPosFeature('premiumTheme', member)) {
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

    // ---- 配送三件套：门店定位/门头照/收货方式/期望时段字段清洗 ----
    ['shopLongitude', 'shopLatitude'].forEach((k) => {
      if (update[k] !== undefined) {
        const n = Number(update[k]);
        update[k] = (isFinite(n) && Math.abs(n) <= 180) ? n : null;
      }
    });
    if (update.receiveMethod !== undefined &&
        !['supplier_arranged', 'door_container', 'open_door', 'self_pickup'].includes(update.receiveMethod)) {
      delete update.receiveMethod;
    }
    ['shopAddress', 'storeFrontPhoto', 'streetViewPhoto',
      'expectedReceiveStart', 'expectedReceiveEnd'].forEach((k) => {
      if (update[k] !== undefined) update[k] = String(update[k]).slice(0, 500);
    });

    // ---- 门店定位（经纬度）自动换算兜底（2026-09 上线加固）----
    // 场景：商家只填了文字地址、没在图上选点也没填经纬度 → 后端按地址自动换算（商家不用理解经纬度）。
    // 只在「库内原本没有定位」且「同一地址上次换算没失败过」时才发起，避免每次保存都打高德配额；
    // 换算失败不阻断保存（经纬度留空），仅把状态写入 certification.geo* 供后续补全。
    let geoResult = null;
    const hasIncomingPos = update.shopLongitude != null || update.shopLatitude != null;
    if (update.shopAddress && !hasIncomingPos) {
      const prev = await Setting.findOne({ shopId })
        .select('shopLongitude shopLatitude certification.geoStatus certification.geoFrom')
        .lean();
      const hasStoredPos = prev && prev.shopLongitude != null && prev.shopLatitude != null;
      const certPrev = (prev && prev.certification) || {};
      const alreadyFailedSameAddr = certPrev.geoStatus === 'failed' && certPrev.geoFrom === update.shopAddress;
      if (!hasStoredPos && !alreadyFailedSameAddr) {
        const r = await geocode.geocodeAddress(update.shopAddress);
        update['certification.geoFrom'] = update.shopAddress;
        update['certification.geoAttemptedAt'] = new Date();
        if (r.ok) {
          update.shopLongitude = r.longitude;
          update.shopLatitude = r.latitude;
          update['certification.geoStatus'] = 'ok';
          update['certification.geoMessage'] = '';
          geoResult = {
            ok: true, source: 'geocode', longitude: r.longitude, latitude: r.latitude,
            formattedAddress: r.formattedAddress || ''
          };
        } else {
          update['certification.geoStatus'] = 'failed';
          update['certification.geoMessage'] = String(r.reason || '换算失败').slice(0, 200);
          geoResult = { ok: false, source: 'geocode', reason: r.reason || '换算失败' };
        }
      }
    }

    // ---- 通知渠道真实对接配置：URL/密钥字符串清洗（未配置则该渠道发送时记 skipped）----
    ['notifyWebhookUrl', 'printerApiUrl', 'smsApiUrl', 'smsApiKey', 'voiceApiUrl', 'voiceApiKey',
      'wechatApiUrl', 'wechatApiKey', 'wechatTemplateId', 'wechatToUser'].forEach((k) => {
      if (update[k] !== undefined) update[k] = String(update[k]).trim().slice(0, 500);
    });

    const setting = await Setting.findOneAndUpdate(
      { shopId },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    // geo：本次是否触发了「地址 → 经纬度」自动换算及结果（前端用于「位置已自动识别」正反馈）
    res.json({ success: true, data: setting, geo: geoResult });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/admin/low-stock-dishes 低库存菜品（菜单页「一键补货」触点） ============
// 基于 DishBom 配方 + ShopInventory 当前库存，反算每道菜还能做多少份（木桶短板效应），
// 返回最紧张的 N 道菜及其瓶颈原料，供菜单页展示角标并跳采购商城预填购物车。
// 无配方数据时 hasBom=false（前端隐藏，不打扰）。
app.get('/api/admin/low-stock-dishes', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);

    const boms = await DishBom.find({ shopId }).lean();
    if (!boms.length) {
      return res.json({ success: true, data: { hasBom: false, items: [] } });
    }

    const productIds = new Set();
    for (const b of boms) {
      for (const it of (b.items || [])) {
        const pid = String(it.productId || '');
        if (pid) productIds.add(pid);
      }
    }
    const pids = [...productIds];
    const [invs, prods] = await Promise.all([
      pids.length ? ShopInventory.find({ shopId, productId: { $in: pids } }).lean() : [],
      pids.length ? SupplyProduct.find({ _id: { $in: pids } }).select('name unit').lean() : []
    ]);
    const invMap = new Map(invs.map(i => [String(i.productId), Number(i.quantity) || 0]));
    const prodMap = new Map(prods.map(p => [String(p._id), p]));

    const items = [];
    for (const b of boms) {
      let portions = Infinity;
      let bottleneck = null;
      for (const it of (b.items || [])) {
        const pid = String(it.productId || '');
        const per = Number(it.quantity) || 0;
        if (!pid || per <= 0) continue;
        const have = invMap.get(pid) || 0;
        const canMake = have / per;
        if (canMake < portions) {
          portions = canMake;
          const p = prodMap.get(pid);
          bottleneck = { productId: pid, name: p ? p.name : '食材', unit: p ? p.unit : '', perPortion: per, have };
        }
      }
      if (!bottleneck || !isFinite(portions)) continue;
      items.push({
        dishName: b.dishName,
        portionsLeft: Math.max(0, Math.floor(portions)),
        bottleneck
      });
    }
    items.sort((a, b) => a.portionsLeft - b.portionsLeft);
    res.json({ success: true, data: { hasBom: true, items: items.slice(0, limit) } });
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
// 会员现金购卡（线下收款 + 平台确认开通）：商家身份鉴权
app.use('/api/membership', membershipRouter);
app.use('/api/points', customerPointsRouter);
// 采购大脑：本月花了多少 / 省了多少 / 攒了多少币 / 今天要办什么，一屏算完（商家身份 + shopId 隔离，只读）
app.use('/api/admin/purchase-brain', purchaseBrainRouter);
// 采购监控（防回扣）：商家身份 + shopId 隔离，全部只读接口
app.use('/api/admin/procurement-monitor', procurementMonitorRouter);
// 智能补货（阶段1 MVP）：基于采购历史频率，商家身份 + shopId 隔离，只读建议接口
app.use('/api/admin/smart-replenish', smartReplenishRouter);
// 菜品→食材用料（BOM）管理：商家身份 + shopId 隔离
app.use('/api/admin/bom', bomRouter);
// AI 识别（拍照上传商品 / 拍照上传菜单）：身份校验在路由内部按接口区分（商家 / 供应商）
app.use('/api/ai', aiRouter);
// 经营报表 / 顾客画像 / 损耗分析：商家身份 + 会员等级鉴权（reportBasic / reportAdvanced）
app.use('/api/admin/reports', reportsRouter);
// 顾客储值（线下充值记账 + 点餐储值抵扣）
app.use('/api/stored-value', storedValueRouter);
// 供应商改价工作台（更新供货价 / 保鲜期提醒）：供应商身份鉴权；平台定价在开发者控制台「定价工作台」
app.use('/api/supplier/price', supplierPriceRouter);
// 售后工单中心：商家提交（requireMerchant）/ 供应商处理（requireSupplier）/ 平台裁决（requireDev），
// 路由内部再按身份校验归属，杜绝跨商家、跨供应商访问
app.use('/api/service-tickets', serviceTicketsRouter);

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
      .select('name contact phone categories minOrderAmount createdAt deliveryNotice')
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
    // 默认开发者账号：只从环境变量读取（DEV_ADMIN_USER / DEV_ADMIN_PASSWORD）。
    // 未配置时不创建任何默认账号，避免弱口令上线；需要时在 .env 配置后重启即可。
    try {
      const devUser = process.env.DEV_ADMIN_USER;
      const devPass = process.env.DEV_ADMIN_PASSWORD;
      if (devUser && devPass) {
        const existingAdmin = await Admin.findOne({ username: devUser });
        if (existingAdmin) {
          console.log(`开发者账号 ${devUser} 已存在，已跳过创建`);
        } else {
          await Admin.create({ username: devUser, password: devPass, name: '系统管理员' });
          console.log(`开发者账号创建成功：${devUser}`);
        }
      } else {
        console.warn('[安全提醒] 未设置 DEV_ADMIN_USER / DEV_ADMIN_PASSWORD，本次启动不创建默认开发者账号；如需开发者后台账号，请在 .env 中配置后再重启。');
      }
    } catch (e) {
      console.error('创建开发者账号失败：', e.message);
    }
    startDhCron();
    // 支付运行时配置（支付模式 mock/wechat + 资金流模式）从 PlatformConfig 加载覆盖值；
    // DB 异常时静默使用 dhConfig 默认值，不阻断启动
    require('./utils/payRuntime').init().catch((e) => {
      console.warn('[payRuntime] 支付运行时配置加载失败，使用默认值:', e.message);
    });
    // 预置平台品类保鲜期规则（幂等，仅 supplierId=null 的全局预置；加价率已停用，仅保鲜期）
    try {
      await priceRule.seedGlobalPresets();
      console.log('[PriceRule] 平台预置品类保鲜期规则已就绪');
    } catch (e) {
      console.error('[PriceRule] 预置规则入库失败:', e.message);
    }
    app.listen(PORT, () => {
      console.log(`服务器已启动: http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB 连接失败:', err.message);
    process.exit(1);
  });
