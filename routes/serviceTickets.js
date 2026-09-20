const express = require('express');
const router = express.Router();

const ServiceTicket = require('../models/ServiceTicket');
const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const SupplyProduct = require('../models/SupplyProduct');
const {
  requireMerchant,
  requireSupplier,
  requireDev
} = require('../middlewares/auth');

// ============ 售后服务工单 ============
// 三端共用一套接口，靠 requireMerchant / requireSupplier / requireDev 隔离身份：
//   商家  提交工单、确认解决、撤销、申请平台介入、评价
//   供应商 受理、回复、给出处理方案、驳回
//   平台  总览、裁决（纠纷兜底）
// 设计原则：金额/单价一律以订单快照为准，前端传的金额只做「诉求」，不参与任何结算计算，
//          避免商家虚报；工单全程留痕 logs，既维权也是平台看供应商服务质量的依据。

// 供应商受理时限（小时）：超时未受理自动升级平台，避免工单石沉大海。
// 默认 24h；验收 / 演示时可用环境变量临时调短（TICKET_ACCEPT_DUE_HOURS=0.05 约 3 分钟），
// 不用真等一天才能看到「超时自动转平台」的效果 —— 生产不设该变量即恢复 24h。
const ACCEPT_DUE_HOURS = (function () {
  const v = Number(process.env.TICKET_ACCEPT_DUE_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 24;
})();
// 可申请售后的订单状态（货没到就谈不上售后）
const AFTER_SALE_ORDER_STATUS = ['已发货', '已收货', '已完成'];

// ============ 通用工具 ============

function pushLog(t, { by = '', byName = '', byRole = '', action = '', from = '', to = '', note = '' }) {
  t.logs.push({
    at: new Date(),
    by: String(by || ''),
    byName: String(byName || ''),
    byRole: String(byRole || ''),
    action: String(action || ''),
    from: String(from || ''),
    to: String(to || ''),
    note: String(note || '').slice(0, 500)
  });
}

// 生成唯一工单号（唯一索引兜底，极小概率冲突时重试）
async function genTicketNo() {
  for (let i = 0; i < 5; i++) {
    const no = ServiceTicket.genTicketNo();
    const exist = await ServiceTicket.findOne({ ticketNo: no }).select('_id').lean();
    if (!exist) return no;
  }
  return ServiceTicket.genTicketNo() + Date.now().toString(36).slice(-4).toUpperCase();
}

// 身份 → 角色标识
function roleOf(req) {
  const role = req.user && req.user.role;
  if (role === 'merchant') return 'merchant';
  if (role === 'supplier') return 'supplier';
  if (role === 'dev') return 'platform';
  return '';
}

// 越权校验：商家只能看自己店铺的、供应商只能看自己名下的、平台看全部
function canAccess(t, req) {
  const role = req.user && req.user.role;
  if (role === 'dev') return true;
  if (role === 'merchant') return String(t.shopId) === String(req.shopId);
  if (role === 'supplier') return String(t.supplierId) === String(req.user.supplierId || '');
  return false;
}

// 操作人信息（写日志用）
function operator(req, t) {
  const role = roleOf(req);
  if (role === 'merchant') {
    return { by: String(req.shopId || ''), byName: t.shopName || '商家', byRole: 'merchant' };
  }
  if (role === 'supplier') {
    return { by: String(req.user.supplierId || ''), byName: t.supplierName || '供应商', byRole: 'supplier' };
  }
  return { by: String((req.user && req.user.id) || ''), byName: '平台', byRole: 'platform' };
}

// 惰性升级：查询待办/总览前，把「超过受理时限仍未受理」的工单自动转平台介入。
// 不依赖定时任务 —— 有人查看时就升级，没人查看也不影响数据正确性。
async function escalateOverdue() {
  const now = new Date();
  try {
    const overdue = await ServiceTicket.find({
      status: '待受理',
      dueAt: { $ne: null, $lt: now }
    });
    for (const t of overdue) {
      pushLog(t, {
        byRole: 'platform',
        byName: '系统',
        action: '超时自动升级',
        from: '待受理',
        to: '平台介入中',
        note: `超过 ${ACCEPT_DUE_HOURS} 小时未受理，自动转平台介入`
      });
      t.status = '平台介入中';
      t.platformIntervened = true;
      t.escalateReason = '超时未受理';
      t.escalatedAt = now;
      await t.save();
    }
  } catch (e) {
    console.warn('[工单] 超时自动升级失败（不影响查询）:', e.message);
  }
}

// 状态徽标（前端直接展示，避免各端重复维护文案与配色）
const STATUS_TONE = {
  '待受理': 'orange',
  '处理中': 'blue',
  '待商家确认': 'purple',
  '已完成': 'green',
  '已驳回': 'gray',
  '已撤销': 'gray',
  '平台介入中': 'red'
};

function shape(t) {
  const o = (t && t.toObject) ? t.toObject() : Object.assign({}, t);
  o.statusTone = STATUS_TONE[o.status] || 'gray';
  return o;
}

// ============ GET /api/service-tickets/meta ============
// 下拉选项（类型 / 诉求 / 受理时限），前端不必硬编码
router.get('/meta', (req, res) => {
  res.json({
    success: true,
    data: {
      types: ServiceTicket.TICKET_TYPES,
      expectActions: ServiceTicket.EXPECT_ACTIONS,
      statuses: ServiceTicket.TICKET_STATUS,
      acceptDueHours: ACCEPT_DUE_HOURS
    }
  });
});

// ============ POST /api/service-tickets（商家提交工单）============
// 入参：orderId（必填）、type、description、images[]、items[]、expectAction、claimAmount、priority
// 关键：supplierId / 商品单价一律取自订单快照，不接受前端指定 —— 防止伪造供应商与虚报金额
router.post('/', requireMerchant, async (req, res) => {
  let credit = null;
  try {
    const {
      orderId, type, description, images, items,
      expectAction, claimAmount, priority, title
    } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ success: false, message: '请选择要申请售后的订单' });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, message: '请描述具体问题（便于供应商核实时判定）' });
    }
    if (!ServiceTicket.TICKET_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: '请选择工单类型' });
    }

    // 订单必须属于当前商家（越权防护）
    const order = await PurchaseOrder.findOne({ _id: orderId, shopId: req.shopId }).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: '订单不存在或无权操作' });
    }
    if (!AFTER_SALE_ORDER_STATUS.includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `该订单当前状态「${order.status}」暂不支持申请售后，收货后再提交`
      });
    }
    // 同一订单同一类型未闭环时不重复建单（防误触刷单，也避免供应商被同一问题反复打扰）
    const dup = await ServiceTicket.findOne({
      orderId: order._id,
      type,
      status: { $nin: ServiceTicket.TERMINAL_STATUS }
    }).select('ticketNo').lean();
    if (dup) {
      return res.status(409).json({
        success: false,
        message: `该订单已有进行中的「${type}」工单（${dup.ticketNo}），请到售后工单里跟进`
      });
    }

    // ---- 售后信誉门槛（防滥用）----
    // 现实里确实有小老板把"申请售后"当砍价工具：货没问题也提一单，逼供应商折让。
    // 这里用近 30 天的「售后率」和「被判定不成立的单数」做门槛：
    // 真出问题的照提不误；习惯性薅羊毛的会被挡下来并说清原因，供应商不必再被无谓消耗。
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [recentTickets, recentOrders, badTickets] = await Promise.all([
      ServiceTicket.countDocuments({ shopId: req.shopId, createdAt: { $gte: since } }),
      PurchaseOrder.countDocuments({ shopId: req.shopId, createdAt: { $gte: since } }),
      ServiceTicket.countDocuments({ shopId: req.shopId, createdAt: { $gte: since }, status: '已驳回' })
    ]);
    const rate = recentOrders > 0 ? recentTickets / recentOrders : 0;
    credit = {
      recentTickets, recentOrders, badTickets,
      rate: Math.round(rate * 100),
      level: rate >= 0.4 ? '偏低' : (rate >= 0.2 ? '需注意' : '良好')
    };
    if (badTickets >= 3) {
      return res.status(403).json({
        success: false,
        message: `近 30 天有 ${badTickets} 单售后被判定不成立。售后是给真出问题的单用的；确有问题请附凭证图片并写清经过，或联系平台协助核实。`,
        credit
      });
    }
    if (recentTickets >= 3 && rate >= 0.4) {
      return res.status(403).json({
        success: false,
        message: `近 30 天售后率 ${Math.round(rate * 100)}%（${recentTickets}/${recentOrders} 单）明显偏高。请先确认问题是否真实存在；确有问题可联系平台协助核实。`,
        credit
      });
    }

    const supplier = await Supplier.findById(order.supplierId).select('name').lean();

    // 涉事商品行：只认订单里真实存在的行，数量/单价以订单快照为准
    const orderItemMap = new Map((order.items || []).map(i => [String(i.productId), i]));
    const rawItems = Array.isArray(items) ? items.slice(0, 30) : [];
    const picked = [];
    for (const it of rawItems) {
      const oi = orderItemMap.get(String((it && it.productId) || ''));
      if (!oi) continue;                       // 订单里没有这一行 → 忽略（防伪造商品）
      picked.push({
        productId: String(oi.productId),
        name: oi.name,
        unit: '',
        quantity: Number(oi.quantity) || 0,
        issueQuantity: Math.max(0, Number((it && it.issueQuantity) || 0)),
        unitPrice: Number(oi.unitPrice) || 0
      });
    }
    // 单位从商品库补齐（仅用于展示，查不到留空不影响工单）
    if (picked.length) {
      try {
        const prods = await SupplyProduct.find({ _id: { $in: picked.map(p => p.productId) } })
          .select('unit').lean();
        const unitMap = new Map(prods.map(p => [String(p._id), p.unit || '']));
        picked.forEach(p => { p.unit = unitMap.get(p.productId) || ''; });
      } catch (e) { /* 单位缺失不影响主流程 */ }
    }

    const now = new Date();
    const dueAt = new Date(now.getTime() + ACCEPT_DUE_HOURS * 3600 * 1000);
    const autoTitle = String(title || '').trim() ||
      `${type}｜${supplier ? supplier.name : '供应商'}｜${picked.length ? picked[0].name + (picked.length > 1 ? ` 等${picked.length}项` : '') : '整单'}`;

    const ticket = await ServiceTicket.create({
      ticketNo: await genTicketNo(),
      orderId: order._id,
      orderNo: order.orderNo || '',
      shopId: req.shopId,
      shopName: order.shopName || '',
      supplierId: order.supplierId,
      supplierName: (supplier && supplier.name) || '',
      type,
      title: autoTitle.slice(0, 60),
      description: String(description).slice(0, 1000),
      images: Array.isArray(images) ? images.slice(0, 6).map(String) : [],
      items: picked,
      expectAction: ServiceTicket.EXPECT_ACTIONS.includes(expectAction) ? expectAction : '仅反馈',
      claimAmount: Math.max(0, Number(claimAmount) || 0),
      status: '待受理',
      priority: priority === '紧急' ? '紧急' : '普通',
      dueAt
    });

    pushLog(ticket, {
      ...operator(req, ticket),
      action: '提交工单',
      to: '待受理',
      note: `商家提交「${type}」工单，诉求：${ServiceTicket.EXPECT_ACTIONS.includes(expectAction) ? expectAction : '仅反馈'}`
    });
    await ticket.save();

    res.status(201).json({ success: true, data: shape(ticket), credit });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/service-tickets/credit（商家：我的售后信誉）============
// 打开提交弹窗就把"我近期的售后情况"摆出来 —— 动手之前心里有数，
// 也顺带把"这是给真出问题的单用的"这句话说在前面（写在提示里，比事后驳回温和）。
router.get('/credit', requireMerchant, async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [recentTickets, recentOrders, badTickets] = await Promise.all([
      ServiceTicket.countDocuments({ shopId: req.shopId, createdAt: { $gte: since } }),
      PurchaseOrder.countDocuments({ shopId: req.shopId, createdAt: { $gte: since } }),
      ServiceTicket.countDocuments({ shopId: req.shopId, createdAt: { $gte: since }, status: '已驳回' })
    ]);
    const rate = recentOrders > 0 ? recentTickets / recentOrders : 0;
    res.json({
      success: true,
      data: {
        recentTickets, recentOrders, badTickets,
        rate: Math.round(rate * 100),
        level: rate >= 0.4 ? '偏低' : (rate >= 0.2 ? '需注意' : '良好'),
        remain: Math.max(0, 3 - badTickets)   // 离被限制还剩几单，边界让人看得见
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/service-tickets/merchant（商家：我提交的工单）============
router.get('/merchant', requireMerchant, async (req, res) => {
  try {
    await escalateOverdue();
    const { status } = req.query;
    const filter = { shopId: req.shopId };
    if (status && ServiceTicket.TICKET_STATUS.includes(status)) filter.status = status;
    const list = await ServiceTicket.find(filter).sort({ createdAt: -1 }).lean();
    const pendingCount = list.filter(t => !ServiceTicket.isTerminal(t.status)).length;
    res.json({
      success: true,
      data: {
        list: list.map(shape),
        pendingCount,
        // 待我确认的（供应商已给方案，等商家拍板）
        waitingConfirm: list.filter(t => t.status === '待商家确认').length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/service-tickets/supplier（供应商：待办工单）============
router.get('/supplier', requireSupplier, async (req, res) => {
  try {
    await escalateOverdue();
    const supplierId = req.user.supplierId;
    const { status } = req.query;
    const filter = { supplierId };
    if (status && ServiceTicket.TICKET_STATUS.includes(status)) filter.status = status;
    const list = await ServiceTicket.find(filter).sort({ createdAt: -1 }).lean();

    const now = new Date();
    const open = list.filter(t => !ServiceTicket.isTerminal(t.status));
    res.json({
      success: true,
      data: {
        list: list.map(shape),
        // 待办 = 还没闭环的工单（侧栏红点用）
        pendingCount: open.length,
        // 待我受理（新建未响应）
        todoCount: open.filter(t => t.status === '待受理').length,
        // 已超时（升级到平台了）→ 服务分会被扣，供应商应优先处理
        overdueCount: open.filter(t => t.dueAt && t.dueAt < now && t.status !== '待受理').length,
        // 平台已介入的
        intervenedCount: open.filter(t => t.platformIntervened).length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/service-tickets/platform（平台：全量总览）============
router.get('/platform', requireDev, async (req, res) => {
  try {
    await escalateOverdue();
    const { status, intervened } = req.query;
    const filter = {};
    if (status && ServiceTicket.TICKET_STATUS.includes(status)) filter.status = status;
    if (intervened === '1') filter.platformIntervened = true;

    const list = await ServiceTicket.find(filter)
      .sort({ platformIntervened: -1, priority: -1, createdAt: -1 })
      .lean();
    res.json({ success: true, data: { list: list.map(shape) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/service-tickets/platform/stats（平台：纠纷概览）============
// 平台凭这个看：哪家供应商投诉多、哪类问题频发、多少单没人管 —— 既是兜底依据，也是品控抓手
router.get('/platform/stats', requireDev, async (req, res) => {
  try {
    await escalateOverdue();
    const [byStatus, byType, bySupplier, total, intervened, rated] = await Promise.all([
      ServiceTicket.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      ServiceTicket.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }]),
      ServiceTicket.aggregate([
        { $group: { _id: '$supplierId', name: { $first: '$supplierName' }, total: { $sum: 1 }, ratingSum: { $sum: '$rating' }, ratingCount: { $sum: { $cond: [{ $gt: ['$rating', 0] }, 1, 0] } } } },
        { $sort: { total: -1 } },
        { $limit: 5 }
      ]),
      ServiceTicket.countDocuments({}),
      ServiceTicket.countDocuments({ platformIntervened: true }),
      ServiceTicket.aggregate([
        { $match: { rating: { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
      ])
    ]);
    const statusMap = {};
    byStatus.forEach(x => { statusMap[x._id] = x.count; });
    res.json({
      success: true,
      data: {
        total,
        intervened,
        byStatus: statusMap,
        byType: byType.map(x => ({ type: x._id, count: x.count })).sort((a, b) => b.count - a.count),
        topSuppliers: bySupplier.map(x => ({
          supplierId: x._id,
          name: x.name || '未知供应商',
          total: x.total,
          avgRating: x.ratingCount ? +(x.ratingSum / x.ratingCount).toFixed(2) : 0
        })),
        rating: {
          avg: rated.length ? +rated[0].avg.toFixed(2) : 0,
          count: rated.length ? rated[0].count : 0
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/service-tickets/:id（三端共用详情，按身份校验归属）============
router.get('/:id', (req, res, next) => {
  // 详情对三端开放，鉴权交给 handler 内的 canAccess（此处先要求登录）
  const { verifyToken } = require('../middlewares/auth');
  verifyToken(req, res, next);
}, async (req, res) => {
  try {
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (!canAccess(t, req)) return res.status(403).json({ success: false, message: '无权查看该工单' });
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/service-tickets/:id/reply（三端追加沟通记录）============
// 工单就是双方的聊天记录 + 状态变更流水：谁在什么时候说了什么，全程可追溯
router.post('/:id/reply', (req, res, next) => {
  const { verifyToken } = require('../middlewares/auth');
  verifyToken(req, res, next);
}, async (req, res) => {
  try {
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (!canAccess(t, req)) return res.status(403).json({ success: false, message: '无权操作该工单' });
    if (ServiceTicket.isTerminal(t.status)) {
      return res.status(400).json({ success: false, message: '工单已闭环，如需继续沟通请重新提交' });
    }
    const note = String((req.body && req.body.note) || '').trim();
    if (!note) return res.status(400).json({ success: false, message: '回复内容不能为空' });

    pushLog(t, { ...operator(req, t), action: '回复', note });
    await t.save();
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/service-tickets/:id/accept（供应商受理）============
router.post('/:id/accept', requireSupplier, async (req, res) => {
  try {
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (!canAccess(t, req)) return res.status(403).json({ success: false, message: '无权操作该工单' });
    if (t.status === '平台介入中') {
      return res.status(400).json({ success: false, message: '工单已转平台介入，请在平台介入流程中处理' });
    }
    if (t.status !== '待受理') {
      return res.status(400).json({ success: false, message: `当前状态「${t.status}」无需受理` });
    }
    const from = t.status;
    t.status = '处理中';
    t.acceptedAt = new Date();
    pushLog(t, { ...operator(req, t), action: '受理', from, to: '处理中', note: String((req.body && req.body.note) || '').slice(0, 500) });
    await t.save();
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/service-tickets/:id/resolve（供应商给出处理方案）============
// 入参：action（补发/换货/退款/折让/已解释）、amount、note
// 给完方案 → 待商家确认，商家拍板后闭环
router.post('/:id/resolve', requireSupplier, async (req, res) => {
  try {
    const { action, amount, note } = req.body || {};
    if (!action || !String(action).trim()) {
      return res.status(400).json({ success: false, message: '请选择处理方案' });
    }
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (!canAccess(t, req)) return res.status(403).json({ success: false, message: '无权操作该工单' });
    if (!['处理中', '平台介入中'].includes(t.status)) {
      return res.status(400).json({ success: false, message: `当前状态「${t.status}」不能提交方案，请先受理` });
    }
    const from = t.status;
    t.status = '待商家确认';
    t.resolution = {
      action: String(action).slice(0, 30),
      amount: Math.max(0, Number(amount) || 0),
      note: String(note || '').slice(0, 500),
      at: new Date()
    };
    t.resolvedAt = new Date();
    pushLog(t, {
      ...operator(req, t),
      action: '提交方案',
      from,
      to: '待商家确认',
      note: `方案：${t.resolution.action}${t.resolution.amount > 0 ? ` ¥${t.resolution.amount.toFixed(2)}` : ''}${t.resolution.note ? '｜' + t.resolution.note : ''}`
    });
    await t.save();
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/service-tickets/:id/reject（供应商驳回）============
// 驳回必须写理由 —— 空口说"不是我的问题"不算处理，平台介入时这就是呈堂证供
router.post('/:id/reject', requireSupplier, async (req, res) => {
  try {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: '驳回必须填写理由（便于商家与平台复核）' });
    }
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (!canAccess(t, req)) return res.status(403).json({ success: false, message: '无权操作该工单' });
    if (!['待受理', '处理中'].includes(t.status)) {
      return res.status(400).json({ success: false, message: `当前状态「${t.status}」不能驳回` });
    }
    const from = t.status;
    t.status = '已驳回';
    t.closedAt = new Date();
    pushLog(t, { ...operator(req, t), action: '驳回', from, to: '已驳回', note: reason });
    await t.save();
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/service-tickets/:id/confirm（商家确认解决）============
router.post('/:id/confirm', requireMerchant, async (req, res) => {
  try {
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (!canAccess(t, req)) return res.status(403).json({ success: false, message: '无权操作该工单' });
    if (t.status !== '待商家确认') {
      return res.status(400).json({ success: false, message: '供应商尚未给出处理方案，暂不能确认' });
    }
    const from = t.status;
    t.status = '已完成';
    t.closedAt = new Date();
    pushLog(t, { ...operator(req, t), action: '确认解决', from, to: '已完成', note: String((req.body && req.body.note) || '').slice(0, 500) });
    await t.save();
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/service-tickets/:id/cancel（商家撤销，仅限受理前）============
router.post('/:id/cancel', requireMerchant, async (req, res) => {
  try {
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (!canAccess(t, req)) return res.status(403).json({ success: false, message: '无权操作该工单' });
    if (t.status !== '待受理') {
      return res.status(400).json({ success: false, message: '供应商已受理，如需终止请与对方沟通或申请平台介入' });
    }
    const from = t.status;
    t.status = '已撤销';
    t.closedAt = new Date();
    pushLog(t, { ...operator(req, t), action: '撤销', from, to: '已撤销', note: String((req.body && req.body.note) || '').slice(0, 500) });
    await t.save();
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/service-tickets/:id/escalate（任一方申请平台介入）============
// 商家/供应商都能申请 —— 谈不拢时得有条明路，而不是在电话里吵
router.post('/:id/escalate', (req, res, next) => {
  const { verifyToken } = require('../middlewares/auth');
  verifyToken(req, res, next);
}, async (req, res) => {
  try {
    const role = roleOf(req);
    if (role !== 'merchant' && role !== 'supplier') {
      return res.status(403).json({ success: false, message: '仅商家或供应商可申请平台介入' });
    }
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (!canAccess(t, req)) return res.status(403).json({ success: false, message: '无权操作该工单' });
    if (!['待受理', '处理中', '待商家确认'].includes(t.status)) {
      return res.status(400).json({ success: false, message: `当前状态「${t.status}」无需平台介入` });
    }
    const from = t.status;
    t.status = '平台介入中';
    t.platformIntervened = true;
    t.escalateReason = String((req.body && req.body.reason) || '').slice(0, 300) || '双方无法达成一致';
    t.escalatedAt = new Date();
    pushLog(t, { ...operator(req, t), action: '申请平台介入', from, to: '平台介入中', note: t.escalateReason });
    await t.save();
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/service-tickets/:id/arbitrate（平台裁决）============
// 入参：result（support_merchant=支持商家 / support_supplier=支持供应商）、amount、note
// 裁决即终局：支持商家 → 已完成；支持供应商 → 已驳回
router.post('/:id/arbitrate', requireDev, async (req, res) => {
  try {
    const { result, amount, note } = req.body || {};
    if (!['support_merchant', 'support_supplier'].includes(result)) {
      return res.status(400).json({ success: false, message: '请选择裁决结果' });
    }
    const noteText = String(note || '').trim();
    if (!noteText) {
      return res.status(400).json({ success: false, message: '裁决必须写明依据（对双方都要有交代）' });
    }
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (t.status !== '平台介入中') {
      return res.status(400).json({ success: false, message: '仅平台介入中的工单可裁决' });
    }

    const from = t.status;
    t.platformNote = noteText.slice(0, 1000);
    if (result === 'support_merchant') {
      t.status = '已完成';
      t.resolution = {
        action: '平台裁决·支持商家',
        amount: Math.max(0, Number(amount) || 0),
        note: noteText.slice(0, 500),
        at: new Date()
      };
    } else {
      t.status = '已驳回';
    }
    t.closedAt = new Date();
    pushLog(t, {
      ...operator(req, t),
      action: '平台裁决',
      from,
      to: t.status,
      note: `${result === 'support_merchant' ? '支持商家' : '支持供应商'}｜${noteText.slice(0, 300)}`
    });
    await t.save();
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/service-tickets/:id/rate（商家评价，沉淀服务分）============
router.post('/:id/rate', requireMerchant, async (req, res) => {
  try {
    const rating = Math.round(Number(req.body && req.body.rating) || 0);
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: '请给出 1-5 星评价' });
    }
    const t = await ServiceTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '工单不存在' });
    if (!canAccess(t, req)) return res.status(403).json({ success: false, message: '无权操作该工单' });
    if (t.status !== '已完成') {
      return res.status(400).json({ success: false, message: '工单完成后才能评价' });
    }
    t.rating = rating;
    t.ratingNote = String((req.body && req.body.note) || '').slice(0, 300);
    t.ratedAt = new Date();
    pushLog(t, { ...operator(req, t), action: '评价', note: `${rating} 星${t.ratingNote ? '｜' + t.ratingNote : ''}` });
    await t.save();
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
