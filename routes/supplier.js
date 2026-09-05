const express = require('express');
const router = express.Router();

const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');
const RebateSettlement = require('../models/RebateSettlement');
const SupplyProduct = require('../models/SupplyProduct');
const rebate = require('../utils/rebate');
const { requireSupplier } = require('../middlewares/auth');

// 所有供应商接口均需供应商身份鉴权
router.use(requireSupplier);

// ============ GET /api/supplier/profile 供应商档案与治理状态 ============
// 返回：基本信息（名称/联系人/手机/品类/起送价）+ 治理字段（status/agreementSigned/orderEnabled/审核/拒绝/冻结信息）
// 供应商控制台首屏调用此接口决定显示哪个引导页（等待页/冻结页/拒绝页/协议页/待开通接单页/正常控制台）
router.get('/profile', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.user.supplierId)
      .select('-password')
      .lean();
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    res.json({
      success: true,
      data: {
        _id: String(supplier._id),
        name: supplier.name,
        contact: supplier.contact || '',
        phone: supplier.phone || '',
        categories: Array.isArray(supplier.categories) ? supplier.categories : [],
        minOrderAmount: Number(supplier.minOrderAmount) > 0 ? Number(supplier.minOrderAmount) : 300,
        createdAt: supplier.createdAt,
        // 治理字段
        status: supplier.status,
        approvedAt: supplier.approvedAt || null,
        rejectReason: supplier.rejectReason || '',
        frozenReason: supplier.frozenReason || '',
        agreementSigned: !!supplier.agreementSigned,
        agreementSignedAt: supplier.agreementSignedAt || null,
        orderEnabled: !!supplier.orderEnabled,
        orderEnabledAt: supplier.orderEnabledAt || null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/supplier/agreement/sign 签署《供应商入驻合作协议》 ============
// 仅审核通过（status=active）且未签署过的供应商可签署；签署后记录时间，仍需开发者开通接单
router.post('/agreement/sign', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.user.supplierId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    if (supplier.status !== 'active') {
      return res.status(403).json({ success: false, message: '账号未通过审核，暂不可签署协议' });
    }
    if (supplier.agreementSigned) {
      return res.json({ success: true, message: '协议已签署，无需重复签署', data: { agreementSigned: true, agreementSignedAt: supplier.agreementSignedAt } });
    }
    // 请求体需携带 agree=true（前端勾选"我已阅读并同意协议"）
    const agree = req.body && req.body.agree === true;
    if (!agree) {
      return res.status(400).json({ success: false, message: '请先勾选"我已阅读并同意协议"' });
    }
    supplier.agreementSigned = true;
    supplier.agreementSignedAt = new Date();
    await supplier.save();
    res.json({
      success: true,
      message: '协议签署成功，请等待平台开通接单权限',
      data: { agreementSigned: true, agreementSignedAt: supplier.agreementSignedAt }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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
    // 保存过提醒设置即视为完成新手任务"设置新订单提醒"
    update.onboardNotifySet = true;

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

// ============ GET /api/supplier/settle 合作结算与月度对账 ============
// 供应商自有返点中心：本月累计采购额（已完成订单）/ 分品类明细 / 当前档位与返点率
// （读取平台配置的 RebateRule）/ 本月应付平台返点（按阶梯规则实时计算）/ 历史月度结算记录
// 全部数字实时计算（RebateRule + 订单数据），不写死任何费率
router.get('/settle', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month))
      ? req.query.month : rebate.monthKeyOf(new Date());

    // 本月分品类返点（实时预估口径：按当月已完成订单分品类累计额定档）
    const calc = await rebate.calcSupplierMonthRebate(supplierId, month);

    // 当前所在档位 / 当前返点率：按「全部」通用规则 + 本月采购总额定档
    const generalRule = await rebate.getEffectiveRule(supplierId, rebate.ALL_CATEGORY);
    const tierInfo = rebate.calcRebate(generalRule, calc.totalPurchase);

    // 历史月度结算记录
    const history = await RebateSettlement.find({ supplierId })
      .sort({ month: -1, settledAt: -1 })
      .lean();

    res.json({
      success: true,
      data: {
        month,
        supplierId,
        totalPurchase: calc.totalPurchase,       // 本月累计订单金额（已完成订单）
        totalRebate: calc.totalRebate,           // 本月合作服务费（按阶梯规则实时计算）
        orderCount: calc.orderCount,
        categories: calc.categories,             // 分品类采购金额明细（含档位/费率）
        currentTier: {                           // 当前所在返点档位、当前返点率
          hasRule: tierInfo.hasRule,
          tierMinAmount: tierInfo.tierMinAmount,
          tierRate: tierInfo.tierRate,
          mode: tierInfo.mode,
          rate: tierInfo.rate,                   // 综合费率（返点/采购额）
          nextTierMinAmount: tierInfo.nextTierMinAmount,
          gapToNext: tierInfo.gapToNext,
          gainToNext: tierInfo.gainToNext,
          tiers: tierInfo.tiers
        },
        // 平台公示的默认阶梯返点表（无专属规则时按此执行，《平台合作规则》区块展示用）
        defaultLadder: rebate.DEFAULT_TIERS.map(t => ({
          minAmount: t.minAmount,
          rate: t.rate,
          mode: t.mode
        })),
        // 当前供应商是否走默认阶梯（无专属 RebateRule）
        usingDefaultLadder: !tierInfo.hasRule,
        history: history.map(h => ({
          month: h.month,
          totalPurchaseAmount: h.totalPurchaseAmount,
          totalRebateAmount: h.totalRebateAmount,
          settledAt: h.settledAt,
          status: rebate.normalizeSettlementStatus(h.status),
          confirmedAt: h.confirmedAt || null,
          paidAt: h.paidAt || null,
          overdue: rebate.isSettlementOverdue(h),
          details: h.details
        }))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 新手接单引导（三步走） ============
// GET /api/supplier/onboarding 任务状态：
//   1. 上架第一个商品（SupplyProduct 有"上架"商品）
//   2. 设置新订单提醒（保存过通知设置，onboardNotifySet）
//   3. 查看合作结算（点过"去看看"，onboardSettleSeen）
router.get('/onboarding', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const [supplier, onSaleCount] = await Promise.all([
      Supplier.findById(supplierId).select('onboardNotifySet onboardSettleSeen').lean(),
      SupplyProduct.countDocuments({ supplierId, status: '上架' })
    ]);
    const productDone = onSaleCount > 0;
    const notifyDone = !!(supplier && supplier.onboardNotifySet);
    const settleDone = !!(supplier && supplier.onboardSettleSeen);
    res.json({
      success: true,
      data: {
        tasks: { product: productDone, notify: notifyDone, settle: settleDone },
        allDone: productDone && notifyDone && settleDone
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/supplier/onboarding/step 动作上报：{ step: 'settle' }（点"去看看"查看合作结算）
router.post('/onboarding/step', async (req, res) => {
  try {
    const step = String((req.body && req.body.step) || '');
    if (step !== 'settle') {
      return res.status(400).json({ success: false, message: 'step 仅支持 settle' });
    }
    await Supplier.updateOne(
      { _id: req.user.supplierId },
      { $set: { onboardSettleSeen: true } }
    );
    res.json({ success: true, data: { step, done: true } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
