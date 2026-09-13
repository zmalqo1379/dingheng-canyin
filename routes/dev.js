const express = require('express');
const router = express.Router();

const ShopAccount = require('../models/ShopAccount');
const Supplier = require('../models/Supplier');
const SupplyProduct = require('../models/SupplyProduct');
const PriceCheck = require('../models/PriceCheck');
const PurchaseOrder = require('../models/PurchaseOrder');
const Member = require('../models/Member');
const CoinRule = require('../models/CoinRule');
const Marketing = require('../models/Marketing');
const MembershipOrder = require('../models/MembershipOrder');
const NotificationLog = require('../models/NotificationLog');
const PlatformConfig = require('../models/PlatformConfig');
const Dish = require('../models/Dish');
const Category = require('../models/Category');
const Table = require('../models/Table');
// 复用采购订单的分账发起逻辑（平台侧分账失败重试入口）
const purchaseOrdersRouter = require('./purchaseOrders');
const coinRule = require('../utils/coinRule');
const split = require('../utils/split');
const dhConfig = require('../utils/dhConfig');
const { requireDev } = require('../middlewares/auth');

// 说明：返点体系（RebateRule/RebateSettlement）与平台自动加价率（SplitRule）已随「加价分销 + 云分账」改造停用。
// 平台收入/分账口径改为直接聚合 PurchaseOrder 上的分账字段（splitAmount/supplierShare/platformShare）。
// 定价改为「定价工作台」：平台在商品列表手动填写卖价 salePrice，不做任何自动加价。

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

    // 商品列表与定价（供货价 + 平台卖价）
    const products = await SupplyProduct.find({ supplierId: sid })
      .select('name category unit costPrice salePrice stock status createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // 本月经营数据：订单数 + 流水 + 分账（供应商实得合计）
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthKey = split.monthKeyOf(now);
    const [monthOrderCount, monthTurnoverAgg, monthShareAgg] = await Promise.all([
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
      PurchaseOrder.aggregate([
        { $match: { supplierId: supplier._id, createdAt: { $gte: monthStart }, status: '已完成' } },
        { $group: { _id: null, supplierShare: { $sum: { $ifNull: ['$supplierShare', 0] } }, platformShare: { $sum: { $ifNull: ['$platformShare', 0] } } } }
      ])
    ]);

    const monthTurnover = (monthTurnoverAgg[0] && monthTurnoverAgg[0].total) || 0;
    const monthSupplierShare = (monthShareAgg[0] && monthShareAgg[0].supplierShare) || 0;
    const monthPlatformShare = (monthShareAgg[0] && monthShareAgg[0].platformShare) || 0;

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
          createdAt: supplier.createdAt,
          status: supplier.status || 'pending',
          rejectReason: supplier.rejectReason || '',
          frozenReason: supplier.frozenReason || '',
          approvedAt: supplier.approvedAt || null,
          agreementSigned: !!supplier.agreementSigned,
          agreementSignedAt: supplier.agreementSignedAt || null,
          // 协议签署记录（供应商、时间、来源 IP、设备、版本、文本哈希），供开发者后台查阅
          agreementEvidence: supplier.agreementEvidence || null,
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
        products: products.map(p => {
          const costPrice = Number(p.costPrice) || 0;
          const salePrice = split.resolveSalePrice(p.salePrice, p.costPrice);
          return {
            _id: p._id, name: p.name, category: p.category || '未分类', unit: p.unit || '个',
            costPrice, salePrice, priceDiff: +(salePrice - costPrice).toFixed(2),
            stock: Number(p.stock) || 0, status: p.status || '上架'
          };
        }),
        monthStats: {
          month: monthKey,
          orderCount: monthOrderCount,
          turnover: +Number(monthTurnover).toFixed(2),
          supplierShare: +Number(monthSupplierShare).toFixed(2),
          platformShare: +Number(monthPlatformShare).toFixed(2)
        }
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

// PUT /api/dev/suppliers/:id/wechat-sub-mchid  设置供应商微信支付特约商户号（服务商分账接收方）
// body: { wechatSubMchId: '1900000109' }；留空表示清除
router.put('/suppliers/:id/wechat-sub-mchid', async (req, res) => {
  try {
    const wechatSubMchId = String((req.body && req.body.wechatSubMchId) || '').trim().slice(0, 32);
    const supplier = await Supplier.findByIdAndUpdate(
      req.params.id,
      { $set: { wechatSubMchId } },
      { new: true, runValidators: true }
    ).select('name wechatSubMchId');
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    res.json({ success: true, message: '已保存', data: { wechatSubMchId: supplier.wechatSubMchId } });
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
    let defaultSplitSupplierName = '';
    if (cfg.defaultSplitSupplierId) {
      const s = await Supplier.findById(cfg.defaultSplitSupplierId).select('name').lean();
      defaultSplitSupplierName = s ? s.name : '';
    }
    res.json({
      success: true,
      data: {
        platformCompanyName: cfg.platformCompanyName || '',
        platformCreditCode: cfg.platformCreditCode || '',
        defaultSplitSupplierId: cfg.defaultSplitSupplierId ? String(cfg.defaultSplitSupplierId) : '',
        defaultSplitSupplierName,
        membershipSplitRate: cfg.membershipSplitRate != null ? cfg.membershipSplitRate : 6
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/config 更新平台配置（甲方营业执照 + 会员购卡分账配置）
router.put('/config', async (req, res) => {
  try {
    const body = req.body || {};
    const platformCompanyName = String(body.platformCompanyName || '').trim().slice(0, 100);
    const platformCreditCode = String(body.platformCreditCode || '').trim().slice(0, 50);

    const $set = { platformCompanyName, platformCreditCode };

    // 平台抽佣比例（0-100）
    if (body.membershipSplitRate !== undefined) {
      const rate = Number(body.membershipSplitRate);
      $set.membershipSplitRate = (isFinite(rate) && rate >= 0 && rate <= 100) ? rate : 6;
    }
    // 默认分账供应商（空字符串表示清除）
    if (body.defaultSplitSupplierId !== undefined) {
      const sid = String(body.defaultSplitSupplierId || '').trim();
      if (!sid) {
        $set.defaultSplitSupplierId = null;
      } else if (!/^[0-9a-fA-F]{24}$/.test(sid)) {
        return res.status(400).json({ success: false, message: '分账供应商 ID 格式不正确' });
      } else {
        const supplier = await Supplier.findById(sid).select('_id').lean();
        if (!supplier) {
          return res.status(400).json({ success: false, message: '指定的分账供应商不存在' });
        }
        $set.defaultSplitSupplierId = supplier._id;
      }
    }

    const cfg = await PlatformConfig.findOneAndUpdate(
      { key: 'platform' },
      { $set },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    let defaultSplitSupplierName = '';
    if (cfg.defaultSplitSupplierId) {
      const s = await Supplier.findById(cfg.defaultSplitSupplierId).select('name').lean();
      defaultSplitSupplierName = s ? s.name : '';
    }
    res.json({
      success: true,
      message: '平台配置已保存',
      data: {
        platformCompanyName: cfg.platformCompanyName || '',
        platformCreditCode: cfg.platformCreditCode || '',
        defaultSplitSupplierId: cfg.defaultSplitSupplierId ? String(cfg.defaultSplitSupplierId) : '',
        defaultSplitSupplierName,
        membershipSplitRate: cfg.membershipSplitRate != null ? cfg.membershipSplitRate : 6
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 比价工作台 ============
// GET /api/dev/price-check  列表：所有在售商品（status=上架）+ 最新外部参考价，自动比对平台售价
//   over=null 未录参考价 / true 超标（售价>参考价）/ false 正常（售价≤参考价）
//   可选 query: onlyOver=1 仅返回超标商品（用于导出清单）
router.get('/price-check', async (req, res) => {
  try {
    const onlyOver = String(req.query.onlyOver || '') === '1';
    const products = await SupplyProduct.find({ status: '上架' })
      .select('name category grade unit costPrice salePrice supplierId supplierName')
      .sort({ supplierName: 1, category: 1, name: 1 })
      .lean();
    const ids = products.map(p => p._id);
    const checks = await PriceCheck.find({ productId: { $in: ids } }).lean();
    const checkMap = {};
    for (const c of checks) checkMap[String(c.productId)] = c;

    const all = products.map(p => {
      const c = checkMap[String(p._id)];
      const refPrice = c && c.refPrice != null ? Number(c.refPrice) : null;
      // 在售售价 = 平台卖价（未定价时等于供货价）
      const price = split.resolveSalePrice(p.salePrice, p.costPrice);
      const over = refPrice == null ? null : price > refPrice;
      return {
        productId: String(p._id),
        name: p.name,
        category: p.category || '',
        grade: p.grade || null,
        unit: p.unit || '',
        price,
        supplierId: p.supplierId ? String(p.supplierId) : '',
        supplierName: p.supplierName || '',
        refPrice,
        source: c ? (c.source || '') : '',
        checkDate: c ? (c.checkDate || null) : null,
        over
      };
    });
    const overCount = all.filter(x => x.over === true).length;
    const checkedCount = all.filter(x => x.over !== null).length;
    const list = onlyOver ? all.filter(x => x.over === true) : all;
    res.json({
      success: true,
      data: {
        list,
        summary: { total: all.length, checked: checkedCount, over: overCount }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/price-check/:productId  录入/更新某在售商品的外部参考价与来源、日期
router.put('/price-check/:productId', async (req, res) => {
  try {
    const product = await SupplyProduct.findById(req.params.productId).select('_id name').lean();
    if (!product) return res.status(404).json({ success: false, message: '商品不存在' });
    const body = req.body || {};
    const refPrice = Number(body.refPrice);
    if (!isFinite(refPrice) || refPrice < 0) {
      return res.status(400).json({ success: false, message: '参考价须为非负数字' });
    }
    const source = String(body.source || '').trim().slice(0, 100);
    const checkDate = body.checkDate ? new Date(body.checkDate) : new Date();
    if (isNaN(checkDate.getTime())) {
      return res.status(400).json({ success: false, message: '参考日期不合法' });
    }
    const doc = await PriceCheck.findOneAndUpdate(
      { productId: product._id },
      { $set: { refPrice, source, checkDate } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({
      success: true,
      message: '参考价已保存',
      data: {
        productId: String(doc.productId),
        refPrice: doc.refPrice,
        source: doc.source || '',
        checkDate: doc.checkDate
      }
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

// ============ 定价工作台（加价分销：平台手动填写卖价）============
// 供应商每日更新「供货价」，平台在此手动填写「卖价」；系统不设任何自动加价公式/比例/上下限。
// 加价额 = 卖价 − 供货价，完全由平台手动决定；卖价留空/清空 = 未定价（下单时默认等于供货价）。

// GET /api/dev/pricing 定价工作台商品列表
// 查询参数：supplierId、category、keyword（可选）
// 返回每个商品：供货价 costPrice / 平台卖价 salePrice / 实时差价 priceDiff / 改价时间 / 供应商名
router.get('/pricing', async (req, res) => {
  try {
    const filter = {};
    if (req.query.supplierId && req.query.supplierId !== 'all') filter.supplierId = req.query.supplierId;
    if (req.query.category && req.query.category !== 'all') filter.category = req.query.category;
    const products = await SupplyProduct.find(filter)
      .populate('supplierId', 'name status')
      .sort({ supplierId: 1, category: 1, name: 1 })
      .lean();
    const keyword = String(req.query.keyword || '').trim();
    const data = products
      .filter(p => !keyword || String(p.name || '').includes(keyword))
      .map(p => {
        const costPrice = Number(p.costPrice) || 0;
        const hasSalePrice = p.salePrice != null && Number(p.salePrice) > 0;
        const salePrice = split.resolveSalePrice(p.salePrice, p.costPrice);
        return {
          _id: String(p._id),
          name: p.name,
          category: p.category || '未分类',
          unit: p.unit || '个',
          supplierId: p.supplierId ? String(p.supplierId._id || p.supplierId) : '',
          supplierName: (p.supplierId && p.supplierId.name) || '—',
          costPrice,                    // 供货价（供应商维护）
          salePrice,                    // 平台卖价（未定价时 = 供货价）
          priced: hasSalePrice,         // 是否已由平台定价
          priceDiff: +(salePrice - costPrice).toFixed(2), // 实时差价
          priceUpdatedAt: p.priceUpdatedAt,
          priceFrozen: !!p.priceFrozen,
          status: p.status
        };
      });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/pricing/product/:id  平台手动设置某商品卖价
// body: { salePrice }（留空 null/'' 表示取消定价，下单时默认等于供货价）
router.put('/pricing/product/:id', async (req, res) => {
  try {
    const product = await SupplyProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: '商品不存在' });
    }
    const raw = req.body ? req.body.salePrice : undefined;
    let salePrice = null;
    if (raw !== undefined && raw !== null && raw !== '') {
      const n = Number(raw);
      if (!isFinite(n) || n < 0) {
        return res.status(400).json({ success: false, message: '卖价须为非负数字' });
      }
      // 平台可自由定价，系统不设上下限（仅做非负校验）
      salePrice = +n.toFixed(2);
    }
    product.salePrice = salePrice;
    await product.save();
    const costPrice = Number(product.costPrice) || 0;
    const effective = split.resolveSalePrice(product.salePrice, product.costPrice);
    res.json({
      success: true,
      message: salePrice == null ? '已取消定价（下单默认按供货价）' : '卖价已保存',
      data: {
        _id: String(product._id),
        costPrice,
        salePrice: effective,
        priced: salePrice != null,
        priceDiff: +(effective - costPrice).toFixed(2)
      }
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

// ============ 平台收入（云分账 · 平台实得口径）============
// 加价分销：平台收入 = Σ platformShare（= 顾客实付 − 供应商实得）。仅统计已完成订单。
// 数据源：PurchaseOrder 上的分账字段（splitAmount/supplierShare/platformShare/compensate*）。
// GET /api/dev/platform-income?month=YYYY-MM
// 返回：本月总览 + 各供应商贡献 + 近 12 个月收入汇总 + 分账明细（含分账状态/流水号/补差）
router.get('/platform-income', async (req, res) => {
  try {
    const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month))
      ? req.query.month : split.monthKeyOf(new Date());
    const { start, end } = split.monthRange(month);

    const orders = await PurchaseOrder.find({ status: '已完成', receiveAt: { $gte: start, $lt: end } })
      .populate('supplierId', 'name')
      .sort({ receiveAt: -1 })
      .lean();

    const sumKeys = ['splitAmount', 'supplierShare', 'platformShare', 'compensateAmount'];
    const summary = { orderCount: 0, splitAmount: 0, supplierShare: 0, platformShare: 0, compensateAmount: 0 };
    const supMap = new Map();
    for (const o of orders) {
      summary.orderCount += 1;
      sumKeys.forEach(k => { summary[k] += Number(o[k]) || 0; });
      const sid = String((o.supplierId && o.supplierId._id) || o.supplierId);
      if (!supMap.has(sid)) {
        supMap.set(sid, {
          supplierId: sid,
          supplierName: (o.supplierId && o.supplierId.name) || '',
          orderCount: 0, splitAmount: 0, supplierShare: 0, platformShare: 0, compensateAmount: 0
        });
      }
      const it = supMap.get(sid);
      it.orderCount += 1;
      sumKeys.forEach(k => { it[k] += Number(o[k]) || 0; });
    }
    sumKeys.forEach(k => { summary[k] = +summary[k].toFixed(2); });
    const suppliers = [...supMap.values()].map(s => {
      sumKeys.forEach(k => { s[k] = +s[k].toFixed(2); });
      s.share = summary.platformShare > 0 ? +((s.platformShare / summary.platformShare) * 100).toFixed(2) : 0;
      return s;
    }).sort((a, b) => b.platformShare - a.platformShare);

    // 按月份汇总（最近 12 个月，按 receiveAt 归属）
    const monthlyAgg = await PurchaseOrder.aggregate([
      { $match: { status: '已完成', receiveAt: { $ne: null } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$receiveAt' } },
          orderCount: { $sum: 1 },
          splitAmount: { $sum: { $ifNull: ['$splitAmount', 0] } },
          supplierShare: { $sum: { $ifNull: ['$supplierShare', 0] } },
          platformShare: { $sum: { $ifNull: ['$platformShare', 0] } }
        }
      },
      { $sort: { _id: -1 } },
      { $limit: 12 }
    ]);
    const months = monthlyAgg.map(m => ({
      month: m._id,
      orderCount: m.orderCount,
      splitAmount: +(+m.splitAmount || 0).toFixed(2),
      supplierShare: +(+m.supplierShare || 0).toFixed(2),
      platformShare: +(+m.platformShare || 0).toFixed(2)
    }));

    res.json({
      success: true,
      data: {
        month,
        summary,
        suppliers,
        months,
        records: orders.slice(0, 200).map(o => ({
          _id: o._id,
          orderNo: o.orderNo,
          supplierName: (o.supplierId && o.supplierId.name) || '',
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

// ============ 分账失败列表与重试入口 ============
// GET /api/dev/split-failures  分账失败订单（含重试次数 / 错误日志），供平台人工重试
router.get('/split-failures', async (req, res) => {
  try {
    const list = await PurchaseOrder.find({ splitStatus: '分账失败' })
      .populate('supplierId', 'name')
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    res.json({
      success: true,
      data: list.map(o => ({
        _id: o._id,
        orderNo: o.orderNo,
        supplierName: (o.supplierId && o.supplierId.name) || '',
        splitAmount: Number(o.splitAmount) || 0,
        supplierShare: Number(o.supplierShare) || 0,
        platformShare: Number(o.platformShare) || 0,
        splitRetryCount: Number(o.splitRetryCount) || 0,
        splitError: o.splitError || '',
        splitLogs: o.splitLogs || [],
        updatedAt: o.updatedAt
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/dev/split-orders/:id/retry  重试某订单的分账（复用采购订单的分账发起逻辑）
router.post('/split-orders/:id/retry', async (req, res) => {
  try {
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: '采购订单不存在' });
    const supplier = await Supplier.findById(order.supplierId);
    await purchaseOrdersRouter.initiateOrderSplit(order, supplier);
    await order.save();
    res.json({ success: true, message: '已发起重试', data: { splitStatus: order.splitStatus, splitRetryCount: order.splitRetryCount, splitError: order.splitError } });
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

// ============ 会员现金购卡订单（双产品线） ============
// 等级/产品线判定统一走 dhConfig 双线配置，不再保留 LEVEL_RANK

// GET /api/dev/membership-orders?status=pending
// 平台侧查看商家的现金购卡订单，附商家当前会员等级/到期时间，便于确认收款时核对
router.get('/membership-orders', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const list = await MembershipOrder.find(filter).sort({ createdAt: -1 }).limit(200).lean();

    const shopIds = [...new Set(list.map(o => o.shopId).filter(Boolean))];
    const members = shopIds.length
      ? await Member.find({ shopId: { $in: shopIds } }).lean()
      : [];
    const memberMap = new Map(members.map(m => [m.shopId, m]));

    const TYPE_NAME = {
      basic: '点餐基础版', advanced: '点餐进阶版', premium: '点餐尊享版',
      free: '采购免费版', plus: '采购省钱卡', pro: '采购省钱卡Pro'
    };
    const data = list.map(o => {
      const mem = memberMap.get(o.shopId) || {};
      const isPurchase = o.productLine === 'purchase';
      return {
        ...o,
        productLine: isPurchase ? 'purchase' : 'pos',
        levelName: TYPE_NAME[o.level] || o.level,
        memberLevel: mem.memberLevel || 'basic',
        memberExpire: mem.memberExpire || null,
        purchaseLevel: mem.purchaseLevel || 'free',
        purchaseExpire: mem.purchaseExpire || null
      };
    });

    const pendingCount = await MembershipOrder.countDocuments({ status: 'pending' });
    res.json({ success: true, data, pendingCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/membership-orders/:id/confirm
// 确认收款并开通会员：写入 memberSource='cash'，到期时间按续费/新开通口径计算（与币兑换一致）
router.put('/membership-orders/:id/confirm', async (req, res) => {
  try {
    const order = await MembershipOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '订单不存在' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: `该订单已处理（${order.status}）` });
    }
    // 微信支付订单不走人工确认：未支付等待回调，已支付由回调自动开通
    if (order.payChannel === 'wechat') {
      return res.status(400).json({
        success: false,
        message: order.payStatus === 'paid' ? '该微信订单已支付并自动开通' : '微信支付订单请等待支付结果，无需人工确认'
      });
    }
    const productLine = order.productLine === 'purchase' ? 'purchase' : 'pos';
    const isPurchase = productLine === 'purchase';
    const pricing = isPurchase ? dhConfig.PURCHASE_PRICING : dhConfig.POS_PRICING;
    if (!pricing[order.level]) {
      return res.status(400).json({ success: false, message: '订单会员等级无效' });
    }
    const ranks = isPurchase ? dhConfig.PURCHASE_LEVELS : dhConfig.POS_LEVELS;
    const levelField = isPurchase ? 'purchaseLevel' : 'memberLevel';
    const expireField = isPurchase ? 'purchaseExpire' : 'memberExpire';
    const trialField = isPurchase ? 'purchaseIsTrial' : 'memberIsTrial';
    const sourceField = isPurchase ? 'purchaseSource' : 'memberSource';

    let member = await Member.findOne({ shopId: order.shopId });
    if (!member) member = await Member.create({ shopId: order.shopId });

    const today = new Date();
    const curExpire = member[expireField];
    const isActive = curExpire && curExpire > today;
    // 不允许按低等级订单覆盖更高等级会员
    if ((ranks[member[levelField]] ?? 0) > (ranks[order.level] ?? 0)) {
      return res.status(400).json({ success: false, message: '商家当前会员等级更高，不能按此订单开通低等级' });
    }

    // 同等级续费且有效期内 → 在现有到期时间上顺延；否则从今天起算
    const base = (member[levelField] === order.level && isActive)
      ? new Date(curExpire)
      : new Date();
    base.setDate(base.getDate() + 30 * order.months);

    member[levelField] = order.level;
    member[expireField] = base;
    member[trialField] = false;
    member[sourceField] = 'cash';
    if (!isPurchase) member.customerPointsEnabled = true;
    await member.save();

    order.status = 'paid';
    order.paidAt = new Date();
    order.confirmedBy = req.user && req.user.userId ? String(req.user.userId) : 'dev';
    order.memberExpireAfter = base;
    await order.save();

    res.json({
      success: true,
      data: {
        order,
        productLine,
        memberLevel: member.memberLevel,
        memberExpire: member.memberExpire,
        purchaseLevel: member.purchaseLevel,
        purchaseExpire: member.purchaseExpire
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/membership-orders/:id/cancel
// 取消待支付订单（如商家未付款或信息有误）
router.put('/membership-orders/:id/cancel', async (req, res) => {
  try {
    const order = await MembershipOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '订单不存在' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: `该订单已处理（${order.status}）` });
    }
    order.status = 'cancelled';
    await order.save();
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 通知发送日志 ============
// GET /api/dev/notification-logs?channel=&status=&limit=
// 查看各渠道通知的真实发送结果（success/failed/skipped），用于排查渠道配置
router.get('/notification-logs', async (req, res) => {
  try {
    const { channel, status } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 300);
    const filter = {};
    if (channel) filter.channel = channel;
    if (status) filter.status = status;
    const list = await NotificationLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
