const express = require('express');
const router = express.Router();

const ShopAccount = require('../models/ShopAccount');
const Supplier = require('../models/Supplier');
const SupplyProduct = require('../models/SupplyProduct');
const PurchaseOrder = require('../models/PurchaseOrder');
const Member = require('../models/Member');
const RebateRule = require('../models/RebateRule');
const RebateSettlement = require('../models/RebateSettlement');
const CoinRule = require('../models/CoinRule');
const Marketing = require('../models/Marketing');
const PlatformConfig = require('../models/PlatformConfig');
const Dish = require('../models/Dish');
const Category = require('../models/Category');
const Table = require('../models/Table');
const rebate = require('../utils/rebate');
const coinRule = require('../utils/coinRule');
const { requireDev } = require('../middlewares/auth');

// 返点率唯一权威来源为 RebateRule 集合（开发者在控制台配置）；
// 供应商/品类均无规则时，由 rebate 服务按默认兜底率处理，本文件不写死任何费率。

// 所有开发者接口均需开发者身份鉴权
router.use(requireDev);

// ============ GET /api/dev/stats ============
// 返回 { merchantCount, supplierCount, monthlyPurchaseTotal }
// 全部为真实聚合统计，严禁写死任何数字
router.get('/stats', async (req, res) => {
  try {
    // 注册商家总数：ShopAccount 真实计数
    const merchantCount = await ShopAccount.countDocuments();

    // 注册供应商总数：Supplier 真实计数
    const supplierCount = await Supplier.countDocuments();

    // 本月已完成采购订单实际支付总额（aggregate 统计）
    //   - createdAt >= 本月1号
    //   - status = '已完成'
    //   - 求和 actualPayAmount（若该订单未设置 actualPayAmount，则回退用 totalAmount，保证口径正确）
    //   - 本月无数据返回 0
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const agg = await PurchaseOrder.aggregate([
      { $match: { createdAt: { $gte: monthStart }, status: '已完成' } },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: [
                { $gt: [{ $ifNull: ['$actualPayAmount', 0] }, 0] },
                '$actualPayAmount',
                { $ifNull: ['$totalAmount', 0] }
              ]
            }
          }
        }
      }
    ]);
    const monthlyPurchaseTotal = (agg && agg[0] && typeof agg[0].total === 'number') ? agg[0].total : 0;

    res.json({
      success: true,
      data: {
        merchantCount,
        supplierCount,
        monthlyPurchaseTotal
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/dev/merchants 商家管理列表 ============
// 查 ShopAccount 全量，关联 Member 取会员等级与鼎恒币余额，全部真实查询
router.get('/merchants', async (req, res) => {
  try {
    const merchants = await ShopAccount.find()
      .select('shopId shopName contactName phone pointsBalance createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const members = await Member.find().select('shopId memberLevel dinghengCoin').lean();
    const mMap = {};
    members.forEach(m => { mMap[m.shopId] = m; });

    const data = merchants.map(s => ({
      _id: s._id,
      shopId: s.shopId,
      shopName: s.shopName || '未命名商家',
      contactName: s.contactName || '—',
      phone: s.phone || '—',
      memberLevel: (mMap[s.shopId] && mMap[s.shopId].memberLevel) || '基础版',
      dinghengCoin: (mMap[s.shopId] && mMap[s.shopId].dinghengCoin) || 0,
      createdAt: s.createdAt
    }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/dev/merchants/:id 商家详情（只读预览） ============
// 商家信息 + 鼎恒币余额 + 菜单/桌台概览 + 点餐页预览链接 + 采购历史（最近 50 单）
router.get('/merchants/:id', async (req, res) => {
  try {
    const merchant = await ShopAccount.findById(req.params.id).lean();
    if (!merchant) {
      return res.status(404).json({ success: false, message: '商家不存在' });
    }
    const shopId = merchant.shopId;
    const [member, orders, dishCount, categoryCount, tableCount, dishSample] = await Promise.all([
      Member.findOne({ shopId }).lean(),
      PurchaseOrder.find({ shopId })
        .populate('supplierId', 'name')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      Dish.countDocuments({ shopId }),
      Category.countDocuments({ shopId }),
      Table.countDocuments({ shopId }),
      Dish.find({ shopId }).select('name price category isAvailable -_id').sort({ createdAt: 1 }).limit(10).lean()
    ]);

    res.json({
      success: true,
      data: {
        merchant: {
          _id: merchant._id,
          shopId,
          shopName: merchant.shopName || '未命名商家',
          contactName: merchant.contactName || '—',
          phone: merchant.phone || '—',
          createdAt: merchant.createdAt
        },
        memberLevel: (member && member.memberLevel) || '基础版',
        dinghengCoin: (member && member.dinghengCoin) || 0,
        // 菜单/桌台概览
        overview: {
          dishCount,
          categoryCount,
          tableCount,
          dishSample
        },
        // 真实点餐页预览地址（新标签打开）
        previewUrl: `/customer.html?shopId=${encodeURIComponent(shopId)}`,
        orders
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/dev/suppliers 供应商管理列表（快速分页版） ============
// 性能优化：列表只查 Supplier 基础字段 + 治理/资质状态（单表 aggregate，无 N+1 订单/返点聚合）；
// 本月流水/返点/结算等经营统计移到「详情」接口按需查询。
// 查询参数：page（默认1）、pageSize（默认20，最大100）、status（审核状态）、qual（资质状态）
// 排序：待审核(pending)置顶，其余按注册时间倒序（$switch 在库内计算 rank）
router.get('/suppliers', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    let pageSize = parseInt(req.query.pageSize, 10) || 20;
    pageSize = Math.min(100, Math.max(1, pageSize));
    const statusFilter = String(req.query.status || '');
    const qualFilter = String(req.query.qual || '');

    const match = {};
    if (['pending', 'active', 'frozen', 'rejected'].includes(statusFilter)) match.status = statusFilter;
    if (['none', 'pending', 'approved', 'rejected'].includes(qualFilter)) {
      match['qualification.status'] = qualFilter;
    }

    const [aggResult] = await Supplier.aggregate([
      { $match: match },
      {
        $addFields: {
          statusRank: {
            $switch: {
              branches: [
                { case: { $eq: ['$status', 'pending'] }, then: 0 },
                { case: { $eq: ['$status', 'rejected'] }, then: 1 },
                { case: { $eq: ['$status', 'frozen'] }, then: 2 },
                { case: { $eq: ['$status', 'active'] }, then: 3 }
              ],
              default: 99
            }
          }
        }
      },
      { $sort: { statusRank: 1, createdAt: -1 } },
      {
        $facet: {
          total: [{ $count: 'count' }],
          list: [
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },
            {
              $project: {
                name: 1, contact: 1, phone: 1, categories: 1, minOrderAmount: 1,
                createdAt: 1, status: 1, rejectReason: 1, frozenReason: 1,
                approvedAt: 1, agreementSigned: 1, agreementSignedAt: 1,
                orderEnabled: 1, orderEnabledAt: 1,
                qualStatus: '$qualification.status',
                qualSubmittedAt: '$qualification.submittedAt',
                qualReviewedAt: '$qualification.reviewedAt',
                qualRejectReason: '$qualification.rejectReason'
              }
            }
          ]
        }
      }
    ]);

    const total = (aggResult && aggResult.total && aggResult.total[0] && aggResult.total[0].count) || 0;
    const list = (aggResult && aggResult.list) || [];
    const data = list.map(s => ({
      _id: s._id,
      name: s.name || '平台直供',
      contactName: s.contact || '—',
      phone: s.phone || '—',
      categories: Array.isArray(s.categories) ? s.categories : [],
      minOrderAmount: Number(s.minOrderAmount) > 0 ? Number(s.minOrderAmount) : 300,
      createdAt: s.createdAt,
      status: s.status || 'pending',
      rejectReason: s.rejectReason || '',
      frozenReason: s.frozenReason || '',
      approvedAt: s.approvedAt || null,
      agreementSigned: !!s.agreementSigned,
      agreementSignedAt: s.agreementSignedAt || null,
      orderEnabled: !!s.orderEnabled,
      orderEnabledAt: s.orderEnabledAt || null,
      qualStatus: s.qualStatus || 'none',
      qualSubmittedAt: s.qualSubmittedAt || null,
      qualReviewedAt: s.qualReviewedAt || null,
      qualRejectReason: s.qualRejectReason || ''
    }));

    res.json({ success: true, data, total, page, pageSize });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/dev/suppliers/options 供应商精简下拉选项 ============
// 供对账中心/返点规则等下拉框使用：只取 _id + name，单表查询极快
router.get('/suppliers/options', async (req, res) => {
  try {
    const list = await Supplier.find()
      .select('name status')
      .sort({ createdAt: -1 })
      .lean();
    res.json({
      success: true,
      data: list.map(s => ({ _id: s._id, name: s.name || '平台直供', status: s.status || 'pending' }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/dev/suppliers/:id/detail 供应商详情（只读预览） ============
// 基本资料（含协议/资质/4 张核验照片）+ 商品列表与定价 + 本月经营数据 + 历史结算状态
// 经营统计仅在打开详情时查询一次（避免列表页 N+1）
router.get('/suppliers/:id/detail', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id).select('-password').lean();
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    const sid = String(supplier._id);

    // 商品列表与定价
    const products = await SupplyProduct.find({ supplierId: sid })
      .select('name category unit costPrice marketPrice stock status createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // 本月经营数据：订单数（本月创建）+ 流水（本月已完成实付合计）+ 应付返点（实时预估/已结算取实际）
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthKey = rebate.monthKeyOf(now);
    const [monthOrderCount, monthTurnoverAgg, monthSettlement, settlements] = await Promise.all([
      PurchaseOrder.countDocuments({ supplierId: sid, createdAt: { $gte: monthStart } }),
      PurchaseOrder.aggregate([
        { $match: { supplierId: supplier._id, createdAt: { $gte: monthStart }, status: '已完成' } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $cond: [
                  { $gt: [{ $ifNull: ['$actualPayAmount', 0] }, 0] },
                  '$actualPayAmount',
                  { $ifNull: ['$totalAmount', 0] }
                ]
              }
            }
          }
        }
      ]),
      RebateSettlement.findOne({ month: monthKey, supplierId: sid }).lean(),
      RebateSettlement.find({ supplierId: sid }).sort({ month: -1, settledAt: -1 }).limit(12).lean()
    ]);

    const monthTurnover = (monthTurnoverAgg[0] && monthTurnoverAgg[0].total) || 0;
    let monthRebate;
    let settleStatus = '未结算';
    let overdue = false;
    if (monthSettlement) {
      monthRebate = +Number(monthSettlement.totalRebateAmount || 0).toFixed(2);
      settleStatus = rebate.normalizeSettlementStatus(monthSettlement.status);
      overdue = rebate.isSettlementOverdue(monthSettlement);
    } else {
      try {
        const calc = await rebate.calcSupplierMonthRebate(sid, monthKey);
        monthRebate = calc.totalRebate;
      } catch (e) {
        monthRebate = 0;
      }
    }

    const qual = supplier.qualification || {};
    res.json({
      success: true,
      data: {
        profile: {
          _id: supplier._id,
          name: supplier.name || '平台直供',
          loginAccount: supplier.loginAccount || '—',
          contact: supplier.contact || '—',
          phone: supplier.phone || '—',
          categories: Array.isArray(supplier.categories) ? supplier.categories : [],
          minOrderAmount: Number(supplier.minOrderAmount) > 0 ? Number(supplier.minOrderAmount) : 300,
          // 返点模式：unified=统一全品类阶梯 / byCategory=按品类分类阶梯（默认 unified）
          rebateMode: supplier.rebateMode === 'byCategory' ? 'byCategory' : 'unified',
          rebateModeLogs: Array.isArray(supplier.rebateModeLogs) ? supplier.rebateModeLogs : [],
          createdAt: supplier.createdAt,
          status: supplier.status || 'pending',
          rejectReason: supplier.rejectReason || '',
          frozenReason: supplier.frozenReason || '',
          approvedAt: supplier.approvedAt || null,
          agreementSigned: !!supplier.agreementSigned,
          agreementSignedAt: supplier.agreementSignedAt || null,
          orderEnabled: !!supplier.orderEnabled,
          orderEnabledAt: supplier.orderEnabledAt || null,
          qualification: {
            status: qual.status || 'none',
            businessLicense: qual.businessLicense || '',
            storeFront: qual.storeFront || '',
            storeInterior: qual.storeInterior || '',
            goods: qual.goods || '',
            submittedAt: qual.submittedAt || null,
            reviewedAt: qual.reviewedAt || null,
            rejectReason: qual.rejectReason || ''
          }
        },
        products: products.map(p => ({
          _id: p._id, name: p.name, category: p.category || '未分类', unit: p.unit || '个',
          costPrice: Number(p.costPrice) || 0, marketPrice: Number(p.marketPrice) || 0,
          stock: Number(p.stock) || 0, status: p.status || '上架'
        })),
        monthStats: {
          month: monthKey,
          orderCount: monthOrderCount,
          turnover: +Number(monthTurnover).toFixed(2),
          rebate: +Number(monthRebate).toFixed(2),
          settleStatus,
          overdue
        },
        settlements: settlements.map(h => ({
          month: h.month,
          totalPurchaseAmount: h.totalPurchaseAmount,
          totalRebateAmount: h.totalRebateAmount,
          settledAt: h.settledAt,
          status: rebate.normalizeSettlementStatus(h.status),
          confirmedAt: h.confirmedAt || null,
          paidAt: h.paidAt || null,
          overdue: rebate.isSettlementOverdue(h)
        }))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 供应商治理操作（审核/冻结/清退/开通接单）============
// 工具：从 body 安全提取字符串原因
function safeReason(body) {
  const r = String((body && body.reason) || '').trim();
  return r.slice(0, 200);
}

// PUT /api/dev/suppliers/:id/approve  审核通过：pending → active，记录 approvedAt
router.put('/suppliers/:id/approve', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    if (supplier.status === 'active') {
      return res.json({ success: true, message: '该供应商已是审核通过状态', data: { status: 'active' } });
    }
    supplier.status = 'active';
    supplier.rejectReason = '';
    supplier.frozenReason = '';
    if (!supplier.approvedAt) supplier.approvedAt = new Date();
    await supplier.save();
    res.json({ success: true, message: '已审核通过，供应商可登录签署协议', data: { status: 'active', approvedAt: supplier.approvedAt } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/suppliers/:id/reject  审核拒绝：pending → rejected，可填拒绝原因
router.put('/suppliers/:id/reject', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    supplier.status = 'rejected';
    supplier.rejectReason = safeReason(req.body);
    await supplier.save();
    res.json({ success: true, message: '已拒绝该供应商入驻申请', data: { status: 'rejected', rejectReason: supplier.rejectReason } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/suppliers/:id/freeze  冻结：任意状态 → frozen，可填冻结原因
// 冻结后：店铺从采购商城隐藏、不能接新单、在途订单可正常完成
router.put('/suppliers/:id/freeze', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    if (supplier.status === 'frozen') {
      return res.json({ success: true, message: '该供应商已被冻结', data: { status: 'frozen' } });
    }
    // 保留冻结前状态，便于解冻恢复（仅 active 可直接恢复；pending/rejected 解冻后仍需审核）
    supplier._preFreezeStatus = supplier.status;
    supplier.status = 'frozen';
    supplier.frozenReason = safeReason(req.body);
    supplier.orderEnabled = false; // 冻结同时关闭接单
    await supplier.save();
    res.json({ success: true, message: '已冻结该供应商，店铺已从采购商城隐藏', data: { status: 'frozen', frozenReason: supplier.frozenReason } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/suppliers/:id/unfreeze  解冻：frozen → active
router.put('/suppliers/:id/unfreeze', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    if (supplier.status !== 'frozen') {
      return res.json({ success: true, message: '该供应商未处于冻结状态', data: { status: supplier.status } });
    }
    // 解冻后回到 active（如原先是 pending/rejected，需开发者重新走审核流程或直接通过 approve）
    // 若冻结前已签协议且已开通接单，解冻后自动恢复接单权限，商品重新上架到采购商城
    supplier.status = 'active';
    supplier.frozenReason = '';
    if (supplier.agreementSigned) {
      supplier.orderEnabled = true;
    }
    await supplier.save();
    res.json({ success: true, message: '已解冻，供应商可重新登录控制台', data: { status: 'active', orderEnabled: supplier.orderEnabled } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/suppliers/:id/order-enable  开通/暂停接单开关
// body: { enabled: true|false }；前置：status=active && agreementSigned=true 才可开通
router.put('/suppliers/:id/order-enable', async (req, res) => {
  try {
    const enabled = req.body && req.body.enabled === true;
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    if (enabled) {
      if (supplier.status !== 'active') {
        return res.status(400).json({ success: false, message: '供应商未通过审核，无法开通接单' });
      }
      if (!supplier.agreementSigned) {
        return res.status(400).json({ success: false, message: '供应商尚未签署合作协议，无法开通接单' });
      }
      supplier.orderEnabled = true;
      if (!supplier.orderEnabledAt) supplier.orderEnabledAt = new Date();
    } else {
      supplier.orderEnabled = false;
    }
    await supplier.save();
    res.json({
      success: true,
      message: enabled ? '已开通接单权限，店铺将出现在采购商城' : '已暂停接单，店铺从采购商城隐藏',
      data: { orderEnabled: supplier.orderEnabled, orderEnabledAt: supplier.orderEnabledAt }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/suppliers/:id/rebate-mode  切换供应商返点模式（开发者在供应商同意后切换）
// body: { mode: 'unified' | 'byCategory' }
//   unified    = 统一全品类阶梯返点（默认，整单/整月累计额定档）
//   byCategory = 按品类分类阶梯返点（低/中/高毛利三档分别定档）
// 审计：切换记录写入 Supplier.rebateModeLogs（who/when/from/to）并输出服务端日志
router.put('/suppliers/:id/rebate-mode', async (req, res) => {
  try {
    const mode = String((req.body && req.body.mode) || '').trim();
    if (mode !== 'unified' && mode !== 'byCategory') {
      return res.status(400).json({ success: false, message: 'mode 只能为 unified（统一阶梯）或 byCategory（分类阶梯）' });
    }
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });

    const from = supplier.rebateMode === 'byCategory' ? 'byCategory' : 'unified';
    if (from === mode) {
      return res.json({ success: true, message: '该供应商已是此返点模式，无需切换', data: { rebateMode: mode } });
    }

    // 操作人（开发者账号名）
    let operator = 'dev';
    try {
      const Admin = require('../models/Admin');
      const admin = await Admin.findById(req.user && req.user.userId).select('username name').lean();
      if (admin) operator = `${admin.name || '开发者'}(${admin.username})`;
    } catch (e) { /* 身份查询失败不阻断切换，操作人记 dev */ }

    supplier.rebateMode = mode;
    supplier.rebateModeLogs = Array.isArray(supplier.rebateModeLogs) ? supplier.rebateModeLogs : [];
    supplier.rebateModeLogs.push({ by: operator, at: new Date(), from, to: mode });
    await supplier.save();

    const modeText = mode === 'byCategory' ? '按品类分类阶梯返点（低/中/高毛利三档）' : '统一全品类阶梯返点';
    console.log(`[DEV] 供应商「${supplier.name}」返点模式切换：${from} → ${mode}；操作人：${operator}；时间：${new Date().toISOString()}`);
    res.json({
      success: true,
      message: `已切换为「${modeText}」，次月结算起按新模式执行`,
      data: { rebateMode: mode, from, to: mode, switchedAt: new Date(), by: operator }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 供应商资质核验（开通接单的"一道闸门"）============
// PUT /api/dev/suppliers/:id/qualification/approve  核验通过 → 正式开通接单
// 前置：status=active && agreementSigned && qualification.status=pending
// 通过后：qualification.status=approved + orderEnabled=true（店铺上线采购商城）
router.put('/suppliers/:id/qualification/approve', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    if (supplier.status !== 'active') {
      return res.status(400).json({ success: false, message: '供应商未通过入驻审核，无法开通接单' });
    }
    if (!supplier.agreementSigned) {
      return res.status(400).json({ success: false, message: '供应商尚未签署合作协议，无法开通接单' });
    }
    const qual = supplier.qualification || {};
    if (qual.status !== 'pending') {
      if (qual.status === 'approved' && supplier.orderEnabled) {
        return res.json({ success: true, message: '该供应商已开通接单', data: { orderEnabled: true } });
      }
      return res.status(400).json({ success: false, message: '该供应商尚未提交资质或资质不在核验中状态' });
    }
    // 4 张照片必须齐全（防御性校验，提交接口已保证）
    const missing = ['businessLicense', 'storeFront', 'storeInterior', 'goods']
      .filter(f => !String(qual[f] || '').trim());
    if (missing.length) {
      return res.status(400).json({ success: false, message: '资质照片不完整，无法核验通过' });
    }
    supplier.set({
      'qualification.status': 'approved',
      'qualification.reviewedAt': new Date(),
      'qualification.rejectReason': '',
      orderEnabled: true
    });
    if (!supplier.orderEnabledAt) supplier.orderEnabledAt = new Date();
    await supplier.save();
    res.json({
      success: true,
      message: '核验通过，已开通接单，供应商店铺正式上线采购商城',
      data: { orderEnabled: true, qualStatus: 'approved', orderEnabledAt: supplier.orderEnabledAt }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/suppliers/:id/qualification/reject  核验驳回：qualification.status=rejected + 原因（供应商端可见）
// 驳回后供应商可修改资质重新提交（重新进入 pending）；orderEnabled 保持 false
router.put('/suppliers/:id/qualification/reject', async (req, res) => {
  try {
    const reason = safeReason(req.body);
    if (!reason) {
      return res.status(400).json({ success: false, message: '请填写驳回原因（供应商端可见）' });
    }
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    const qual = supplier.qualification || {};
    if (qual.status !== 'pending') {
      return res.status(400).json({ success: false, message: '该供应商资质不在核验中状态' });
    }
    supplier.set({
      'qualification.status': 'rejected',
      'qualification.reviewedAt': new Date(),
      'qualification.rejectReason': reason
    });
    await supplier.save();
    res.json({
      success: true,
      message: '已驳回资质申请，供应商可看到驳回原因并重新提交',
      data: { qualStatus: 'rejected', rejectReason: reason }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 开发者后台待办红点 ============
// GET /api/dev/todos 返回：
//   pendingRegistrations  待审核入驻申请总数（总览待办卡片用，绝对值）
//   pendingQualifications 待核验资质申请总数（总览待办卡片用，绝对值）
//   unreadTotal           未读合计（侧边栏红点用：上次查看之后新出现的待办）
router.get('/todos', async (req, res) => {
  try {
    const cfg = await PlatformConfig.getSingleton();
    const readAt = cfg.supplierTodoReadAt || null;

    const [pendingRegistrations, pendingQualifications, unreadReg, unreadQual] = await Promise.all([
      Supplier.countDocuments({ status: 'pending' }),
      Supplier.countDocuments({ 'qualification.status': 'pending' }),
      readAt
        ? Supplier.countDocuments({ status: 'pending', createdAt: { $gt: new Date(readAt) } })
        : Supplier.countDocuments({ status: 'pending' }),
      readAt
        ? Supplier.countDocuments({ 'qualification.status': 'pending', 'qualification.submittedAt': { $gt: new Date(readAt) } })
        : Supplier.countDocuments({ 'qualification.status': 'pending' })
    ]);

    res.json({
      success: true,
      data: {
        pendingRegistrations,
        pendingQualifications,
        unreadRegistrations: unreadReg,
        unreadQualifications: unreadQual,
        unreadTotal: unreadReg + unreadQual,
        readAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/dev/todos/read  进入供应商管理页时标记已读（红点消除，类似微信未读）
router.post('/todos/read', async (req, res) => {
  try {
    const now = new Date();
    await PlatformConfig.updateOne(
      { key: 'platform' },
      { $set: { supplierTodoReadAt: now } },
      { upsert: true }
    );
    res.json({ success: true, data: { readAt: now } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 平台全局配置（系统设置）============
// GET /api/dev/config 读取平台配置
router.get('/config', async (req, res) => {
  try {
    const cfg = await PlatformConfig.getSingleton();
    res.json({
      success: true,
      data: { platformCompanyName: cfg.platformCompanyName || '' }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/config 更新平台配置（目前仅甲方营业执照全称）
router.put('/config', async (req, res) => {
  try {
    const platformCompanyName = String((req.body && req.body.platformCompanyName) || '').trim().slice(0, 100);
    const cfg = await PlatformConfig.findOneAndUpdate(
      { key: 'platform' },
      { $set: { platformCompanyName } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({
      success: true,
      message: '平台配置已保存',
      data: { platformCompanyName: cfg.platformCompanyName || '' }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/dev/suppliers/:id  清退删除（二次确认由前端弹窗保证）
// 同时删除该供应商的商品；保留历史采购订单（含 supplierName 快照）用于对账
router.delete('/suppliers/:id', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    const sid = String(supplier._id);
    // 删除该供应商的上架商品（采购订单上的商品快照不受影响）
    const SupplyProduct = require('../models/SupplyProduct');
    await SupplyProduct.deleteMany({ supplierId: sid });
    await Supplier.deleteOne({ _id: sid });
    res.json({ success: true, message: '供应商已清退，上架商品已删除，历史订单与结算记录保留' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/dev/reconciliation 对账中心 ============
// 查询参数：
//   month      格式 "2026-09"，缺省为当月
//   supplierId 供应商 ObjectId，缺省查全部
// 条件：status = '已完成' 且 createdAt 在指定月份内
// 返回每条含：订单号/商家名/供应商名/下单日期/订单总额/券抵扣/实付金额
//            平台返点收入(totalAmount×8%)/抵用券成本/平台净利（后端计算，前端不算）
// 另返回 summary 汇总：订单数/订单总额/返点收入合计/券成本合计/净利合计
router.get('/reconciliation', async (req, res) => {
  try {
    // 解析月份
    let month = String(req.query.month || '');
    let y, m;
    if (/^\d{4}-\d{2}$/.test(month)) {
      y = parseInt(month.slice(0, 4), 10);
      m = parseInt(month.slice(5, 7), 10);
    } else {
      const now = new Date();
      y = now.getFullYear();
      m = now.getMonth() + 1;
      month = `${y}-${String(m).padStart(2, '0')}`;
    }
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 1); // 下月 1 号 0 点（开区间上界）

    const filter = { status: '已完成', createdAt: { $gte: monthStart, $lt: monthEnd } };
    if (req.query.supplierId && req.query.supplierId !== 'all') {
      filter.supplierId = req.query.supplierId;
    }

    const orders = await PurchaseOrder.find(filter)
      .populate('supplierId', 'name')
      .sort({ createdAt: 1 })
      .lean();

    // shopId 为字符串字段无法 populate，手动批量补全商家名（订单上未存 shopName 时兜底）
    const shopIds = [...new Set(orders.map(o => o.shopId).filter(Boolean))];
    const accounts = shopIds.length
      ? await ShopAccount.find({ shopId: { $in: shopIds } }).select('shopId shopName -_id').lean()
      : [];
    const shopNameMap = {};
    accounts.forEach(a => { shopNameMap[a.shopId] = a.shopName; });

    // 返点口径准备：已结算月份取结算记录的分品类综合费率；未结算月份按规则实时计算分品类边际费率
    const supplierIds = [...new Set(orders.map(o => String(o.supplierId && o.supplierId._id ? o.supplierId._id : o.supplierId)).filter(Boolean))];
    const settleDocs = await RebateSettlement.find({ month, supplierId: { $in: supplierIds } }).lean();
    const settleMap = new Map(settleDocs.map(s => [String(s.supplierId), s]));
    const rateMapCache = new Map();
    // 返回 { map: 品类→费率, allRate: 统一模式整单费率（null=非统一模式） }
    async function getCategoryRateMap(sid) {
      if (rateMapCache.has(sid)) return rateMapCache.get(sid);
      const map = new Map();
      let allRate = null;
      const applyDetails = (details) => {
        (details || []).forEach(d => {
          const rate = Number(d.rate != null ? d.rate : d.tierRate) || 0;
          map.set(d.category, rate);
          // 统一模式明细为一条「全部」，其费率适用于所有品类行
          if (d.category === rebate.ALL_CATEGORY || d.marginType === 'unified') allRate = rate;
        });
      };
      const settled = settleMap.get(sid);
      if (settled) {
        applyDetails(settled.details);
        if (settled.rebateMode === 'unified') {
          // 历史结算单无 rebateMode 字段但明细只有一条「全部」时，applyDetails 已捕获 allRate
        }
      } else {
        const calc = await rebate.calcSupplierMonthRebate(sid, month);
        applyDetails(calc.categories);
        if (calc.rebateMode === 'unified') allRate = Number(calc.categories[0] && calc.categories[0].tierRate) || allRate;
      }
      const result = { map, allRate };
      rateMapCache.set(sid, result);
      return result;
    }

    // 逐单计算对账字段（后端计算，前端只渲染）
    // 返点收入优先级：已结算实际返点 actualRebateAmount → 完成时预估返点 preRebate
    //                → 老订单兜底：订单分品类金额 × 当月该供应商分品类费率（无规则走默认兜底率）
    const data = [];
    for (const o of orders) {
      const totalAmount = +Number(o.totalAmount || 0).toFixed(2);
      const couponCost = +Number(o.discountAmount || 0).toFixed(2);

      let rebateIncome;
      let rebateKind = 'estimate';
      if (o.actualRebateAmount != null && Number(o.actualRebateAmount) >= 0) {
        rebateIncome = +Number(o.actualRebateAmount).toFixed(2);
        rebateKind = 'actual';
      } else if (Number(o.preRebate) > 0) {
        rebateIncome = +Number(o.preRebate).toFixed(2);
        rebateKind = 'estimate';
      } else {
        const sid = String(o.supplierId && o.supplierId._id ? o.supplierId._id : o.supplierId);
        const { map: rateMap, allRate } = await getCategoryRateMap(sid);
        let sum = 0;
        (o.items || []).forEach(it => {
          const cat = it.category || '未分类';
          // 统一模式（整单费率）优先；分类模式按品类费率；都取不到走兜底费率
          let rate;
          if (rateMap.has(cat)) rate = rateMap.get(cat);
          else if (allRate != null) rate = allRate;
          else rate = rebate.DEFAULT_REBATE_RATE;
          sum += (Number(it.totalPrice) || 0) * rate;
        });
        rebateIncome = +sum.toFixed(2);
        rebateKind = settleMap.has(sid) ? 'actual' : 'fallback';
      }
      const profit = +(rebateIncome - couponCost).toFixed(2);

      data.push({
        _id: o._id,
        orderNo: o.orderNo || '—',
        shopName: o.shopName || shopNameMap[o.shopId] || '未知商家',
        supplierName: (o.supplierId && o.supplierId.name) || '平台直供',
        createdAt: o.createdAt,
        totalAmount,
        couponCost,
        actualPayAmount: +Number(o.actualPayAmount != null ? o.actualPayAmount : o.totalAmount || 0).toFixed(2),
        rebateIncome,
        rebateKind,
        rebateSettled: !!o.rebateSettled,
        profit,
        status: o.status
      });
    }

    const summary = {
      orderCount: data.length,
      totalAmount: +data.reduce((s, o) => s + o.totalAmount, 0).toFixed(2),
      rebateIncome: +data.reduce((s, o) => s + o.rebateIncome, 0).toFixed(2),
      couponCost: +data.reduce((s, o) => s + o.couponCost, 0).toFixed(2),
      profit: +data.reduce((s, o) => s + o.profit, 0).toFixed(2)
    };

    res.json({ success: true, month, data, summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 返点规则管理 ============
// 费率单位统一为小数（0.05 = 5%），前端展示时 ×100 格式化；规则是返点率的唯一权威数据源

// GET /api/dev/rebate/rules  全量返点规则（含供应商名）
router.get('/rebate/rules', async (req, res) => {
  try {
    const rules = await RebateRule.find()
      .populate('supplierId', 'name')
      .sort({ createdAt: -1 })
      .lean();
    const data = rules.map(r => ({
      ...r,
      tiers: rebate.normalizeTiers(r.tiers),
      supplierName: (r.supplierId && r.supplierId.name) || '—'
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/dev/rebate/rules  新建/覆盖规则（supplierId + category 唯一，重复即覆盖）
router.post('/rebate/rules', async (req, res) => {
  try {
    const { supplierId, category, tiers, effectiveDate, remark, enabled } = req.body || {};
    if (!supplierId) {
      return res.status(400).json({ success: false, message: 'supplierId 不能为空' });
    }
    const supplier = await Supplier.findById(supplierId).select('name').lean();
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    const validateError = rebate.validateTiers(tiers);
    if (validateError) {
      return res.status(400).json({ success: false, message: validateError });
    }
    const cat = String(category || '').trim() || rebate.ALL_CATEGORY;
    const normalizedTiers = rebate.normalizeTiers(tiers);

    const rule = await RebateRule.findOneAndUpdate(
      { supplierId, category: cat },
      {
        $set: {
          tiers: normalizedTiers,
          enabled: enabled !== false,
          effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
          remark: remark || ''
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ success: true, data: rule, message: '返点规则已保存' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/rebate/rules/:id  编辑规则
router.put('/rebate/rules/:id', async (req, res) => {
  try {
    const rule = await RebateRule.findById(req.params.id);
    if (!rule) {
      return res.status(404).json({ success: false, message: '返点规则不存在' });
    }
    const { category, tiers, effectiveDate, remark, enabled } = req.body || {};

    if (tiers !== undefined) {
      const validateError = rebate.validateTiers(tiers);
      if (validateError) {
        return res.status(400).json({ success: false, message: validateError });
      }
      rule.tiers = rebate.normalizeTiers(tiers);
    }
    if (category !== undefined) {
      rule.category = String(category).trim() || rebate.ALL_CATEGORY;
    }
    if (enabled !== undefined) rule.enabled = !!enabled;
    if (effectiveDate !== undefined) rule.effectiveDate = new Date(effectiveDate);
    if (remark !== undefined) rule.remark = remark;

    try {
      await rule.save();
    } catch (e) {
      if (e && e.code === 11000) {
        return res.status(409).json({ success: false, message: '该供应商已存在同品类规则，请勿重复' });
      }
      throw e;
    }
    res.json({ success: true, data: rule, message: '返点规则已更新' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/dev/rebate/rules/:id  删除规则（删除后该供应商该品类回退为默认兜底率）
router.delete('/rebate/rules/:id', async (req, res) => {
  try {
    const rule = await RebateRule.findByIdAndDelete(req.params.id);
    if (!rule) {
      return res.status(404).json({ success: false, message: '返点规则不存在' });
    }
    res.json({ success: true, message: '返点规则已删除（该品类将回退为默认兜底返点率）' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 返点概览（对账中心） ============
// GET /api/dev/rebate/overview?month=YYYY-MM
// 返回每个供应商：本月采购总额、分品类明细、当前档位、预估/实际返点、距下一档差额、结算状态
router.get('/rebate/overview', async (req, res) => {
  try {
    let month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) month = rebate.monthKeyOf(new Date());
    const data = await rebate.getMonthOverview(month);
    res.json({ success: true, month, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 月度返点结算 ============
// POST /api/dev/rebate/settle  body: { month: 'YYYY-MM' }（缺省结算当月）
// 生成 RebateSettlement 记录、回写订单 actualRebateAmount、实际返点计入供应商余额；幂等（已结算供应商跳过）
router.post('/rebate/settle', async (req, res) => {
  try {
    let month = String((req.body && req.body.month) || '');
    if (!/^\d{4}-\d{2}$/.test(month)) month = rebate.monthKeyOf(new Date());
    const result = await rebate.settleMonth(month);
    res.json({
      success: true,
      data: result,
      message: `结算完成：新结算 ${result.settled.length} 家，跳过已结算 ${result.skipped.length} 家`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 得币倍率配置（品类 → 鼎恒币倍率）============
// 倍率唯一权威来源为 CoinRule 集合（开发者控制台配置），未配置品类按 1 倍计；
// 「其他」作为未知品类兜底。商家端只能看到倍率本身，看不到与返点率的任何关联。

// GET /api/dev/coin-rules  全量品类倍率配置清单（含未配置品类，倍率显示默认 1 倍）
router.get('/coin-rules', async (req, res) => {
  try {
    const data = await coinRule.getRuleView();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/dev/coin-rules  批量保存倍率配置
// body: { rules: [{ category, multiplier, enabled }] }，按 category upsert，保存即生效
router.post('/coin-rules', async (req, res) => {
  try {
    const rules = req.body && Array.isArray(req.body.rules) ? req.body.rules : null;
    if (!rules || rules.length === 0) {
      return res.status(400).json({ success: false, message: 'rules 配置数组不能为空' });
    }
    for (const r of rules) {
      const category = String((r && r.category) || '').trim();
      if (!category) continue;
      const multiplier = Number(r.multiplier);
      if (isNaN(multiplier) || multiplier < 0 || multiplier > 10) {
        return res.status(400).json({ success: false, message: `品类「${category}」的倍率必须为 0~10 之间的数字` });
      }
      await CoinRule.findOneAndUpdate(
        { category },
        { $set: { multiplier, enabled: r.enabled !== false, remark: r.remark || '' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
    const data = await coinRule.getRuleView();
    res.json({ success: true, data, message: '得币倍率配置已保存，即时生效' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 历史结算记录 ============
// GET /api/dev/rebate/settlements?month=YYYY-MM&supplierId=xxx
// 附 status（规范为 待结算/已确认/已收款）、overdue（超 15 天未收款）、confirmedAt、paidAt
router.get('/rebate/settlements', async (req, res) => {
  try {
    const filter = {};
    if (req.query.month) filter.month = req.query.month;
    if (req.query.supplierId && req.query.supplierId !== 'all') filter.supplierId = req.query.supplierId;
    const list = await RebateSettlement.find(filter)
      .sort({ month: -1, settledAt: -1 })
      .lean();
    const data = list.map(s => ({
      _id: s._id,
      month: s.month,
      supplierId: s.supplierId,
      supplierName: s.supplierName,
      // 返点模式与明细毛利档（历史数据无字段时兜底 unified）
      rebateMode: s.rebateMode === 'byCategory' ? 'byCategory' : 'unified',
      totalPurchaseAmount: s.totalPurchaseAmount,
      totalRebateAmount: s.totalRebateAmount,
      details: (s.details || []).map(detail => ({ ...detail, marginType: detail.marginType || 'unified' })),
      status: rebate.normalizeSettlementStatus(s.status),
      settledAt: s.settledAt,
      confirmedAt: s.confirmedAt || null,
      paidAt: s.paidAt || null,
      overdue: rebate.isSettlementOverdue(s),
      remark: s.remark || ''
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 结算单状态流转 ============
// PUT /api/dev/rebate/settlements/:id/confirm  待结算 → 已确认
router.put('/rebate/settlements/:id/confirm', async (req, res) => {
  try {
    const doc = await RebateSettlement.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: '结算单不存在' });
    const cur = rebate.normalizeSettlementStatus(doc.status);
    if (cur === '已收款') return res.status(400).json({ success: false, message: '该结算单已标记为已收款，不可再确认' });
    if (cur === '已确认') return res.json({ success: true, message: '该结算单已确认', data: { status: '已确认' } });
    doc.status = '已确认';
    doc.confirmedAt = new Date();
    await doc.save();
    res.json({ success: true, message: '结算单已确认', data: { status: '已确认', confirmedAt: doc.confirmedAt } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/rebate/settlements/:id/paid  已确认 → 已收款
router.put('/rebate/settlements/:id/paid', async (req, res) => {
  try {
    const doc = await RebateSettlement.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: '结算单不存在' });
    const cur = rebate.normalizeSettlementStatus(doc.status);
    if (cur === '已收款') return res.json({ success: true, message: '该结算单已标记为已收款', data: { status: '已收款' } });
    // 允许从 待结算 直接收款（兼容跳过确认的快速流程）
    doc.status = '已收款';
    doc.paidAt = new Date();
    if (!doc.confirmedAt) doc.confirmedAt = new Date();
    await doc.save();
    res.json({ success: true, message: '结算单已标记为已收款', data: { status: '已收款', paidAt: doc.paidAt } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 各商家营销活动总览（只读）============
// GET /api/dev/marketing  返回全平台所有商家的营销活动，附商家名
router.get('/marketing', async (req, res) => {
  try {
    const list = await Marketing.find().sort({ createdAt: -1 }).lean();
    const shopIds = [...new Set(list.map(m => m.shopId).filter(Boolean))];
    const accounts = shopIds.length
      ? await ShopAccount.find({ shopId: { $in: shopIds } }).select('shopId shopName -_id').lean()
      : [];
    const nameMap = {};
    accounts.forEach(a => { nameMap[a.shopId] = a.shopName; });

    const TYPE_NAME = { fullReduction: '满减', discount: '折扣', rechargeBonus: '充值送' };
    const now = new Date();
    const data = list.map(m => {
      const inWindow = (!m.startTime || m.startTime <= now) && (!m.endTime || m.endTime >= now);
      const active = m.enabled && inWindow;
      return {
        _id: m._id,
        shopId: m.shopId,
        shopName: m.shopName || nameMap[m.shopId] || '未命名商家',
        type: m.type,
        typeName: TYPE_NAME[m.type] || m.type,
        threshold: m.threshold,
        reduce: m.reduce,
        rate: m.rate,
        category: m.category,
        recharge: m.recharge,
        bonus: m.bonus,
        title: m.title,
        startTime: m.startTime,
        endTime: m.endTime,
        enabled: m.enabled,
        inWindow,
        active,
        createdAt: m.createdAt
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
