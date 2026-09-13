const express = require('express');
const router = express.Router();

const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');
const SupplyProduct = require('../models/SupplyProduct');
const PlatformConfig = require('../models/PlatformConfig');
const split = require('../utils/split');
const { requireSupplier } = require('../middlewares/auth');

// 所有供应商接口均需供应商身份鉴权
router.use(requireSupplier);

// 《供应商入驻合作协议》当前版本号（与前端 supplier-dashboard.html AGM_VERSION 保持一致；
// 协议文本修改时必须同步升版，签署证据按版本存档以便追溯）
const AGREEMENT_VERSION = 'DH-GYS-2026-V2';

// 提取签署来源 IP（兼容反向代理 x-forwarded-for）
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || '';
}

// ============ GET /api/supplier/profile 供应商档案与治理状态 ============
// 返回：基本信息（名称/联系人/手机/品类/起送价）+ 治理字段（status/agreementSigned/orderEnabled/审核/拒绝/冻结信息）
//       + 资质核验字段（qualification）+ 平台甲方全称（协议页用）
// 供应商控制台首屏调用此接口决定显示哪个引导页（等待页/冻结页/拒绝页/协议页/正常控制台+接单横幅）
router.get('/profile', async (req, res) => {
  try {
    const [supplier, platformCfg] = await Promise.all([
      Supplier.findById(req.user.supplierId).select('-password').lean(),
      PlatformConfig.getSingleton()
    ]);
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    const qual = supplier.qualification || {};
    res.json({
      success: true,
      data: {
        _id: String(supplier._id),
        name: supplier.name,
        contact: supplier.contact || '',
        phone: supplier.phone || '',
        loginAccount: supplier.loginAccount || '',
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
        orderEnabledAt: supplier.orderEnabledAt || null,
        // 资质核验字段
        qualification: {
          status: qual.status || 'none',
          businessLicense: qual.businessLicense || '',
          storeFront: qual.storeFront || '',
          storeInterior: qual.storeInterior || '',
          goods: qual.goods || '',
          submittedAt: qual.submittedAt || null,
          reviewedAt: qual.reviewedAt || null,
          rejectReason: qual.rejectReason || ''
        },
        // 甲方（平台）营业执照全称 + 统一社会信用代码（协议页甲乙双方信息栏用，开发者后台系统设置维护）
        platformCompanyName: platformCfg.platformCompanyName || '',
        platformCreditCode: platformCfg.platformCreditCode || ''
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/supplier/qualification/submit 提交开通接单资质 ============
// 前置：status=active && agreementSigned（审核通过且已签协议，此时供应商已在控制台内）
// 需上传 4 张照片：营业执照 businessLicense / 门店门头照 storeFront / 店内环境照 storeInterior / 货品照 goods
// 提交后 qualification.status=pending（核验中）；核验通过由开发者置 orderEnabled=true 正式上线；
// 被驳回（rejected）后可修改重新提交，重新进入 pending。
const QUALIFICATION_FIELDS = ['businessLicense', 'storeFront', 'storeInterior', 'goods'];
const QUALIFICATION_LABELS = {
  businessLicense: '营业执照',
  storeFront: '门店门头照',
  storeInterior: '店内环境照',
  goods: '货品照'
};
router.post('/qualification/submit', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.user.supplierId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    if (supplier.status !== 'active') {
      return res.status(403).json({ success: false, message: '账号未通过审核，暂不可提交资质' });
    }
    if (!supplier.agreementSigned) {
      return res.status(403).json({ success: false, message: '请先签署合作协议后再提交资质' });
    }
    if (supplier.orderEnabled) {
      return res.status(400).json({ success: false, message: '店铺已开通接单，无需重复提交资质' });
    }
    const body = req.body || {};
    // 电子签署强制校验：提交资质前必须完成协议阅读并点击「同意并继续」（agree 动作即电子签署行为）
    if (body.agreementConfirmed !== true) {
      return res.status(403).json({ success: false, message: '请先阅读并同意《供应商入驻合作协议》后再提交资质' });
    }
    const photos = {};
    for (const f of QUALIFICATION_FIELDS) {
      const url = String(body[f] || '').trim();
      if (!url) {
        return res.status(400).json({ success: false, message: `请上传${QUALIFICATION_LABELS[f]}` });
      }
      // 仅允许本站 uploads 路径或 http(s) 图片地址
      if (!/^(\/uploads\/|https?:\/\/)/.test(url)) {
        return res.status(400).json({ success: false, message: `${QUALIFICATION_LABELS[f]}地址不合法` });
      }
      photos[`qualification.${f}`] = url;
    }

    const update = Object.assign({}, photos, {
      'qualification.status': 'pending',
      'qualification.submittedAt': new Date(),
      'qualification.reviewedAt': null,
      'qualification.rejectReason': '',
      // 电子签署证据存档：签署时间/来源IP/设备信息/协议版本/协议文本哈希（法律效力依据见协议第八章）
      'qualification.agreementEvidence': {
        confirmedAt: new Date(),
        ip: clientIp(req),
        ua: String(req.headers['user-agent'] || ''),
        version: String(body.agreementVersion || AGREEMENT_VERSION),
        textHash: typeof body.agreementTextHash === 'string' ? body.agreementTextHash.slice(0, 128) : ''
      }
    });
    await Supplier.updateOne({ _id: supplier._id }, { $set: update });

    res.json({
      success: true,
      message: '资质已提交，平台核验中（1-2 个工作日），核验通过后店铺将自动上线接单',
      data: { qualificationStatus: 'pending' }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/supplier/agreement/sign 签署《供应商入驻合作协议》 ============
// 仅审核通过（status=active）且未签署过的供应商可签署；签署后即可进入控制台浏览/上架商品，
// 上传资质并通过平台核验后开通接单（"一道闸门"）
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
    const body = req.body || {};
    const agree = body.agree === true;
    if (!agree) {
      return res.status(400).json({ success: false, message: '请先勾选"我已阅读并同意协议"' });
    }
    supplier.agreementSigned = true;
    supplier.agreementSignedAt = new Date();
    // 电子签署证据存档（可靠电子签名，与手写签名/盖章具有同等法律效力，见协议第八章）
    supplier.agreementEvidence = {
      confirmedAt: supplier.agreementSignedAt,
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || ''),
      version: String(body.agreementVersion || AGREEMENT_VERSION),
      textHash: typeof body.agreementTextHash === 'string' ? body.agreementTextHash.slice(0, 128) : ''
    };
    await supplier.save();
    res.json({
      success: true,
      message: '协议签署成功，已进入控制台；请前往「开通接单」上传资质照片，核验通过后正式上线接单',
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
    const supplier = await Supplier.findById(req.user.supplierId).select('notificationSettings name deliveryNotice');
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    res.json({
      success: true,
      data: {
        popup: !!(supplier.notificationSettings && supplier.notificationSettings.popup !== false),
        sms: !!(supplier.notificationSettings && supplier.notificationSettings.sms),
        voice: !!(supplier.notificationSettings && supplier.notificationSettings.voice),
        deliveryNotice: supplier.deliveryNotice || ''
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ============ 通知设置保存 ============
// 保存提醒开关 + 配送时段公告；暂不接入真实短信/语音
async function saveSettingsHandler(req, res) {
  try {
    const toBool = (v) => v === true || v === 'true';
    const { popup, sms, voice, deliveryNotice } = req.body || {};
    const update = {};
    if (popup !== undefined) update['notificationSettings.popup'] = toBool(popup);
    if (sms !== undefined) update['notificationSettings.sms'] = toBool(sms);
    if (voice !== undefined) update['notificationSettings.voice'] = toBool(voice);
    // 配送时段公告：限长 500 字符，超长截断；空字符串允许（清空公告）
    if (deliveryNotice !== undefined) {
      update.deliveryNotice = String(deliveryNotice).slice(0, 500).trim();
    }
    // 保存过提醒设置即视为完成新手任务"设置新订单提醒"
    update.onboardNotifySet = true;

    const supplier = await Supplier.findByIdAndUpdate(
      req.user.supplierId,
      { $set: update },
      { new: true }
    ).select('notificationSettings name deliveryNotice');
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    res.json({
      success: true,
      data: {
        popup: !!(supplier.notificationSettings && supplier.notificationSettings.popup !== false),
        sms: !!(supplier.notificationSettings && supplier.notificationSettings.sms),
        voice: !!(supplier.notificationSettings && supplier.notificationSettings.voice),
        deliveryNotice: supplier.deliveryNotice || ''
      }
    });
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

// ============ GET /api/supplier/split 我的分账 ============
// 加价分销（云分账）：供应商得「供货价」，平台得「差价」。返点体系已停用。
// 金额口径：splitAmount（顾客实付）/ supplierShare（我实得）/ platformShare（平台服务费）/
//          compensateAmount（过秤补差，正=补收，负=退款）；按确认收货时间归属月份。
// 到账本质为微信 T+1 结算：下单即发起分账指令，不代表资金实时到账。
router.get('/split', async (req, res) => {
  try {
    const supplierId = req.user.supplierId;
    const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month))
      ? req.query.month : split.monthKeyOf(new Date());
    const { start, end } = split.monthRange(month);

    const orders = await PurchaseOrder.find({
      supplierId,
      status: '已完成',
      receiveAt: { $gte: start, $lt: end }
    }).sort({ receiveAt: -1 }).lean();

    const summary = orders.reduce((acc, o) => {
      acc.orderCount += 1;
      acc.splitAmount += Number(o.splitAmount) || 0;
      acc.supplierShare += Number(o.supplierShare) || 0;
      acc.platformShare += Number(o.platformShare) || 0;
      acc.compensateAmount += Number(o.compensateAmount) || 0;
      return acc;
    }, { orderCount: 0, splitAmount: 0, supplierShare: 0, platformShare: 0, compensateAmount: 0 });
    ['splitAmount', 'supplierShare', 'platformShare', 'compensateAmount'].forEach(k => {
      summary[k] = +summary[k].toFixed(2);
    });

    res.json({
      success: true,
      data: {
        month,
        summary,
        records: orders.map(o => ({
          _id: o._id,
          orderNo: o.orderNo,
          shopName: o.shopName || '',
          splitAmount: Number(o.splitAmount) || 0,
          supplierShare: Number(o.supplierShare) || 0,
          platformShare: Number(o.platformShare) || 0,
          compensateAmount: Number(o.compensateAmount) || 0,
          splitStatus: o.splitStatus || '待分账',
          splitNo: o.splitNo || '',
          receiveAt: o.receiveAt
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
