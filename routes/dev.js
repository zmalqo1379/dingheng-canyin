const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

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
                qualRejectReason: '$qualification.rejectReason',
                // 微信进件（2026-09）：资金流 supplier_first 模式的前提
                obStatus: '$wechatOnboarding.status',
                obSubmittedAt: '$wechatOnboarding.submittedAt',
                obReviewedAt: '$wechatOnboarding.reviewedAt',
                obRejectReason: '$wechatOnboarding.rejectReason',
                wechatSubMchId: 1
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
      qualRejectReason: s.qualRejectReason || '',
      // 微信进件状态（none=未提交 / pending=审核中 / approved=已通过 / rejected=被驳回）
      obStatus: s.obStatus || 'none',
      obSubmittedAt: s.obSubmittedAt || null,
      obReviewedAt: s.obReviewedAt || null,
      obRejectReason: s.obRejectReason || '',
      wechatSubMchId: s.wechatSubMchId || ''
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
          // 【2026-09 上线加固】区分「已定价 / 待定价」：未定价（salePrice 0/null）时
          // 卖价虽按供货价兜底展示，但前台标「待定价」并高亮，避免误读为已定价且零差价
          const hasSalePrice = p.salePrice != null && Number(p.salePrice) > 0;
          const salePrice = split.resolveSalePrice(p.salePrice, p.costPrice);
          return {
            _id: p._id, name: p.name, category: p.category || '未分类', unit: p.unit || '个',
            costPrice, salePrice, priceDiff: +(salePrice - costPrice).toFixed(2),
            priced: hasSalePrice,                                  // 是否已由平台定价
            pricingStatus: hasSalePrice ? 'priced' : 'pending',     // pending=待定价（前台高亮依据）
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

// ============ 微信支付进件审核（2026-09，人工录入模式）============
// 本轮不接微信真实进件 API：供应商线上提交资料（供应商端「进件中心」）→ 平台在微信商户平台
// 代为进件 → 开发者在下面接口「approve + 录入特约商户号」或「reject + 驳回原因」。
// 通过并录入特约商户号后，该供应商的新订单走渠道分账（supplier_first：钱进供应商，平台抽加价）。
// GET /api/dev/suppliers/:id/wechat-onboarding 进件详情（银行账号脱敏，只露末 4 位）
router.get('/suppliers/:id/wechat-onboarding', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id).select('name wechatSubMchId wechatOnboarding');
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    const cryptoBox = require('../utils/cryptoBox');
    const ob = supplier.wechatOnboarding || {};
    res.json({
      success: true,
      data: {
        supplierId: supplier._id,
        supplierName: supplier.name || '',
        status: ob.status || 'none',
        businessLicenseUrl: ob.businessLicenseUrl || '',
        legalPerson: ob.legalPerson || '',
        idCardFrontUrl: ob.idCardFrontUrl || '',
        idCardBackUrl: ob.idCardBackUrl || '',
        bankAccountName: ob.bankAccountName || '',
        // 脱敏：银行账号只露末 4 位（加密落库，任何接口不回传全号）
        bankAccountNoMasked: cryptoBox.maskBankAccount(cryptoBox.decrypt(ob.bankAccountNoEnc)),
        bankName: ob.bankName || '',
        bankBranch: ob.bankBranch || '',
        contactName: ob.contactName || '',
        contactPhone: ob.contactPhone || '',
        category: ob.category || '',
        address: ob.address || '',
        submittedAt: ob.submittedAt || null,
        reviewedAt: ob.reviewedAt || null,
        rejectReason: ob.rejectReason || '',
        wechatSubMchId: supplier.wechatSubMchId || ''
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/suppliers/:id/wechat-onboarding/review 进件审核
// body: { action: 'approve', subMchId: '特约商户号' } → 状态已通过 + 录入特约商户号
//       { action: 'reject', reason: '驳回原因' }      → 状态被驳回（供应商可改后重新提交）
router.put('/suppliers/:id/wechat-onboarding/review', async (req, res) => {
  try {
    const body = req.body || {};
    const action = String(body.action || '').trim();
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });

    const obStatus = (supplier.wechatOnboarding && supplier.wechatOnboarding.status) || 'none';
    if (!['none', 'pending', 'approved', 'rejected'].includes(obStatus)) {
      return res.status(400).json({ success: false, message: '进件状态异常' });
    }

    if (action === 'approve') {
      // 人工录入模式：特约商户号必填（平台在微信商户平台完成进件后拿到的 sub_mchid）
      const subMchId = String(body.subMchId || '').trim();
      if (!/^\d{8,20}$/.test(subMchId)) {
        return res.status(400).json({ success: false, message: '请输入正确的微信特约商户号（8~20 位数字）' });
      }
      if (obStatus !== 'pending' && obStatus !== 'approved') {
        return res.status(400).json({ success: false, message: '该供应商尚未提交进件资料，不能直接标记通过' });
      }
      supplier.wechatOnboarding = supplier.wechatOnboarding || {};
      supplier.wechatOnboarding.status = 'approved';
      supplier.wechatOnboarding.reviewedAt = new Date();
      supplier.wechatOnboarding.rejectReason = '';
      supplier.wechatSubMchId = subMchId;
      await supplier.save();
      // 日志脱敏：不打印任何证件号/银行账号
      console.log(`[wechat-onboarding] 审核通过 supplierId=${supplier._id} subMchId=${subMchId}`);
      return res.json({
        success: true,
        message: '进件已标记通过并录入特约商户号，该供应商新订单将走渠道分账',
        data: { status: 'approved', wechatSubMchId: subMchId }
      });
    }

    if (action === 'reject') {
      const reason = safeReason(body);
      if (!reason) return res.status(400).json({ success: false, message: '请填写驳回原因' });
      supplier.wechatOnboarding = supplier.wechatOnboarding || {};
      supplier.wechatOnboarding.status = 'rejected';
      supplier.wechatOnboarding.reviewedAt = new Date();
      supplier.wechatOnboarding.rejectReason = reason;
      await supplier.save();
      console.log(`[wechat-onboarding] 审核驳回 supplierId=${supplier._id}`);
      return res.json({
        success: true,
        message: '进件已驳回，供应商可在「进件中心」修改后重新提交',
        data: { status: 'rejected', rejectReason: reason }
      });
    }

    return res.status(400).json({ success: false, message: 'action 只支持 approve（通过）或 reject（驳回）' });
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
// 说明：会员费分账配置（默认分账供应商/抽佣比例）已下线——会员费全额归平台，
// 云分账仅用于顾客采购货款；PlatformConfig 中的历史字段不再读取、不再下发。
// 2026-09 新增：payMode（mock 演示 / wechat 真实）与 paymentFlowMode（资金流模式）运行时读取。
router.get('/config', async (req, res) => {
  try {
    const cfg = await PlatformConfig.getSingleton();
    const payRuntime = require('../utils/payRuntime');
    await payRuntime.init();
    const wechatPay = require('../utils/wechatPay');
    res.json({
      success: true,
      data: {
        platformCompanyName: cfg.platformCompanyName || '',
        platformCreditCode: cfg.platformCreditCode || '',
        // 最低加价率（卖价底线）：卖价底线 = 供货价 × (1 + 最低加价率)
        minMarkupRate: dhConfig.resolveMinMarkupRate(cfg.minMarkupRate),
        // 最低加价率下限（3% = 平台成本线，不能再低）；前端用于输入校验与提示
        minMarkupRateHardFloor: dhConfig.MIN_MARKUP_RATE_HARD_FLOOR,
        // 支付模式：mock=演示（默认，所有交易模拟）/ wechat=真实微信支付
        payMode: payRuntime.getPayMode(),
        // 资金流模式：supplier_first=钱进供应商（默认）/ platform_first=钱进平台（需高比例分账白名单）
        paymentFlowMode: payRuntime.getPaymentFlowMode(),
        // 微信支付凭证是否已配置（切换真实支付的前置条件）
        wechatConfigured: wechatPay.isConfigured()
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/config 更新平台配置（甲方营业执照信息 + 最低加价率 + 支付模式 + 资金流模式）
// 支付模式/资金流模式通过 utils/payRuntime 写穿更新：改完立即生效，不用重启服务。
router.put('/config', async (req, res) => {
  try {
    const body = req.body || {};
    const platformCompanyName = String(body.platformCompanyName || '').trim().slice(0, 100);
    const platformCreditCode = String(body.platformCreditCode || '').trim().slice(0, 50);
    const setFields = { platformCompanyName, platformCreditCode };

    // 最低加价率（0~1 小数）：未传则不改动；传了必须合法
    // 下限为 3%（平台成本线，不能再低）；低于 5% 允许保存但前端会提示「利润会很薄」
    if (body.minMarkupRate !== undefined && body.minMarkupRate !== null && body.minMarkupRate !== '') {
      const rate = Number(body.minMarkupRate);
      if (!isFinite(rate) || rate < 0 || rate > 1) {
        return res.status(400).json({ success: false, message: '最低加价率须为 0~1 之间的小数（如 0.05 表示 5%）' });
      }
      if (rate < dhConfig.MIN_MARKUP_RATE_HARD_FLOOR) {
        const floorPct = Math.round(dhConfig.MIN_MARKUP_RATE_HARD_FLOOR * 100);
        return res.status(400).json({
          success: false,
          message: `最低加价率不得低于 ${floorPct}%（平台成本线，不能再低）`
        });
      }
      setFields.minMarkupRate = rate;
    }

    // ---- 支付模式切换（mock 演示 / wechat 真实）：立即生效 ----
    let payModeApplied = null;
    if (body.payMode !== undefined && body.payMode !== null && body.payMode !== '') {
      const payRuntime = require('../utils/payRuntime');
      if (!payRuntime.PAY_MODES.includes(body.payMode)) {
        return res.status(400).json({ success: false, message: 'payMode 只支持 mock（演示）或 wechat（真实微信支付）' });
      }
      if (body.payMode === 'wechat') {
        const wechatPay = require('../utils/wechatPay');
        if (!wechatPay.isConfigured()) {
          return res.status(400).json({ success: false, message: '微信支付凭证未配置（缺少 WXPAY_* 环境变量），不能切换到真实支付' });
        }
      }
      payModeApplied = await payRuntime.setPayMode(body.payMode);
    }

    // ---- 资金流模式切换（supplier_first / platform_first）：立即生效 ----
    let flowModeApplied = null;
    if (body.paymentFlowMode !== undefined && body.paymentFlowMode !== null && body.paymentFlowMode !== '') {
      const payRuntime = require('../utils/payRuntime');
      if (body.paymentFlowMode === 'platform_first' && !body.confirmFlowSwitch) {
        return res.status(400).json({
          success: false,
          message: '切换到「钱进平台」模式需先取得微信支付高比例分账白名单，请确认后携带 confirmFlowSwitch=true 重试'
        });
      }
      flowModeApplied = await payRuntime.setPaymentFlowMode(body.paymentFlowMode);
    }

    const cfg = await PlatformConfig.findOneAndUpdate(
      { key: 'platform' },
      { $set: setFields },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const payRuntime = require('../utils/payRuntime');
    const wechatPay = require('../utils/wechatPay');
    res.json({
      success: true,
      message: '平台配置已保存',
      data: {
        platformCompanyName: cfg.platformCompanyName || '',
        platformCreditCode: cfg.platformCreditCode || '',
        minMarkupRate: dhConfig.resolveMinMarkupRate(cfg.minMarkupRate),
        payMode: payRuntime.getPayMode(),
        paymentFlowMode: payRuntime.getPaymentFlowMode(),
        wechatConfigured: wechatPay.isConfigured()
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
// 供应商每日更新「供货价」，平台在此手动填写「卖价」；加价额 = 卖价 − 供货价，由平台手动决定。
// 底线约束：卖价 ≥ 最低卖价 = 向上取整到分( 供货价 × (1 + 最低加价率) )，最低加价率在「系统设置」配置。
// 卖价留空/清空 = 未定价（下单时默认等于供货价），属于「待定价」状态。

// GET /api/dev/pricing 定价工作台商品列表
// 查询参数：supplierId、category、keyword、onlyUnderpriced=1（仅待定价，可选）
// 返回每个商品：供货价 costPrice / 平台卖价 salePrice / 最低卖价 minSalePrice / 实时差价 / 改价时间 / 供应商名
router.get('/pricing', async (req, res) => {
  try {
    const filter = {};
    if (req.query.supplierId && req.query.supplierId !== 'all') filter.supplierId = req.query.supplierId;
    if (req.query.category && req.query.category !== 'all') filter.category = req.query.category;
    const products = await SupplyProduct.find(filter)
      .populate('supplierId', 'name status')
      .sort({ supplierId: 1, category: 1, name: 1 })
      .lean();
    // 最低加价率（系统设置）
    const cfg = await PlatformConfig.getSingleton();
    const minMarkupRate = dhConfig.resolveMinMarkupRate(cfg.minMarkupRate);
    const onlyUnderpriced = String(req.query.onlyUnderpriced || '') === '1';
    const keyword = String(req.query.keyword || '').trim();
    const data = products
      .filter(p => !keyword || String(p.name || '').includes(keyword))
      .map(p => {
        const costPrice = Number(p.costPrice) || 0;
        const hasSalePrice = p.salePrice != null && Number(p.salePrice) > 0;
        const salePrice = split.resolveSalePrice(p.salePrice, p.costPrice);
        const minSalePrice = dhConfig.computeMinSalePrice(costPrice, minMarkupRate);
        // 【2026-09 上线加固】后台高亮：pending=未定价（salePrice ≤ 0）/ underfloor=已定价但低于底线
        const pricingStatus = hasSalePrice ? 'priced' : 'pending';
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
          pricingStatus,                // 'priced' 已定价 / 'pending' 待定价（后台高亮依据）
          isManualPrice: !!p.isManualPrice, // 是否手动定价（一键定价跳过此商品）
          minSalePrice,                 // 最低卖价（供货价 × (1 + 最低加价率)）
          belowFloor: +Number(salePrice).toFixed(2) < minSalePrice, // 未定价或低于底线 → 待定价
          priceDiff: +(salePrice - costPrice).toFixed(2), // 实时差价
          priceUpdatedAt: p.priceUpdatedAt,
          priceFrozen: !!p.priceFrozen,
          status: p.status
        };
      })
      .filter(p => !onlyUnderpriced || p.belowFloor);
    res.json({ success: true, data, minMarkupRate });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/dev/pricing/product/:id  平台手动设置某商品卖价
// body: { salePrice }（留空 null/'' 表示取消定价，下单时默认等于供货价）
// 校验：卖价不得低于最低卖价 = 供货价 × (1 + 最低加价率)
router.put('/pricing/product/:id', async (req, res) => {
  try {
    const product = await SupplyProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: '商品不存在' });
    }
    const cfg = await PlatformConfig.getSingleton();
    const minMarkupRate = dhConfig.resolveMinMarkupRate(cfg.minMarkupRate);
    const costPrice = Number(product.costPrice) || 0;
    const minSalePriceFen = dhConfig.computeMinSalePriceFen(costPrice, minMarkupRate);
    const minSalePrice = +(minSalePriceFen / 100).toFixed(2);

    const raw = req.body ? req.body.salePrice : undefined;
    let salePrice = null;
    if (raw !== undefined && raw !== null && raw !== '') {
      const n = Number(raw);
      if (!isFinite(n) || n < 0) {
        return res.status(400).json({ success: false, message: '卖价须为非负数字' });
      }
      // 卖价底线校验：金额统一转「分」做整数比较，不得低于 供货价 × (1 + 最低加价率)
      if (dhConfig.toFen(n) < minSalePriceFen) {
        const markupPercent = Math.round(minMarkupRate * 100);
        return res.status(400).json({
          success: false,
          message: `卖价不能低于 ${minSalePrice.toFixed(2)} 元（供货价 ${costPrice.toFixed(2)} 元 + 平台成本底线 ${markupPercent}%）`
        });
      }
      salePrice = +n.toFixed(2);
    }
    product.salePrice = salePrice;
    // 【2026-09 上线加固】手动填写或修改卖价时打上 isManualPrice=true：
    //   一键定价（批量加价率）会跳过此标记的商品——手动定价的优先级最高，不可被覆盖；
    //   取消定价（salePrice=null）时清空标记，允许后续一键定价正常处理。
    product.isManualPrice = salePrice != null;
    await product.save();
    const effective = split.resolveSalePrice(product.salePrice, product.costPrice);
    res.json({
      success: true,
      message: salePrice == null ? '已取消定价（下单默认按供货价）' : '卖价已保存',
      data: {
        _id: String(product._id),
        costPrice,
        salePrice: effective,
        priced: salePrice != null,
        minSalePrice,
        belowFloor: +Number(effective).toFixed(2) < minSalePrice,
        priceDiff: +(effective - costPrice).toFixed(2)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 【2026-09 上线加固】一键定价（统一加价率批量定价）============
// 背景：上线初期供应商已报几百个供货价，逐个手动填写卖价太慢；
// 手动定价功能必须保留（重要），一键定价用于「批量打地基」+ 后续逐步手动微调。
// 公式（utils/dhConfig.computeBulkSalePriceDetailed）：
//   卖价 = max(供货价 × (1 + 加价率), 供货价 + 保底加价额) → 按页面的「尾数取整」选项取整
//   【2026-09 低价商品加价上限】保底加价额上面还有一道上限：
//   单个商品实际加价率不得超过「加价率 × 上限倍数」；超过时放弃保底、改用按比例算出的精确值
//   （例：设 8%、上限 2 倍（16%）：0.3 元商品 → 加价 0.048 元 → 卖价 0.35 元，而不是加 0.5 元）
// 护栏：
//   a) 应用前预览：影响商品数、平均加价率（取整前 → 取整后）、预计毛利率
//   b) 一键撤销：每次 apply 前保存快照到 PlatformConfig.lastBulkPricingSnapshot，可完整回滚
//   c) 跳过手动定价的商品：isManualPrice=true 的一律不动（手动定价优先级最高）
//   d) 成本线保护：计算出的加价率 < COST_FLOOR_RATE 时强制拉到 DEFAULT_MIN_MARKUP_RATE
//   e) 取整保护（默认开）：取整后加价率 > 生效加价率 × 1.5 的商品放弃取整、改用精确值
//   f) 加价上限（默认 2 倍）：保底加价额把极低价商品的加价率推过上限时，放弃保底改用比例精确值
// 页面选项（尾数取整 roundMode/roundTail/roundGuard + 保底加价额 minMarkupAmount + 上限倍数 markupCapMultiplier）
// 均来自「定价工作台」页面上的填写/选择，只随本次请求生效，不落库、不进后台配置；
// 未传时按页面默认（四舍五入到角 + 取整保护开启 + 保底 0.5 元 + 上限 2 倍），服务端权威计算。
// 注：本轮只做统一加价率；按品类差异化（蔬菜5%/肉禽8%/调料12%/酒水15%）接口位置已留好。

// 工具：从 query/body 解析过滤条件（供应商 / 品类 / 指定商品 / 是否仅待定价）
function parseBulkFilter(input) {
  const f = {};
  if (input.supplierId && input.supplierId !== 'all') f.supplierId = input.supplierId;
  if (input.category && input.category !== 'all') f.category = input.category;
  // 「仅勾选商品」范围：前端明确传 productIds 数组（空数组表示没勾选 → 不命中任何商品）
  if (Array.isArray(input.productIds)) {
    const ids = input.productIds
      .map(id => String(id))
      .filter(id => mongoose.Types.ObjectId.isValid(id));
    f._id = { $in: ids };
    return f;
  }
  if (input.onlyPending === true || input.onlyPending === '1' || input.onlyPending === 'true') {
    // 仅未定价（salePrice ≤ 0/null）—— 一键定价最常用场景
    f.$or = [
      { salePrice: null },
      { salePrice: { $exists: false } },
      { salePrice: { $lte: 0 } }
    ];
  }
  return f;
}

// 工具：判断是否强制覆盖手动定价（body.forceOverride / force 任一为真即生效）
function parseForceOverride(input) {
  const v = input.forceOverride;
  return v === true || v === '1' || v === 'true';
}

// 工具：解析「定价工作台」页面选项
//   尾数取整：roundMode / roundTail / roundGuard
//   【2026-09 低价商品加价上限】保底加价额 minMarkupAmount（元）/ 上限倍数 markupCapMultiplier（倍）
// 说明：选项只随本次请求生效（页面上的填写与选择），不落库、不进后台配置；
// 一律返回对象，字段缺省由 dhConfig 的 resolve* 兜底为页面默认值。
function parsePricingOptions(input) {
  const src = input || {};
  return {
    roundMode: src.roundMode,
    roundTail: src.roundTail,
    roundGuard: src.roundGuard,
    minMarkupAmount: src.minMarkupAmount,
    markupCapMultiplier: src.markupCapMultiplier
  };
}

// 工具：校验页面传入的「保底加价额 / 加价率上限倍数」（未传字段不校验）
// 返回错误文案（字符串）或 null（合法）；非法值直接 400，不做静默兜底（钱相关参数必须明确报错）
function validateMarkupRules(input) {
  const src = input || {};
  const has = v => v !== undefined && v !== null && v !== '';
  if (has(src.minMarkupAmount)) {
    const n = Number(src.minMarkupAmount);
    if (!isFinite(n) || n < 0 || n > dhConfig.MIN_MARKUP_AMOUNT_MAX) {
      return `保底加价额须为 0~${dhConfig.MIN_MARKUP_AMOUNT_MAX} 之间的数字（元）`;
    }
  }
  if (has(src.markupCapMultiplier)) {
    const n = Number(src.markupCapMultiplier);
    if (!isFinite(n) || n < dhConfig.MARKUP_CAP_MULTIPLIER_MIN || n > dhConfig.MARKUP_CAP_MULTIPLIER_MAX) {
      return `加价率上限倍数须为 ${dhConfig.MARKUP_CAP_MULTIPLIER_MIN}~${dhConfig.MARKUP_CAP_MULTIPLIER_MAX} 之间的数字（倍）`;
    }
  }
  return null;
}

// 工具：拉取命中商品 + 计算每件商品的「预览结果」（不写库）
// forceOverride=true 时不再跳过 isManualPrice=true 的商品（强制覆盖手动定价）
// pricingOptions：页面选项（尾数取整 + 保底加价额 + 上限倍数），
//                 缺省＝四舍五入到角 + 取整保护开启 + 保底 0.5 元 + 上限 2 倍
async function previewBulkPricing(filter, rate, forceOverride, pricingOptions) {
  const products = await SupplyProduct.find(filter)
    .select('_id name category unit costPrice salePrice isManualPrice supplierId supplierName')
    .lean();
  const cfg = await PlatformConfig.getSingleton();
  const minMarkupRate = dhConfig.resolveMinMarkupRate(cfg.minMarkupRate);
  const roundOpt = dhConfig.resolveRoundOptions(pricingOptions);
  // 【2026-09 低价商品加价上限】本次生效的保底加价额 / 上限倍数与上限加价率（页面可改，服务端权威）
  const minMarkupAmount = dhConfig.resolveMinMarkupAmount(pricingOptions && pricingOptions.minMarkupAmount);
  const markupCapMultiplier = dhConfig.resolveMarkupCapMultiplier(pricingOptions && pricingOptions.markupCapMultiplier);
  const markupCapRate = +(rate * markupCapMultiplier).toFixed(4);

  const items = [];
  let affectedCount = 0;     // 一键定价会覆盖的商品数（排除手动定价）
  let skippedManual = 0;    // 跳过的手动定价商品数
  let overriddenManual = 0; // 被强制覆盖的手动定价商品数
  let skippedNoCost = 0;    // 跳过的供货价 ≤ 0 商品数
  let roundingSkippedCount = 0; // 因「取整保护/硬地板兜底」放弃取整的商品数
  let floorDroppedCount = 0;    // 因「加价率上限」放弃保底、改用比例精确值的商品数
  let totalCost = 0;        // 命中商品供货价合计
  let totalSaleNew = 0;     // 一键定价后卖价合计
  let totalSaleRaw = 0;     // 取整前卖价合计（用于对比取整放大了多少）
  let totalSalePrev = 0;    // 改价前卖价合计（仅统计 affectedCount 集合）

  for (const p of products) {
    const cost = Number(p.costPrice) || 0;
    const prevSale = p.salePrice != null && Number(p.salePrice) > 0 ? Number(p.salePrice) : null;
    const isManual = !!p.isManualPrice;

    if (cost <= 0) {
      skippedNoCost += 1;
      items.push({
        productId: String(p._id),
        name: p.name,
        category: p.category || '',
        supplierName: p.supplierName || '',
        costPrice: cost,
        prevSalePrice: prevSale,
        newSalePrice: null,
        isManualPrice: isManual,
        action: 'skipped',
        reason: '供货价为 0，无法定价'
      });
      continue;
    }
    // 手动定价商品：默认跳过（手动定价优先级最高）；勾选「强制覆盖」时一并重定
    if (isManual && !forceOverride) {
      skippedManual += 1;
      items.push({
        productId: String(p._id),
        name: p.name,
        category: p.category || '',
        supplierName: p.supplierName || '',
        costPrice: cost,
        prevSalePrice: prevSale,
        newSalePrice: null,
        isManualPrice: true,
        action: 'skipped',
        reason: '手动定价的商品，一键定价不会覆盖'
      });
      continue;
    }
    // 计算新卖价（含保底 + 加价率上限 + 成本线 + 尾数取整 + 取整保护）
    const calc = dhConfig.computeBulkSalePriceDetailed(cost, rate, minMarkupRate, pricingOptions);
    affectedCount += 1;
    if (isManual) overriddenManual += 1;
    if (calc.roundingSkipped) roundingSkippedCount += 1;
    if (calc.floorDropped) floorDroppedCount += 1;
    totalCost += cost;
    totalSaleNew += calc.salePrice;
    totalSaleRaw += calc.rawSalePrice;
    totalSalePrev += (prevSale != null ? prevSale : cost);
    items.push({
      productId: String(p._id),
      name: p.name,
      category: p.category || '',
      supplierName: p.supplierName || '',
      costPrice: cost,
      prevSalePrice: prevSale,
      newSalePrice: calc.salePrice,
      rawSalePrice: calc.rawSalePrice,             // 取整前的精确卖价
      isManualPrice: isManual,
      overridesManual: isManual,        // 该商品是手动定价、本次被强制覆盖
      action: 'update',
      capped: !!calc.capped,           // 是否触发了成本线保护
      roundingSkipped: !!calc.roundingSkipped, // 是否因取整保护放弃取整（改用精确价）
      floorDropped: !!calc.floorDropped,       // 是否因加价率上限放弃保底（改用比例精确价）
      estimatedMarkupRate: +calc.markupRate.toFixed(4),
      estimatedMarkupAmount: calc.markupAmount,
      minSalePrice: dhConfig.computeMinSalePrice(cost, minMarkupRate)
    });
  }

  const averageMarkupRate = totalSaleNew > 0
    ? +((totalSaleNew - totalCost) / Math.max(totalCost, 0.0001)).toFixed(4)
    : 0;
  // 取整前平均加价率：与取整后同口径（总额口径），便于一眼看出取整实际放大了多少
  const averageMarkupRateBeforeRound = totalSaleRaw > 0
    ? +((totalSaleRaw - totalCost) / Math.max(totalCost, 0.0001)).toFixed(4)
    : 0;
  const estimatedMargin = +(totalSaleNew - totalCost).toFixed(2);

  return {
    items,
    summary: {
      totalScanned: products.length,
      affectedCount,
      skippedManual,
      overriddenManual,
      skippedNoCost,
      averageMarkupRate,
      averageMarkupRateBeforeRound,
      roundingSkippedCount,
      estimatedMargin,
      prevTotalSale: +totalSalePrev.toFixed(2),
      newTotalSale: +totalSaleNew.toFixed(2),
      roundMode: roundOpt.mode,
      roundTail: roundOpt.tailDigit,
      roundGuard: roundOpt.guard,
      // 【2026-09 低价商品加价上限】本次生效的保底/上限参数与拦下的件数
      minMarkupAmount,
      markupCapMultiplier,
      markupCapRate,
      floorDroppedCount
    }
  };
}

// ============ POST /api/dev/pricing/bulk/preview 一键定价预览（不写库）============
// body: { rate, supplierId?, category?, onlyPending?, productIds?, forceOverride?,
//         roundMode?, roundTail?, roundGuard?,
//         minMarkupAmount?, markupCapMultiplier? }（页面选项，均可选）
// rate 范围 [0, 1]；minMarkupAmount ∈ [0, 10] 元；markupCapMultiplier ∈ [1, 10] 倍；非法值直接 400
// forceOverride=true 时手动定价商品也会被重定（不再跳过），summary.overriddenManual 为被覆盖件数
router.post('/pricing/bulk/preview', async (req, res) => {
  try {
    const rate = Number(req.body && req.body.rate);
    if (!isFinite(rate) || rate < 0 || rate > 1) {
      return res.status(400).json({ success: false, message: '加价率须为 0~1 之间的小数（如 0.05 表示 5%）' });
    }
    // 【2026-09 低价商品加价上限】页面可改的保底加价额 / 上限倍数：先校验再计算
    const markupRuleErr = validateMarkupRules(req.body || {});
    if (markupRuleErr) {
      return res.status(400).json({ success: false, message: markupRuleErr });
    }
    const forceOverride = parseForceOverride(req.body || {});
    const filter = parseBulkFilter(req.body || {});
    const pricingOptions = parsePricingOptions(req.body || {});
    const roundOpt = dhConfig.resolveRoundOptions(pricingOptions);
    const result = await previewBulkPricing(filter, rate, forceOverride, pricingOptions);
    const cfg = await PlatformConfig.getSingleton();
    res.json({
      success: true,
      data: {
        rate,
        forceOverride,
        ...result,
        config: {
          // 【2026-09 低价商品加价上限】本次请求实际使用的保底加价额 / 上限倍数与上限加价率
          minMarkupAmount: result.summary.minMarkupAmount,
          markupCapMultiplier: result.summary.markupCapMultiplier,
          markupCapRate: result.summary.markupCapRate,
          // 服务端默认值（页面未填时生效），供页面回显与校验口径提示
          defaultMinMarkupAmount: dhConfig.MIN_MARKUP_AMOUNT,
          defaultMarkupCapMultiplier: dhConfig.MARKUP_CAP_MULTIPLIER,
          minMarkupAmountMax: dhConfig.MIN_MARKUP_AMOUNT_MAX,
          markupCapMultiplierMin: dhConfig.MARKUP_CAP_MULTIPLIER_MIN,
          markupCapMultiplierMax: dhConfig.MARKUP_CAP_MULTIPLIER_MAX,
          priceRoundTail: dhConfig.PRICE_ROUND_TAIL,
          costFloorRate: dhConfig.COST_FLOOR_RATE,
          defaultMinMarkupRate: dhConfig.DEFAULT_MIN_MARKUP_RATE,
          // 硬地板 = 系统设置里的最低加价率（可在开发者后台调整，下限 3%）
          minMarkupRate: dhConfig.resolveMinMarkupRate(cfg.minMarkupRate),
          // 【2026-09】本次请求实际使用的尾数取整选项（页面选择，不落库）
          roundMode: roundOpt.mode,
          roundTail: roundOpt.tailDigit,
          roundGuard: roundOpt.guard,
          roundText: dhConfig.roundOptionsText(roundOpt.mode, roundOpt.tailDigit),
          roundGuardMultiplier: dhConfig.ROUND_GUARD_MULTIPLIER,
          roundModes: dhConfig.ROUND_MODES,
          defaultRoundMode: dhConfig.DEFAULT_ROUND_MODE
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/dev/pricing/bulk/apply 一键定价应用（写库 + 保存快照）============
// 流程：
//   1) 再次预览（保证预览与应用的筛选口径一致，页面选项与预览同源同口径）
//   2) 保存快照到 PlatformConfig.lastBulkPricingSnapshot（仅保留最近一次，供回滚）
//   3) 批量更新 SupplyProduct：salePrice = newSalePrice、isManualPrice = false（清掉手动标记）
//   4) 返回 { affectedCount, skippedManual, overriddenManual, appliedAt }
// forceOverride=true 时手动定价商品也会被覆盖（快照里保留 prevIsManualPrice，回滚可原样恢复）
// 页面选项 body：roundMode/roundTail/roundGuard + minMarkupAmount/markupCapMultiplier（与预览同源，不落库）
router.post('/pricing/bulk/apply', async (req, res) => {
  try {
    const rate = Number(req.body && req.body.rate);
    if (!isFinite(rate) || rate < 0 || rate > 1) {
      return res.status(400).json({ success: false, message: '加价率须为 0~1 之间的小数（如 0.05 表示 5%）' });
    }
    // 【2026-09 低价商品加价上限】页面可改的保底加价额 / 上限倍数：先校验再计算（与预览同一口径）
    const markupRuleErr = validateMarkupRules(req.body || {});
    if (markupRuleErr) {
      return res.status(400).json({ success: false, message: markupRuleErr });
    }
    const forceOverride = parseForceOverride(req.body || {});
    const filter = parseBulkFilter(req.body || {});
    const pricingOptions = parsePricingOptions(req.body || {});
    const preview = await previewBulkPricing(filter, rate, forceOverride, pricingOptions);
    const targets = preview.items.filter(x => x.action === 'update');
    if (targets.length === 0) {
      return res.json({
        success: true,
        message: '没有可定价的商品（全部被跳过或筛选范围为空）',
        data: {
          affectedCount: 0,
          skippedManual: preview.summary.skippedManual,
          overriddenManual: 0,
          skippedNoCost: preview.summary.skippedNoCost,
          appliedAt: new Date()
        }
      });
    }
    // 应用前再次校验每个新卖价不低于硬地板（防御人工改 dhConfig 后预览已过期）
    const cfg = await PlatformConfig.getSingleton();
    const minMarkupRate = dhConfig.resolveMinMarkupRate(cfg.minMarkupRate);
    const appliedAt = new Date();
    const snapshotItems = [];
    for (const t of targets) {
      const minSalePrice = dhConfig.computeMinSalePrice(t.costPrice, minMarkupRate);
      if (t.newSalePrice + 0.0001 < minSalePrice) {
        return res.status(400).json({
          success: false,
          message: `商品「${t.name}」新卖价 ${t.newSalePrice.toFixed(2)} 元低于硬地板 ${minSalePrice.toFixed(2)} 元，已中止应用`
        });
      }
      snapshotItems.push({
        productId: new mongoose.Types.ObjectId(t.productId),
        prevSalePrice: t.prevSalePrice,
        prevIsManualPrice: !!t.isManualPrice,
        newSalePrice: t.newSalePrice,
        newIsManualPrice: false   // 一键定价后清掉手动标记（下次手动再改会再置 true）
      });
    }

    // 1) 保存快照（覆盖式，仅保留最近一次）
    const snapshot = {
      appliedAt,
      rate,
      affectedCount: targets.length,
      skippedManual: preview.summary.skippedManual,
      overriddenManual: preview.summary.overriddenManual || 0,
      items: snapshotItems
    };
    await PlatformConfig.updateOne(
      { key: 'platform' },
      { $set: { lastBulkPricingSnapshot: snapshot } },
      { upsert: true }
    );

    // 2) 批量更新商品：salePrice + isManualPrice
    //    每个商品的新卖价可能不同（尾数取整），逐条写最稳；预计影响几百件，性能可接受
    for (const t of targets) {
      await SupplyProduct.updateOne(
        { _id: t.productId },
        { $set: { salePrice: t.newSalePrice, isManualPrice: false } }
      );
    }
    res.json({
      success: true,
      message: `一键定价已应用：${targets.length} 件商品（跳过 ${preview.summary.skippedManual} 件手动定价、${preview.summary.skippedNoCost} 件供货价异常）` +
        (snapshot.overriddenManual > 0 ? `，其中强制覆盖 ${snapshot.overriddenManual} 件手动定价` : '') +
        (preview.summary.floorDroppedCount > 0 ? `，${preview.summary.floorDroppedCount} 件低价商品保底被加价率上限截断` : ''),
      data: {
        affectedCount: targets.length,
        skippedManual: preview.summary.skippedManual,
        overriddenManual: snapshot.overriddenManual,
        skippedNoCost: preview.summary.skippedNoCost,
        appliedAt,
        rate,
        // 【2026-09 低价商品加价上限】本次生效的保底/上限参数与拦下的件数（供页面提示与核对）
        minMarkupAmount: preview.summary.minMarkupAmount,
        markupCapMultiplier: preview.summary.markupCapMultiplier,
        floorDroppedCount: preview.summary.floorDroppedCount,
        snapshot: {
          appliedAt: snapshot.appliedAt,
          rate: snapshot.rate,
          affectedCount: snapshot.affectedCount,
          skippedManual: snapshot.skippedManual,
          overriddenManual: snapshot.overriddenManual
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/dev/pricing/bulk/rollback 一键定价回滚（恢复到上次 apply 前的状态）============
// 读 PlatformConfig.lastBulkPricingSnapshot，按 items 恢复每个商品的 salePrice + isManualPrice；
// 完成后清空 lastBulkPricingSnapshot（避免二次回滚）。
router.post('/pricing/bulk/rollback', async (req, res) => {
  try {
    const cfg = await PlatformConfig.getSingleton();
    const snap = cfg.lastBulkPricingSnapshot;
    if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) {
      return res.status(400).json({
        success: false,
        message: '没有可回滚的一键定价快照（最近一次未通过一键定价改价，或已被回滚过）'
      });
    }
    let restoredCount = 0;
    for (const it of snap.items) {
      // 用 salePrice=null 表示「恢复为未定价」
      const update = {
        salePrice: it.prevSalePrice == null ? null : it.prevSalePrice,
        isManualPrice: !!it.prevIsManualPrice
      };
      const r = await SupplyProduct.updateOne({ _id: it.productId }, { $set: update });
      if (r.modifiedCount > 0) restoredCount += 1;
    }
    // 清空快照，避免二次回滚
    await PlatformConfig.updateOne(
      { key: 'platform' },
      { $set: { lastBulkPricingSnapshot: null } }
    );
    res.json({
      success: true,
      message: `已回滚 ${restoredCount} 件商品到 ${snap.appliedAt ? new Date(snap.appliedAt).toLocaleString('zh-CN') : '上次一键定价'} 之前的状态`,
      data: {
        restoredCount,
        appliedAt: snap.appliedAt,
        rate: snap.rate,
        affectedCount: snap.affectedCount,
        skippedManual: snap.skippedManual
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/dev/pricing/bulk/snapshot 查询最近一次一键定价快照（前端用于显示「上次定价时间」与「回滚按钮」是否可用）============
router.get('/pricing/bulk/snapshot', async (req, res) => {
  try {
    const cfg = await PlatformConfig.getSingleton();
    const snap = cfg.lastBulkPricingSnapshot || null;
    if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) {
      return res.json({ success: true, data: null });
    }
    res.json({
      success: true,
      data: {
        appliedAt: snap.appliedAt,
        rate: snap.rate,
        affectedCount: snap.affectedCount,
        skippedManual: snap.skippedManual,
        overriddenManual: snap.overriddenManual || 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/dev/pricing/bulk/preview-by-category 品类差异化预览（接口位置预留，本轮不实现）============
// 计划：body: { categories: [{ category: '蔬菜', rate: 0.05 }, { category: '酒水', rate: 0.15 }] }
// 当前实现：未实现；前端不要调用。前端面板留好入口但按钮置灰、说明文字注明「下一版本」。
router.post('/pricing/bulk/preview-by-category', async (req, res) => {
  return res.status(501).json({
    success: false,
    message: '按品类差异化一键定价将在下一版本实现（本轮只做统一加价率）'
  });
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

// ============ 待人工分账（供应商未进件/进件未通过的降级订单）============
// 业务背景：供应商未完成微信进件时订单不阻断——商家正常下单支付、供应商正常接单；
// 资金划转不走渠道分账，由平台线下人工结算（全额打款给供应商 + 平台留加价部分）。
// GET /api/dev/manual-settlements  待人工结算订单列表（默认只看未结算的，?all=1 看全部含已结算）
router.get('/manual-settlements', async (req, res) => {
  try {
    const showAll = String(req.query.all || '') === '1';
    const filter = showAll ? { manualSettlement: true } : { manualSettlement: true, splitStatus: '待人工分账' };
    const list = await PurchaseOrder.find(filter)
      .populate('supplierId', 'name')
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();
    res.json({
      success: true,
      data: list.map(o => ({
        _id: o._id,
        orderNo: o.orderNo,
        shopName: o.shopName || '',
        supplierName: (o.supplierId && o.supplierId.name) || '平台直供',
        // 金额口径不变：供货价归供应商、加价归平台（线下人工结算按此执行）
        splitAmount: Number(o.splitAmount) || 0,
        supplierShare: Number(o.supplierShare) || 0,
        platformShare: Number(o.platformShare) || 0,
        totalAmount: Number(o.totalAmount) || 0,
        payStatus: o.payStatus || '',
        status: o.status || '',
        splitStatus: o.splitStatus || '',
        manualSettleReason: o.manualSettleReason || '',
        manualSettledAt: o.manualSettledAt || null,
        paymentFlowMode: o.paymentFlowMode || '',
        createdAt: o.createdAt
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/dev/manual-settlements/:id/settle  标记某订单已完成线下人工结算
// （供应商供货价已线下打款、平台加价部分已留存 → 订单分账状态落定为「分账成功」）
router.post('/manual-settlements/:id/settle', async (req, res) => {
  try {
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: '采购订单不存在' });
    if (order.splitStatus !== '待人工分账') {
      return res.status(400).json({ success: false, message: `该订单当前分账状态为「${order.splitStatus}」，无需人工结算` });
    }
    order.splitStatus = '分账成功';
    order.manualSettledAt = new Date();
    order.splitAt = order.splitAt || new Date();
    order.splitError = '';
    order.splitLogs = order.splitLogs || [];
    order.splitLogs.push({
      at: new Date(),
      action: 'manual_settle',
      status: '分账成功',
      message: `人工结算完成：线下打款供应商 ${order.supplierShare} / 平台留存 ${order.platformShare}`
    });
    await order.save();
    res.json({ success: true, message: '已标记人工结算完成', data: { splitStatus: order.splitStatus, manualSettledAt: order.manualSettledAt } });
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
