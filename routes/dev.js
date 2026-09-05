const express = require('express');
const router = express.Router();

const ShopAccount = require('../models/ShopAccount');
const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');
const Member = require('../models/Member');
const RebateRule = require('../models/RebateRule');
const RebateSettlement = require('../models/RebateSettlement');
const CoinRule = require('../models/CoinRule');
const Marketing = require('../models/Marketing');
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

// ============ GET /api/dev/merchants/:id 商家详情 ============
// 商家信息 + 鼎恒币余额 + 采购历史（最近 50 单）
router.get('/merchants/:id', async (req, res) => {
  try {
    const merchant = await ShopAccount.findById(req.params.id).lean();
    if (!merchant) {
      return res.status(404).json({ success: false, message: '商家不存在' });
    }
    const member = await Member.findOne({ shopId: merchant.shopId }).lean();
    const orders = await PurchaseOrder.find({ shopId: merchant.shopId })
      .populate('supplierId', 'name')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({
      success: true,
      data: {
        merchant: {
          _id: merchant._id,
          shopName: merchant.shopName || '未命名商家',
          contactName: merchant.contactName || '—',
          phone: merchant.phone || '—',
          createdAt: merchant.createdAt
        },
        memberLevel: (member && member.memberLevel) || '基础版',
        dinghengCoin: (member && member.dinghengCoin) || 0,
        orders
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/dev/suppliers 供应商管理列表 ============
// 查 Supplier 全量，附治理状态 + 本月流水 + 本月应付返点 + 本月结算状态
// 待审核（pending）置顶
router.get('/suppliers', async (req, res) => {
  try {
    const suppliers = await Supplier.find()
      .select('name contact phone categories minOrderAmount createdAt status rejectReason frozenReason approvedAt agreementSigned agreementSignedAt orderEnabled orderEnabledAt')
      .lean();

    // 本月已完成的采购订单按供应商聚合流水（actualPayAmount 总和）
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthKey = rebate.monthKeyOf(now);
    const monthAgg = await PurchaseOrder.aggregate([
      { $match: { createdAt: { $gte: monthStart }, status: '已完成' } },
      {
        $group: {
          _id: '$supplierId',
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
    const monthTurnoverMap = new Map();
    monthAgg.forEach(a => {
      if (a._id) monthTurnoverMap.set(String(a._id), +Number(a.total).toFixed(2));
    });

    // 本月结算单（取本月 RebateSettlement）
    const settlements = await RebateSettlement.find({ month: monthKey }).lean();
    const settlementMap = new Map(settlements.map(s => [String(s.supplierId), s]));

    // 本月应付返点：已结算取结算单 totalRebateAmount，未结算实时计算
    const sidList = suppliers.map(s => String(s._id));
    const liveCalcPromises = sidList.map(async sid => {
      if (settlementMap.has(sid)) return null; // 已结算跳过实时计算
      try {
        const calc = await rebate.calcSupplierMonthRebate(sid, monthKey);
        return { sid, totalRebate: calc.totalRebate };
      } catch (e) { return { sid, totalRebate: 0 }; }
    });
    const liveCalcs = await Promise.all(liveCalcPromises);
    const liveRebateMap = new Map();
    liveCalcs.forEach(c => { if (c) liveRebateMap.set(c.sid, c.totalRebate); });

    const STATUS_RANK = { pending: 0, rejected: 1, frozen: 2, active: 3 };
    const data = suppliers.map(s => {
      const sid = String(s._id);
      const settled = settlementMap.get(sid);
      const turnover = monthTurnoverMap.get(sid) || 0;
      const rebateAmount = settled
        ? +Number(settled.totalRebateAmount || 0).toFixed(2)
        : +(liveRebateMap.get(sid) || 0).toFixed(2);
      let settleStatus = '未结算';
      let overdue = false;
      if (settled) {
        settleStatus = rebate.normalizeSettlementStatus(settled.status);
        overdue = rebate.isSettlementOverdue(settled);
      }
      return {
        _id: s._id,
        name: s.name || '平台直供',
        contactName: s.contact || '—',
        phone: s.phone || '—',
        categories: Array.isArray(s.categories) ? s.categories : [],
        minOrderAmount: Number(s.minOrderAmount) > 0 ? Number(s.minOrderAmount) : 300,
        createdAt: s.createdAt,
        // 治理字段
        status: s.status || 'pending',
        rejectReason: s.rejectReason || '',
        frozenReason: s.frozenReason || '',
        approvedAt: s.approvedAt || null,
        agreementSigned: !!s.agreementSigned,
        agreementSignedAt: s.agreementSignedAt || null,
        orderEnabled: !!s.orderEnabled,
        orderEnabledAt: s.orderEnabledAt || null,
        // 本月经营指标
        monthTurnover: +turnover.toFixed(2),
        monthRebate: rebateAmount,
        settleStatus,
        overdue
      };
    });

    // 待审核置顶；同状态按注册时间倒序
    data.sort((a, b) => {
      const ra = STATUS_RANK[a.status] != null ? STATUS_RANK[a.status] : 99;
      const rb = STATUS_RANK[b.status] != null ? STATUS_RANK[b.status] : 99;
      if (ra !== rb) return ra - rb;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json({ success: true, data });
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
    async function getCategoryRateMap(sid) {
      if (rateMapCache.has(sid)) return rateMapCache.get(sid);
      const map = new Map();
      const settled = settleMap.get(sid);
      if (settled) {
        (settled.details || []).forEach(d => map.set(d.category, Number(d.rate) || 0));
      } else {
        const calc = await rebate.calcSupplierMonthRebate(sid, month);
        calc.categories.forEach(c => map.set(c.category, Number(c.tierRate) || 0));
      }
      rateMapCache.set(sid, map);
      return map;
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
        const rateMap = await getCategoryRateMap(sid);
        let sum = 0;
        (o.items || []).forEach(it => {
          const cat = it.category || '未分类';
          const rate = rateMap.has(cat) ? rateMap.get(cat) : rebate.DEFAULT_REBATE_RATE;
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
      totalPurchaseAmount: s.totalPurchaseAmount,
      totalRebateAmount: s.totalRebateAmount,
      details: s.details,
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
