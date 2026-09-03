const express = require('express');
const router = express.Router();

const ShopAccount = require('../models/ShopAccount');
const Supplier = require('../models/Supplier');
const Admin = require('../models/Admin');
const Setting = require('../models/Setting');
const Category = require('../models/Category');
const { signToken, requireMerchant, requireSupplier, requireDev } = require('../middlewares/auth');

// ============ 工具：为新商家初始化默认数据 ============
// 1) 默认 Setting（店铺名取自注册信息，其他字段走模型默认值）
// 2) 默认分类：热菜/主食/凉菜/汤品/饮品
async function initMerchantDefaults(shopId, shopName) {
  try {
    // 1. 默认 Setting（按 shopId 唯一，若并发已创建则跳过）
    try {
      await Setting.findOneAndUpdate(
        { shopId },
        { $setOnInsert: { shopId, shopName: shopName || '鼎恒餐饮' } },
        { upsert: true, setDefaultsOnInsert: true }
      );
    } catch (e) { /* 并发冲突（unique）忽略 */ }

    // 2. 默认分类（同一商家下名称唯一，upsert 避免重复）
    const defaultCatNames = ['热菜', '主食', '凉菜', '汤品', '饮品'];
    const ops = defaultCatNames.map(name => ({
      updateOne: {
        filter: { shopId, name },
        update: { $setOnInsert: { shopId, name } },
        upsert: true
      }
    }));
    try {
      await Category.bulkWrite(ops, { ordered: false });
    } catch (e) { /* unique 冲突静默忽略 */ }
  } catch (err) {
    console.error('[initMerchantDefaults] 初始化商家默认数据失败:', err.message);
    // 不向上抛出：初始化失败不影响注册主流程，商家可在后台手动补数据
  }
}

// ============ 工具：生成 shopId ============
function generateShopId() {
  return 'shop_' + Date.now() + '_' + String(Math.floor(Math.random() * 9000 + 1000));
}

// ============ 商家注册 POST /api/auth/merchant/register ============
router.post('/merchant/register', async (req, res) => {
  try {
    const { shopName, contactName, phone, password, confirm } = req.body;
    if (!shopName || !contactName || !phone || !password) {
      return res.status(400).json({ success: false, message: '店铺名称、联系人、手机号、密码不能为空' });
    }
    if (confirm !== undefined && confirm !== password) {
      return res.status(400).json({ success: false, message: '两次输入的密码不一致' });
    }
    // 手机号唯一校验
    const exists = await ShopAccount.findOne({ phone });
    if (exists) {
      return res.status(400).json({ success: false, message: '该手机号已注册' });
    }
    const shopId = generateShopId();
    const account = await ShopAccount.create({
      shopId,
      shopName,
      contactName,
      phone,
      password
    });
    // 为新商家创建一份独立的默认 Setting + 默认分类
    await initMerchantDefaults(shopId, shopName);
    // JWT payload 规范化：role + userId(文档_id) + shopId(店铺标识) + shopName
    const token = signToken({
      userId: String(account._id),
      role: 'merchant',
      shopId: account.shopId,
      shopName: account.shopName
    });
    res.status(201).json({
      success: true,
      message: '注册成功',
      data: { token, shopId: account.shopId, shopName: account.shopName }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 商家登录 POST /api/auth/merchant/login ============
router.post('/merchant/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: '手机号和密码不能为空' });
    }
    const account = await ShopAccount.findOne({ phone });
    if (!account) {
      return res.status(400).json({ success: false, message: '手机号或密码错误' });
    }
    const ok = await account.comparePassword(password);
    if (!ok) {
      return res.status(400).json({ success: false, message: '手机号或密码错误' });
    }
    const token = signToken({
      userId: String(account._id),
      role: 'merchant',
      shopId: account.shopId,
      shopName: account.shopName
    });
    res.json({
      success: true,
      message: '登录成功',
      data: { token, shopId: account.shopId, shopName: account.shopName }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 供应商注册 POST /api/auth/supplier/register ============
router.post('/supplier/register', async (req, res) => {
  try {
    const { name, contact, phone, password, confirm, categories } = req.body;
    if (!name || !contact || !phone || !password) {
      return res.status(400).json({ success: false, message: '供应商名称、联系人、手机号、密码不能为空' });
    }
    if (confirm !== undefined && confirm !== password) {
      return res.status(400).json({ success: false, message: '两次输入的密码不一致' });
    }
    // 手机号唯一校验
    const exists = await Supplier.findOne({ phone });
    if (exists) {
      return res.status(400).json({ success: false, message: '该手机号已注册' });
    }
    // 登录账号默认用手机号
    const loginAccount = String(phone).toLowerCase();
    const accountExists = await Supplier.findOne({ loginAccount });
    if (accountExists) {
      return res.status(400).json({ success: false, message: '该手机号已注册' });
    }
    const supplier = await Supplier.create({
      name,
      contact,
      phone,
      loginAccount,
      password,
      categories: Array.isArray(categories) ? categories : []
    });
    // JWT payload 规范化：role + userId + supplierId(对应 Supplier._id)
    const token = signToken({
      userId: String(supplier._id),
      role: 'supplier',
      supplierId: String(supplier._id)
    });
    res.status(201).json({
      success: true,
      message: '注册成功',
      data: { token, supplierId: String(supplier._id), supplierName: supplier.name }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 供应商登录 POST /api/auth/supplier/login ============
router.post('/supplier/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: '手机号和密码不能为空' });
    }
    const supplier = await Supplier.findOne({ phone });
    if (!supplier) {
      return res.status(400).json({ success: false, message: '手机号或密码错误' });
    }
    const ok = await supplier.comparePassword(password);
    if (!ok) {
      return res.status(400).json({ success: false, message: '手机号或密码错误' });
    }
    const token = signToken({
      userId: String(supplier._id),
      role: 'supplier',
      supplierId: String(supplier._id)
    });
    res.json({
      success: true,
      message: '登录成功',
      data: { token, supplierId: String(supplier._id), supplierName: supplier.name }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 开发者登录 POST /api/auth/dev/login ============
router.post('/dev/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: '账号和密码不能为空' });
    }
    const admin = await Admin.findOne({ username });
    if (!admin) {
      return res.status(400).json({ success: false, message: '账号或密码错误' });
    }
    const ok = await admin.comparePassword(password);
    if (!ok) {
      return res.status(400).json({ success: false, message: '账号或密码错误' });
    }
    // JWT payload 规范化：role + userId(对应 Admin._id)
    const token = signToken({ userId: String(admin._id), role: 'dev' });
    res.json({
      success: true,
      message: '登录成功',
      data: { token }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 开发者账号初始化 POST /api/auth/dev/seed ============
// 创建一个默认开发者账号（username: admin, password: dingheng2024），若已存在则跳过
router.post('/dev/seed', async (req, res) => {
  try {
    const existing = await Admin.findOne({ username: 'admin' });
    if (existing) {
      return res.json({ success: true, message: '默认开发者账号已存在，已跳过创建', data: { username: 'admin' } });
    }
    await Admin.create({
      username: 'admin',
      password: 'dingheng2024',
      name: '系统管理员'
    });
    res.status(201).json({ success: true, message: '默认开发者账号创建成功', data: { username: 'admin' } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 商家修改密码 POST /api/auth/merchant/change-password ============
// 需登录（JWT），body: { oldPassword, newPassword }
// 新密码保存时由模型 pre-save 钩子自动 bcrypt 哈希，数据库不存明文
router.post('/merchant/change-password', requireMerchant, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: '原密码和新密码不能为空' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: '新密码至少 6 位' });
    }
    const account = await ShopAccount.findById(req.user.userId);
    if (!account) {
      return res.status(404).json({ success: false, message: '账户不存在' });
    }
    const ok = await account.comparePassword(oldPassword);
    if (!ok) {
      return res.status(400).json({ success: false, message: '原密码错误' });
    }
    account.password = newPassword;
    await account.save();
    res.json({ success: true, message: '密码修改成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 供应商修改密码 POST /api/auth/supplier/change-password ============
router.post('/supplier/change-password', requireSupplier, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: '原密码和新密码不能为空' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: '新密码至少 6 位' });
    }
    const supplier = await Supplier.findById(req.user.userId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: '账户不存在' });
    }
    const ok = await supplier.comparePassword(oldPassword);
    if (!ok) {
      return res.status(400).json({ success: false, message: '原密码错误' });
    }
    supplier.password = newPassword;
    await supplier.save();
    res.json({ success: true, message: '密码修改成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 开发者修改密码 POST /api/auth/dev/change-password ============
router.post('/dev/change-password', requireDev, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: '原密码和新密码不能为空' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: '新密码至少 6 位' });
    }
    const admin = await Admin.findById(req.user.userId);
    if (!admin) {
      return res.status(404).json({ success: false, message: '账户不存在' });
    }
    const ok = await admin.comparePassword(oldPassword);
    if (!ok) {
      return res.status(400).json({ success: false, message: '原密码错误' });
    }
    admin.password = newPassword;
    await admin.save();
    res.json({ success: true, message: '密码修改成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
