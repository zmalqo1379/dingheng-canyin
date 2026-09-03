const express = require('express');
const router = express.Router();

const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');
const { requireSupplier } = require('../middlewares/auth');

// 所有供应商接口均需供应商身份鉴权
router.use(requireSupplier);

// ============ GET /api/supplier/orders/pending ============
// 今日待处理订单（"待确认"状态）数量与列表
router.get('/orders/pending', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const filter = { supplierId, status: '待确认', createdAt: { $gte: start, $lte: end } };
    const orders = await PurchaseOrder.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        count: orders.length,
        orders
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/supplier/stats 供应商控制台统计卡片 ============
// 今日新订单数 / 待确认订单数 / 本月累计订单金额（actualPayAmount 总和）
// 全部真实查询，严禁写死任何数字
router.get('/stats', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [todayNewCount, pendingCount, monthOrders] = await Promise.all([
      // 今日新订单：今日 0 点起创建
      PurchaseOrder.countDocuments({ supplierId, createdAt: { $gte: todayStart } }),
      // 待确认订单：当前 status = 待确认
      PurchaseOrder.countDocuments({ supplierId, status: '待确认' }),
      // 本月订单：取 actualPayAmount 求和（缺失时回退 totalAmount）
      PurchaseOrder.find({ supplierId, createdAt: { $gte: monthStart } })
        .select('actualPayAmount totalAmount -_id')
        .lean()
    ]);

    const monthActualPayTotal = monthOrders.reduce(
      (s, o) => s + Number(o.actualPayAmount != null ? o.actualPayAmount : (o.totalAmount || 0)),
      0
    );

    res.json({
      success: true,
      data: {
        todayNewCount,
        pendingCount,
        monthActualPayTotal: +monthActualPayTotal.toFixed(2)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 通知设置读取 ============
async function getSettingsHandler(req, res) {
  try {
    const supplier = await Supplier.findById(req.user.supplierId).select('notificationSettings name');
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    res.json({
      success: true,
      data: supplier.notificationSettings || { popup: true, sms: false, voice: false }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ============ 通知设置保存 ============
// 仅保存开关状态，暂不接入真实短信/语音
async function saveSettingsHandler(req, res) {
  try {
    const toBool = (v) => v === true || v === 'true';
    const { popup, sms, voice } = req.body || {};
    const update = {};
    if (popup !== undefined) update['notificationSettings.popup'] = toBool(popup);
    if (sms !== undefined) update['notificationSettings.sms'] = toBool(sms);
    if (voice !== undefined) update['notificationSettings.voice'] = toBool(voice);

    const supplier = await Supplier.findByIdAndUpdate(
      req.user.supplierId,
      { $set: update },
      { new: true }
    ).select('notificationSettings name');
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    res.json({ success: true, data: supplier.notificationSettings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// 原有路径
router.get('/notification-settings', getSettingsHandler);
router.put('/notification-settings', saveSettingsHandler);
// 规范路径别名：/api/supplier/settings（GET 读取 / PATCH 保存）
router.get('/settings', getSettingsHandler);
router.put('/settings', saveSettingsHandler);
router.patch('/settings', saveSettingsHandler);

module.exports = router;
