const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const SupplyProduct = require('../models/SupplyProduct');
const ShopAccount = require('../models/ShopAccount');
const Setting = require('../models/Setting');
const Member = require('../models/Member');
const CoinHistory = require('../models/CoinHistory');
const Coupon = require('../models/Coupon');
const ShopInventory = require('../models/ShopInventory');
const dhConfig = require('../utils/dhConfig');
const entitlements = require('../utils/entitlements');
const coinRule = require('../utils/coinRule');
const stockpileCheck = require('../utils/stockpileCheck');
const notify = require('../utils/notify');
const split = require('../utils/split');
const paymentProvider = require('../utils/paymentProvider');
const { verifyToken, requireMerchant, requireSupplier } = require('../middlewares/auth');

// ============ 工具函数 ============

// 生成采购单号：CG + 年月日 + 4位随机数，如 CG20260901XXXX
function generateOrderNo() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `CG${y}${m}${d}${rand}`;
}

// 供应商通知：若配置了 webhookUrl 则真实 POST 推送（带 5s 超时），并落库通知日志
//   - 成功返回 true；未配置 webhookUrl 记 skipped 并返回 false（不影响主流程）
async function sendNotification(supplier, event, payload) {
  if (!supplier) return false;
  if (!supplier.webhookUrl) {
    await notify.writeLog({
      channel: 'webhook',
      event,
      target: '',
      title: '供应商通知',
      content: `供应商 ${supplier.name}`,
      status: 'skipped',
      error: '供应商未配置 webhookUrl'
    });
    return false;
  }
  return notify.pushWebhook(
    supplier.webhookUrl,
    event,
    Object.assign({ supplierId: String(supplier._id), supplierName: supplier.name }, payload || {}),
    { title: '供应商通知', content: `${supplier.name} · ${event}` }
  );
}

// ============ 云分账：发起分账指令（下单付款即发起；失败落库并支持重试）============
// 两笔拆账：供货价 → 供应商，差价 → 平台。金额按订单当前 items（下单数量 Q1）计算。
// 状态机：待分账 →（本次调用）已发起分账 → 分账成功 / 分账失败（splitRetryCount++，记 splitError）
// mock provider 同步返回结果；真实渠道为异步回调，届时由 /:id/split/callback 落定最终状态。
async function initiateOrderSplit(order, supplier) {
  const r = split.calcOrderSplit(order);
  order.splitAmount = r.splitAmount;
  order.supplierShare = r.supplierShare;
  order.platformShare = r.platformShare;
  order.splitStatus = split.SPLIT_STATUS.INITIATED;
  split.appendSplitLog(order, { action: 'initiate', status: '已发起分账', message: `供应商 ${r.supplierShare} / 平台 ${r.platformShare}` });

  let res;
  try {
    res = await paymentProvider.applyProfitSharing(order, {
      supplierShareFen: Math.round(r.supplierShare * 100),
      platformShareFen: Math.round(r.platformShare * 100),
      supplierMchId: supplier ? supplier.wechatSubMchId : '',
      platformMchId: ''
    });
  } catch (e) {
    res = { status: 'failed', error: String((e && e.message) || '分账异常').slice(0, 300), splitNo: order.splitNo };
  }

  if (res && res.status === 'success') {
    order.splitStatus = split.SPLIT_STATUS.SUCCESS;
    order.splitNo = res.splitNo || order.splitNo;
    order.channelSplitOrderId = res.channelSplitOrderId || '';
    order.splitAt = new Date();
    order.splitError = '';
    split.appendSplitLog(order, { action: 'result', status: '分账成功', message: `流水号 ${order.splitNo}` });
  } else {
    order.splitStatus = split.SPLIT_STATUS.FAILED;
    order.splitNo = (res && res.splitNo) || order.splitNo;
    order.splitRetryCount = Number(order.splitRetryCount || 0) + 1;
    order.splitError = (res && res.error) || '分账失败';
    split.appendSplitLog(order, { action: 'result', status: '分账失败', message: order.splitError });
  }
  return order;
}

// ============ GET /api/purchase-orders 查询采购订单列表 ============
// 权限隔离：
//   merchant → 只查 { shopId: req.user.shopId }
//   supplier → 只查 { supplierId: req.user.supplierId }
//   dev      → 查全部（无过滤）
// 同时 populate 供应商名，避免前端显示 undefined

async function listOrdersHandler(req, res) {
  try {
    const { status } = req.query;
    const filter = {};
    // 按登录用户角色过滤，确保三方数据隔离、同源
    if (req.user.role === 'merchant') {
      filter.shopId = req.user.shopId;
    } else if (req.user.role === 'supplier') {
      filter.supplierId = req.user.supplierId;
    }
    // dev 不加过滤，看全部
    if (status) filter.status = status;

    const orders = await PurchaseOrder.find(filter)
      .populate('supplierId', 'name contact phone deliveryNotice')
      .populate('appliedCouponId', 'type faceValue minOrder name')
      .sort({ createdAt: -1 })
      .lean();

    // 关联商家联系人/电话（ShopAccount.shopId 为字符串字段，无法直接 populate，手动批量补全）
    // 供应商视角需要看到送货地址/电话，这里补全 shopContact / shopPhone
    const shopIds = [...new Set(orders.map(o => o.shopId).filter(Boolean))];
    if (shopIds.length > 0) {
      const accounts = await ShopAccount.find({ shopId: { $in: shopIds } })
        .select('shopId shopName contactName phone -_id')
        .lean();
      const map = {};
      accounts.forEach(a => { map[a.shopId] = a; });
      orders.forEach(o => {
        const a = map[o.shopId];
        if (a) {
          if (!o.shopName && a.shopName) o.shopName = a.shopName;
          o.shopContact = a.contactName || '';
          o.shopPhone = a.phone || '';
        }
      });
      // 配送三件套：批量补全门店定位/门头照/收货方式/期望时段（读 Setting）
      // 供供应商打印小票（商家地址）、配送单页（门头照/导航/收货方式/时段排序）
      const settings = await Setting.find({ shopId: { $in: shopIds } })
        .select('shopId shopLongitude shopLatitude shopAddress storeFrontPhoto streetViewPhoto receiveMethod expectedReceiveStart expectedReceiveEnd -_id')
        .lean();
      const sMap = {};
      settings.forEach(s => { sMap[s.shopId] = s; });
      orders.forEach(o => {
        const s = sMap[o.shopId];
        if (s) {
          o.shopLongitude = s.shopLongitude;
          o.shopLatitude = s.shopLatitude;
          o.shopAddress = s.shopAddress || '';
          o.storeFrontPhoto = s.storeFrontPhoto || '';
          o.streetViewPhoto = s.streetViewPhoto || '';
          o.receiveMethod = s.receiveMethod || 'supplier_arranged';
          o.expectedReceiveStart = s.expectedReceiveStart || '';
          o.expectedReceiveEnd = s.expectedReceiveEnd || '';
        }
      });
    }

    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// 商家/开发者统一列表接口
router.get('/', verifyToken, listOrdersHandler);
// 供应商专属列表接口：GET /api/purchase-orders/supplier
// 返回当前供应商收到的所有订单（含商家名称/联系人/电话），支持 ?status=待确认 筛选
router.get('/supplier', requireSupplier, listOrdersHandler);

// ============ POST /api/purchase-orders 创建采购订单 ============
// 仅商家可下单；shopId/shopName 取自 JWT，前端不可伪造
// 支持下单时直接使用抵用券（couponId），满足起送价与券门槛校验后
// 在同一事务内：创建订单 + 核销券 + 计算 actualPayAmount

router.post('/', requireMerchant, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { supplierId, items, couponId, force } = req.body;
    // 商家身份从 JWT 取，忽略请求体里的 shopId/shopName
    const shopId = req.user.shopId;
    const shopName = req.user.shopName || '';

    if (!shopId || !supplierId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'supplierId、items 不能为空' });
    }

    // ============ 囤货保护预检（非 force 时拦截） ============
    // 商家下单提交时检测本次数量是否超过近 7 日采购总量；force=true 表示商家已在弹窗中坚持下单
    if (!force) {
      const { stockpileWarnings, priceDropWarnings } = await stockpileCheck.preCheckOrder(shopId, items);
      const hasWarning = stockpileWarnings.length > 0 || priceDropWarnings.length > 0;
      if (hasWarning) {
        // 返回预警详情（前端弹窗提醒，由商家选择"修改"或"坚持下单"）
        return res.status(409).json({
          success: false,
          code: 'STOCKPILE_WARNING',
          message: '本单存在异常，请确认',
          data: { stockpileWarnings, priceDropWarnings }
        });
      }
    }
    // force=true 跳过预检；同时记录异常标记（用于供应商后台标红）
    // 预检一次（无论是否 force），以拿到 anomalyItems / priceDropItems 用于订单标记
    const checkResult = await stockpileCheck.preCheckOrder(shopId, items);
    const anomalyItems = checkResult.stockpileWarnings.map(w => ({
      productId: w.productId,
      name: w.name,
      quantity: w.quantity,
      history7DayTotal: w.history7DayTotal,
      baseline: w.baseline,
      ratio: w.ratio
    }));
    const priceDropItems = checkResult.priceDropWarnings.map(w => ({
      productId: w.productId,
      name: w.name,
      unitPrice: w.unitPrice,
      avg7Day: w.avg7Day,
      dropRatio: w.dropRatio
    }));
    const anomalyFlag = anomalyItems.length > 0;
    const priceDropWarning = priceDropItems.length > 0;

    // 校验供应商存在
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    // 治理门槛：必须 status=active && agreementSigned && orderEnabled 才可被下单
    // 冻结/未审核/未签协议/未开通接单的供应商一律不可接新单
    if (supplier.status !== 'active' || !supplier.agreementSigned || !supplier.orderEnabled) {
      const reason = supplier.status === 'frozen'
        ? '该供应商已被冻结，暂不接受新订单'
        : (supplier.status === 'pending'
            ? '该供应商正在审核中，暂不开放采购'
            : (supplier.status === 'rejected'
                ? '该供应商未通过审核，暂不开放采购'
                : (!supplier.agreementSigned
                    ? '该供应商尚未签署合作协议，暂不开放采购'
                    : '该供应商尚未开通接单权限，暂不开放采购')));
      return res.status(400).json({ success: false, message: reason });
    }
    // 起送价（兜底 300，避免老数据缺字段导致 undefined）
    const minOrderAmount = Number(supplier.minOrderAmount) > 0 ? Number(supplier.minOrderAmount) : 300;

    // 校验商品并计算明细；同时根据商品写入对应 supplierId（防绕过）
    // 加价分销口径：供货价 = SupplyProduct.costPrice（供应商维护，商家不可覆盖）；
    //              卖价   = SupplyProduct.salePrice（平台手动填，未填则等于供货价）
    // 顾客按卖价付款；供应商分账供货价，平台分账差价。金额全程按分整数计算（utils/split）。
    let totalAmount = 0;
    let supplyAmount = 0;
    const itemDocs = [];
    for (const it of items) {
      if (!it.productId || !it.quantity) {
        return res.status(400).json({ success: false, message: '每个采购项需包含 productId 和 quantity' });
      }
      const product = await SupplyProduct.findById(it.productId);
      if (!product) {
        return res.status(404).json({ success: false, message: `商品不存在: ${it.productId}` });
      }
      // 安全校验：被采购商品的归属供应商必须与订单 supplierId 一致
      if (String(product.supplierId) !== String(supplierId)) {
        return res.status(400).json({ success: false, message: `商品「${product.name}」不属于该供应商` });
      }
      // 保鲜期冻结拦截：价格冻结中的商品不可下单（商家端显示"价格更新中"）
      if (product.priceFrozen) {
        return res.status(400).json({ success: false, message: `商品「${product.name}」价格更新中，暂不可下单，请稍后再试` });
      }
      const quantity = Number(it.quantity);
      // 供货价取自商品（供应商维护），卖价取自平台手动定价（未填默认=供货价）
      const supplyPrice = +(Number(product.costPrice) || 0).toFixed(2);
      const salePrice = +split.resolveSalePrice(product.salePrice, product.costPrice).toFixed(2);
      const totalPrice = +(salePrice * quantity).toFixed(2);        // 卖价小计（顾客应付）
      const supplyLineTotal = +(supplyPrice * quantity).toFixed(2); // 供货价小计（供应商实收）
      totalAmount += totalPrice;
      supplyAmount += supplyLineTotal;
      itemDocs.push({
        productId: product._id,
        name: product.name,
        category: product.category || '',
        quantity,
        unitPrice: salePrice,        // 兼容字段：商家视角单价 = 卖价
        totalPrice,
        supplyPrice,
        salePrice,
        retailPrice: salePrice,      // 兼容字段（旧名）
        supplyLineTotal,
        saleLineTotal: totalPrice,
        platformRate: 0              // 已废弃：手动定价不计算加价率
      });
    }
    totalAmount = +totalAmount.toFixed(2);
    supplyAmount = +supplyAmount.toFixed(2);
    const platformAmount = +(Math.max(0, totalAmount - supplyAmount)).toFixed(2);

    // 起送价校验：订单合计必须 >= 供应商起送价
    if (totalAmount < minOrderAmount) {
      return res.status(400).json({ success: false, message: `订单金额未满该供应商起送价 ¥${minOrderAmount}（当前 ¥${totalAmount}）` });
    }

    // 抵用券校验（可选）：券属当前 shopId、未使用、未过期、满足门槛
    let coupon = null;
    let discountAmount = 0;
    if (couponId) {
      coupon = await Coupon.findById(couponId);
      if (!coupon) {
        return res.status(404).json({ success: false, message: '抵用券不存在' });
      }
      if (String(coupon.shopId) !== String(shopId)) {
        return res.status(403).json({ success: false, message: '抵用券不属于当前店铺' });
      }
      if (coupon.status !== 'unused') {
        return res.status(409).json({ success: false, message: `抵用券状态为「${coupon.status}」，不可使用` });
      }
      if (new Date() >= new Date(coupon.expireDate)) {
        return res.status(409).json({ success: false, message: '抵用券已过期' });
      }
      if (totalAmount < coupon.minOrder) {
        return res.status(409).json({ success: false, message: `订单金额未满 ¥${coupon.minOrder}，不满足该券使用条件` });
      }
      discountAmount = coupon.faceValue;
    }
    const actualPayAmount = +(Math.max(0, totalAmount - discountAmount)).toFixed(2);

    const orderNo = generateOrderNo();
    let orderDoc;
    await session.withTransaction(async () => {
      // 1) 创建订单（券信息一并写入，actualPayAmount = totalAmount - 抵扣）
      // 囤货保护：写入 anomalyFlag / anomalyItems / priceDropWarning / priceDropItems 供供应商后台标红
      const created = await PurchaseOrder.create([{
        orderNo,
        shopId,
        shopName,
        supplierId,
        items: itemDocs,
        totalAmount,
        supplyAmount,
        platformAmount,
        platformRate: 0, // 已废弃：手动定价不计算加价率
        appliedCouponId: coupon ? coupon._id : null,
        discountAmount,
        actualPayAmount,
        status: '待确认',
        // 云分账：下单即置「待分账」，随后发起分账指令
        splitStatus: '待分账',
        pointsGenerated: 0,
        rewardCoin: 0,
        payStatus: 'unpaid',
        anomalyFlag,
        anomalyItems,
        priceDropWarning,
        priceDropItems
      }], { session });
      orderDoc = created[0];

      // 2) 若使用券，在同一事务内核销：状态置已使用，记录 usedOrderId 与 usedAt
      if (coupon) {
        await Coupon.findByIdAndUpdate(
          coupon._id,
          { status: 'used', usedOrderId: String(orderDoc._id), usedAt: new Date() },
          { session }
        );
      }
    });

    // ============ 支付 + 云分账（下单付款即发起分账指令）============
    // 走统一支付抽象层：mock 阶段下单即视为支付成功并发起分账；
    // 接入真实微信支付后，改为由支付回调置 payStatus=paid 并触发 initiateOrderSplit。
    const pay = await paymentProvider.createPayment(orderDoc);
    orderDoc.payNo = pay.payNo;
    orderDoc.payStatus = 'paid';
    orderDoc.paidAt = new Date();
    orderDoc.transactionId = `MOCKTX${pay.payNo}`;
    await initiateOrderSplit(orderDoc, supplier);
    await orderDoc.save();

    // 返回时 populate 供应商名与券信息，避免前端 undefined
    const populated = await PurchaseOrder.findById(orderDoc._id)
      .populate('supplierId', 'name contact phone')
      .populate('appliedCouponId', 'type faceValue minOrder name');

    // 自动化：订单创建（待确认）→ 通知供应商
    await sendNotification(supplier, 'order_created', {
      orderNo, shopId, shopName, totalAmount, actualPayAmount,
      splitAmount: orderDoc.splitAmount,
      supplierShare: orderDoc.supplierShare,
      platformShare: orderDoc.platformShare,
      items: itemDocs
    });

    res.status(201).json({ success: true, data: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
});

// ============ 供应商确认订单 ============
// 仅订单归属供应商可操作，校验 supplierId == req.user.supplierId
// 校验 status === '待确认' → 更新为 '已确认'

async function supplierConfirmHandler(req, res) {
  try {
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '采购订单不存在' });
    }
    // 权限校验：只能处理属于当前供应商的订单
    if (String(order.supplierId) !== String(req.user.supplierId)) {
      return res.status(403).json({ success: false, message: '无权操作该订单（非本供应商订单）' });
    }
    if (order.status !== '待确认') {
      return res.status(400).json({ success: false, message: `当前状态为「${order.status}」，无法确认` });
    }

    // 治理门槛：冻结供应商不可接新单（不能确认待确认订单）；在途的已确认订单仍可发货/完成
    const curSupplier = await Supplier.findById(order.supplierId).select('status agreementSigned orderEnabled frozenReason');
    if (!curSupplier || curSupplier.status === 'frozen') {
      return res.status(403).json({ success: false, message: '账户已被冻结，请联系平台' });
    }
    if (curSupplier.status !== 'active' || !curSupplier.agreementSigned || !curSupplier.orderEnabled) {
      return res.status(403).json({ success: false, message: '账号暂未开通接单权限，无法确认订单' });
    }

    order.status = '已确认';
    order.confirmAt = new Date();
    await order.save();

    const supplier = await Supplier.findById(order.supplierId);
    await sendNotification(supplier, 'order_confirmed', { orderNo: order.orderNo, status: order.status });

    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// PUT 与 POST 等价，前端可用任一动词
router.put('/:id/confirm', requireSupplier, supplierConfirmHandler);
router.post('/:id/confirm', requireSupplier, supplierConfirmHandler);

// ============ 供应商标记发货 ============
// 仅订单归属供应商可操作；校验 status === '已确认' → 更新为 '已发货'

async function supplierShipHandler(req, res) {
  try {
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '采购订单不存在' });
    }
    if (String(order.supplierId) !== String(req.user.supplierId)) {
      return res.status(403).json({ success: false, message: '无权操作该订单（非本供应商订单）' });
    }
    if (order.status !== '已确认') {
      return res.status(400).json({ success: false, message: `当前状态为「${order.status}」，无法发货` });
    }

    order.status = '已发货';
    order.deliverAt = new Date();
    await order.save();

    const supplier = await Supplier.findById(order.supplierId);
    await sendNotification(supplier, 'order_delivered', { orderNo: order.orderNo, status: order.status });

    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// PUT /deliver 与 POST /ship / POST /deliver 等价，兼容多种调用方式
router.put('/:id/deliver', requireSupplier, supplierShipHandler);
router.post('/:id/deliver', requireSupplier, supplierShipHandler);
router.post('/:id/ship', requireSupplier, supplierShipHandler);

// ============ GET /api/purchase-orders/:id 单笔订单详情 ============
// 三端鉴权：商家只能看自家订单、供应商只能看自己供应的、dev 全部
// 补全商家联系人/电话（ShopAccount 手动补全，同 listOrdersHandler）
// 补全门店定位/门头照/收货方式/期望时段（读 Setting，供供应商配送单页与商家详情使用）

async function getOrderDetailHandler(req, res) {
  try {
    const order = await PurchaseOrder.findById(req.params.id)
      .populate('supplierId', 'name contact phone')
      .populate('appliedCouponId', 'type faceValue minOrder name')
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: '采购订单不存在' });
    }
    // 权限校验：按 role 双向校验归属
    if (req.user.role === 'merchant' && String(order.shopId) !== String(req.user.shopId)) {
      return res.status(403).json({ success: false, message: '无权查看该订单' });
    }
    if (req.user.role === 'supplier' && String(order.supplierId._id) !== String(req.user.supplierId)) {
      return res.status(403).json({ success: false, message: '无权查看该订单' });
    }
    // 补全商家联系人/电话
    const acc = await ShopAccount.findOne({ shopId: order.shopId })
      .select('shopName contactName phone -_id').lean();
    if (acc) {
      if (!order.shopName && acc.shopName) order.shopName = acc.shopName;
      order.shopContact = acc.contactName || '';
      order.shopPhone = acc.phone || '';
    }
    // 补全门店定位与收货设置（供供应商配送单页使用）
    const st = await Setting.findOne({ shopId: order.shopId }).lean();
    if (st) {
      order.shopLongitude = st.shopLongitude;
      order.shopLatitude = st.shopLatitude;
      order.shopAddress = st.shopAddress || '';
      order.storeFrontPhoto = st.storeFrontPhoto || '';
      order.streetViewPhoto = st.streetViewPhoto || '';
      order.receiveMethod = st.receiveMethod || 'supplier_arranged';
      order.expectedReceiveStart = st.expectedReceiveStart || '';
      order.expectedReceiveEnd = st.expectedReceiveEnd || '';
    }
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

router.get('/:id', verifyToken, getOrderDetailHandler);

// ============ 供应商分拣过秤 POST /api/purchase-orders/:id/weigh ============
// 逐行写入实称重量，按实称重算行金额与订单总额（实付按实称结算）
// 全部行 weighed=true 时自动标记 sorted=true + sortedAt（不影响 status，仍处"已确认"待发货）

router.post('/:id/weigh', requireSupplier, async (req, res) => {
  try {
    const { items } = req.body; // [{ productId, actualWeight }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items 不能为空' });
    }
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '采购订单不存在' });
    }
    if (String(order.supplierId) !== String(req.user.supplierId)) {
      return res.status(403).json({ success: false, message: '无权操作该订单（非本供应商订单）' });
    }
    if (order.status !== '已确认') {
      return res.status(400).json({ success: false, message: `当前状态为「${order.status}」，不可分拣过秤` });
    }

    // 逐行重算实称金额：actualLineTotal（卖价）=actualWeight×salePrice；actualSupplyLineTotal（供货）=actualWeight×supplyPrice
    // 未过秤的行沿用原 quantity×单价 金额，避免丢金额
    for (const upd of items) {
      const row = order.items.find(x => String(x.productId) === String(upd.productId));
      if (!row) continue;
      const w = Number(upd.actualWeight);
      row.actualWeight = (isFinite(w) && w >= 0) ? w : 0;
      row.weighed = true;
      // 单价：卖价优先取 salePrice（老订单回退 retailPrice/unitPrice）；供货价取 supplyPrice（老订单回退 unitPrice）
      const saleUnit = Number(row.salePrice != null ? row.salePrice : (row.retailPrice != null ? row.retailPrice : row.unitPrice)) || 0;
      const supplyUnit = Number(row.supplyPrice != null ? row.supplyPrice : row.unitPrice) || 0;
      row.actualLineTotal = row.actualWeight > 0
        ? +(row.actualWeight * saleUnit).toFixed(2)
        : row.totalPrice;
      row.actualSupplyLineTotal = row.actualWeight > 0
        ? +(row.actualWeight * supplyUnit).toFixed(2)
        : (row.supplyLineTotal || +(supplyUnit * (row.quantity || 0)).toFixed(2));
    }

    // 订单总额 = Σ各行 actualLineTotal（已称行按实称，未称行保留原值）；供货价总额同理
    let newTotal = 0;
    let newSupply = 0;
    order.items.forEach(it => {
      newTotal += it.actualLineTotal || it.totalPrice || 0;
      const supplyUnit = Number(it.supplyPrice != null ? it.supplyPrice : it.unitPrice) || 0;
      newSupply += it.actualSupplyLineTotal || it.supplyLineTotal || (supplyUnit * (it.quantity || 0));
    });
    newTotal = +newTotal.toFixed(2);
    newSupply = +newSupply.toFixed(2);
    order.totalAmount = newTotal;
    // 分账快照：供货价总额（供应商应得）与平台差价（= 卖价总额 - 供货价总额）
    order.supplyAmount = newSupply;
    order.platformAmount = +(Math.max(0, newTotal - newSupply)).toFixed(2);
    // 券面值不重算，只抵总价：actualPayAmount = max(0, totalAmount - discountAmount)
    const discount = Number(order.discountAmount || 0);
    order.actualPayAmount = +(Math.max(0, newTotal - discount)).toFixed(2);

    // 全部行 weighed 即视为已分拣
    if (order.items.every(x => x.weighed)) {
      order.sorted = true;
      order.sortedAt = new Date();
      // 过秤后差额：D = Σ 卖价×(Q2−Q1)（可正可负）。D ≠ 0 → 进入「补差中」，待确认收货时执行补差。
      const comp = split.calcCompensation(order);
      order.compensateAmount = comp.compensateAmount;
      order.compensateSupplierShare = comp.compensateSupplierShare;
      order.compensatePlatformShare = comp.compensatePlatformShare;
      // 仅在尚未分账成功/已补差时推进状态，避免覆盖已完成的补差
      if (order.splitStatus !== split.SPLIT_STATUS.COMPENSATED) {
        if (Math.abs(comp.compensateAmount) > 0.0001) {
          order.splitStatus = split.SPLIT_STATUS.COMPENSATING;
          split.appendSplitLog(order, { action: 'weigh', status: '补差中', message: `过秤差额 ${comp.compensateAmount}（供应商 ${comp.compensateSupplierShare} / 平台 ${comp.compensatePlatformShare}）` });
        }
      }
    }
    await order.save();
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 供应商拍照送达 POST /api/purchase-orders/:id/deliver-photo ============
// 仅订单归属供应商可操作；校验 status === '已发货' → 写入 deliveryPhotoUrl + deliveredAt
// 自动推送通知商家"您的货已送达，附照片"（复用 sendNotification，当前 console.log 占位）

router.post('/:id/deliver-photo', requireSupplier, async (req, res) => {
  try {
    const { deliveryPhotoUrl } = req.body;
    if (!deliveryPhotoUrl) {
      return res.status(400).json({ success: false, message: '缺少送达照片 URL' });
    }
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '采购订单不存在' });
    }
    if (String(order.supplierId) !== String(req.user.supplierId)) {
      return res.status(403).json({ success: false, message: '无权操作该订单（非本供应商订单）' });
    }
    if (order.status !== '已发货') {
      return res.status(400).json({ success: false, message: `当前状态为「${order.status}」，不可送达` });
    }
    order.deliveryPhotoUrl = String(deliveryPhotoUrl).slice(0, 500);
    order.deliveredAt = new Date();
    await order.save();

    const supplier = await Supplier.findById(order.supplierId);
    await sendNotification(supplier, 'order_delivered_photo', {
      orderNo: order.orderNo,
      shopId: order.shopId,
      deliveryPhotoUrl: order.deliveryPhotoUrl,
      deliveredAt: order.deliveredAt
    });

    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ 商家确认收货（分账补差 + 积分 + 鼎恒币发币）============
// 该接口处理收货结算：
//   - status: 已发货 → 已完成，记录 receiveAt
//   - 云分账补差：若过秤后差额 compensateAmount ≠ 0，通过支付抽象层执行补差
//     （D>0 补收：顾客补付 D，其中供货价差补分账给供应商；D<0 退款：按比例追回供应商/平台），
//     执行成功后 splitStatus → 已补差。返点体系已停用，不再计算 preRebate/actualRebateAmount。
//   - 商家账户积分：pointsGenerated = totalAmount（ShopAccount.pointsBalance）
//   - 鼎恒币发币：按订单明细逐行计算——每行 = 商品金额(totalPrice) × 会员返币率(coinRate)
//     × 该商品所属品类得币倍率（CoinRule 配置，未配置按 1 倍），逐行汇总后向下取整
// 以上结算在同一事务内完成，保证原子性（分账补差为渠道调用，在事务外执行）。
async function confirmReceiveHandler(req, res) {
  const session = await mongoose.startSession();
  try {
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '采购订单不存在' });
    }
    // 权限校验：仅下单商家本人可确认收货
    if (String(order.shopId) !== String(req.user.shopId)) {
      return res.status(403).json({ success: false, message: '无权操作该订单（非本店铺订单）' });
    }
    if (order.status !== '已发货') {
      return res.status(400).json({ success: false, message: `当前状态为「${order.status}」，无法确认收货` });
    }
    if (order.rewardCoin !== 0) {
      return res.status(400).json({ success: false, message: '本单已发放过鼎恒币，不可重复结算' });
    }

    const supplier = await Supplier.findById(order.supplierId);

    // 预读会员等级以决定返币率（事务外读取；不存在则创建并触发首月赠送）
    let member = await Member.findOne({ shopId: order.shopId });
    if (!member) member = await Member.create({ shopId: order.shopId, shopName: order.shopName });
    // 返币率按采购线生效档位（free 2元=1币；plus/pro 1元=1币）
    const rate = entitlements.coinRateOf(member);

    // 发币：券不返币——严格按实付金额计算。若本单用了抵用券，券抵扣额按各行金额占比
    // 分摊到各行（actualPayAmount/totalAmount），每行实付金额 × 会员返币率 × 品类得币倍率，
    // 逐行汇总后向下取整。券抵扣部分绝不发币；前后端规则完全一致。
    // 基础版 2元=1币 => rate 0.5；进阶/尊享 1元=1币 => rate 1；倍率来自 CoinRule（未配置按 1 倍）
    // 未用券时 actualPayAmount 取 totalAmount（兼容老订单缺 actualPayAmount 字段，避免误判为 0 实付）
    const hasCoupon = Number(order.discountAmount) > 0 || !!order.appliedCouponId;
    const coinMultMap = await coinRule.getMultiplierMap();
    const coinCalc = await coinRule.calcOrderRewardCoin(order.items, rate, coinMultMap, {
      totalAmount: order.totalAmount,
      actualPayAmount: hasCoupon ? order.actualPayAmount : order.totalAmount
    });
    const rewardCoin = coinCalc.rewardCoin;
    const pointsGenerated = +(order.totalAmount).toFixed(2);
    const receiveAt = new Date();

    // ============ 云分账：过秤补差执行（差额 = 卖价×(Q2−Q1)）============
    // D ≠ 0 时通过支付抽象层补差：含「补分账给供应商 + 补分账给平台」两笔（退款则为追回）。
    const comp = split.calcCompensation(order);
    const hasCompensation = Math.abs(comp.compensateAmount) > 0.0001;
    let compensateResult = null;
    if (hasCompensation) {
      order.compensateAmount = comp.compensateAmount;
      order.compensateSupplierShare = comp.compensateSupplierShare;
      order.compensatePlatformShare = comp.compensatePlatformShare;
      order.splitStatus = split.SPLIT_STATUS.COMPENSATING;
      split.appendSplitLog(order, { action: 'compensate:init', status: '补差中', message: `差额 ${comp.compensateAmount}` });
      try {
        compensateResult = await paymentProvider.compensate(order, comp.compensateFen);
      } catch (e) {
        compensateResult = { status: 'failed', error: String((e && e.message) || '补差异常').slice(0, 300) };
      }
      if (compensateResult && compensateResult.status === 'success') {
        order.splitStatus = split.SPLIT_STATUS.COMPENSATED;
        order.compensateNo = compensateResult.compensateNo || order.compensateNo;
        order.compensateAt = new Date();
        split.appendSplitLog(order, { action: 'compensate:done', status: '已补差', message: `流水号 ${order.compensateNo}` });
      } else {
        order.splitStatus = split.SPLIT_STATUS.FAILED;
        order.splitError = (compensateResult && compensateResult.error) || '补差失败';
        split.appendSplitLog(order, { action: 'compensate:fail', status: '分账失败', message: order.splitError });
      }
    }

    const result = await session.withTransaction(async () => {
      // 1) 更新订单：完成 + 发币/积分字段 + 云分账结果（分账指令在下单时已发起）
      const updatedOrder = await PurchaseOrder.findByIdAndUpdate(
        order._id,
        {
          status: '已完成',
          receiveAt,
          pointsGenerated,
          rewardCoin,
          splitStatus: order.splitStatus,
          splitAmount: order.splitAmount,
          supplierShare: order.supplierShare,
          platformShare: order.platformShare,
          splitNo: order.splitNo,
          channelSplitOrderId: order.channelSplitOrderId,
          splitAt: order.splitAt,
          splitRetryCount: order.splitRetryCount,
          splitError: order.splitError,
          splitLogs: order.splitLogs,
          compensateAmount: order.compensateAmount,
          compensateSupplierShare: order.compensateSupplierShare,
          compensatePlatformShare: order.compensatePlatformShare,
          compensateNo: order.compensateNo,
          compensateAt: order.compensateAt
        },
        { new: true, session }
      );

      // 3) 商家账户积分累加（无则创建）
      const account = await ShopAccount.findOneAndUpdate(
        { shopId: order.shopId },
        {
          $inc: { pointsBalance: pointsGenerated },
          $setOnInsert: { shopName: order.shopName }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, session }
      );

      // 4) 鼎恒币发币：Member 余额与累计增加，并写入流水（FIFO 扣减依据 remaining）
      let currentBalance = member.dinghengCoin;
      if (rewardCoin > 0) {
        const m = await Member.findOneAndUpdate(
          { shopId: order.shopId },
          { $inc: { dinghengCoin: rewardCoin, totalEarnedCoin: rewardCoin } },
          { new: true, session }
        );
        currentBalance = m.dinghengCoin;

        const expireAt = new Date(receiveAt.getTime() + dhConfig.coinExpireDays * 24 * 60 * 60 * 1000);
        await CoinHistory.create([{
          shopId: order.shopId,
          amount: rewardCoin,
          type: 'purchase_reward',
          sourceOrderId: String(order._id),
          balanceAfter: currentBalance,
          expireAt,
          remaining: rewardCoin,
          isExpired: false,
          description: `采购订单${order.orderNo}返鼎恒币` + (coinCalc.boosted ? '（含品类倍率加成）' : '')
        }], { session });
      }

      // 5) 商家库存入账：确认收货后，按实到数量增加库存
      //    实到量 = 已过秤且实称量>0 ? actualWeight : quantity（单位与商品采购单位一致）
      for (const it of order.items) {
        const inQty = (it.weighed && Number(it.actualWeight) > 0)
          ? Number(it.actualWeight)
          : Number(it.quantity);
        if (inQty > 0) {
          await ShopInventory.findOneAndUpdate(
            { shopId: order.shopId, productId: it.productId },
            { $inc: { quantity: inQty } },
            { upsert: true, new: true, setDefaultsOnInsert: true, session }
          );
        }
      }

      return {
        updatedOrder,
        shopPointsBalance: account.pointsBalance,
        rewardCoin,
        currentBalance,
        split: {
          splitStatus: order.splitStatus,
          splitAmount: order.splitAmount,
          supplierShare: order.supplierShare,
          platformShare: order.platformShare,
          compensateAmount: order.compensateAmount,
          compensateSupplierShare: order.compensateSupplierShare,
          compensatePlatformShare: order.compensatePlatformShare
        }
      };
    });

    await sendNotification(supplier, 'order_received', {
      orderNo: order.orderNo,
      status: '已完成',
      rewardCoin,
      pointsGenerated,
      split: result.split,
      shopPointsBalance: result.shopPointsBalance,
      currentBalance: result.currentBalance
    });

    res.json({
      success: true,
      data: result.updatedOrder,
      rewardCoin: result.rewardCoin,
      currentBalance: result.currentBalance,
      extra: {
        pointsGenerated,
        split: result.split,
        shopPointsBalance: result.shopPointsBalance
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
}

// 主接口：商家确认收货 + 自动发币
router.post('/:id/confirm-receive', requireMerchant, confirmReceiveHandler);
// 兼容旧路由
router.put('/:id/receive', requireMerchant, confirmReceiveHandler);

// ============ POST /api/purchase-orders/:id/apply-coupon 下单时应用券 ============
// 每笔订单限用一张券，不可叠加；用券后 actualPayAmount 减少，收货发币按实付金额计算（券不返币）
// 仅下单商家本人可对本单用券

router.post('/:id/apply-coupon', requireMerchant, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { couponId } = req.body;
    if (!couponId) {
      return res.status(400).json({ success: false, message: 'couponId 不能为空' });
    }

    const result = await session.withTransaction(async () => {
      const order = await PurchaseOrder.findById(req.params.id).session(session);
      if (!order) {
        const e = new Error('采购订单不存在'); e.code = 'NOT_FOUND'; throw e;
      }
      // 权限校验：仅下单商家本人可对本单用券
      if (String(order.shopId) !== String(req.user.shopId)) {
        const e = new Error('无权操作该订单（非本店铺订单）'); e.code = 'FORBIDDEN'; throw e;
      }
      if (order.appliedCouponId) {
        const e = new Error('本单已使用抵用券，每单限用一张'); e.code = 'CONFLICT'; throw e;
      }

      const coupon = await Coupon.findById(couponId).session(session);
      if (!coupon) {
        const e = new Error('抵用券不存在'); e.code = 'NOT_FOUND'; throw e;
      }
      if (String(coupon.shopId) !== String(order.shopId)) {
        const e = new Error('抵用券不属于当前店铺'); e.code = 'FORBIDDEN'; throw e;
      }
      if (coupon.status !== 'unused') {
        const e = new Error(`抵用券状态为「${coupon.status}」，不可使用`); e.code = 'CONFLICT'; throw e;
      }
      if (new Date() >= coupon.expireDate) {
        const e = new Error('抵用券已过期'); e.code = 'CONFLICT'; throw e;
      }
      if (order.totalAmount < coupon.minOrder) {
        const e = new Error(`订单金额未满 ${coupon.minOrder}，不满足该券使用条件`); e.code = 'CONFLICT'; throw e;
      }

      const discountAmount = coupon.faceValue;
      const actualPayAmount = +(order.totalAmount - discountAmount).toFixed(2);

      const updatedOrder = await PurchaseOrder.findByIdAndUpdate(
        order._id,
        {
          appliedCouponId: coupon._id,
          discountAmount,
          actualPayAmount
        },
        { new: true, session }
      );
      await Coupon.findByIdAndUpdate(
        coupon._id,
        { status: 'used', usedOrderId: String(order._id), usedAt: new Date() },
        { session }
      );

      return { order: updatedOrder, actualPayAmount, discountAmount };
    });

    res.json({ success: true, data: result.order, actualPayAmount: result.actualPayAmount, discountAmount: result.discountAmount });
  } catch (err) {
    const code = err.code;
    if (code === 'NOT_FOUND') return res.status(404).json({ success: false, message: err.message });
    if (code === 'FORBIDDEN') return res.status(403).json({ success: false, message: err.message });
    if (code === 'CONFLICT') return res.status(409).json({ success: false, message: err.message });
    res.status(500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
});

// ============ GET /api/purchase-orders/:id/split 查询分账结果 ============
// 三端鉴权：商家看自家订单、供应商看自己供应的、dev 全部
router.get('/:id/split', verifyToken, async (req, res) => {
  try {
    const order = await PurchaseOrder.findById(req.params.id)
      .select('orderNo shopId supplierId payStatus payNo transactionId splitStatus splitAmount supplierShare platformShare splitNo channelSplitOrderId splitAt splitRetryCount splitError splitLogs compensateAmount compensateSupplierShare compensatePlatformShare compensateNo compensateAt')
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: '采购订单不存在' });
    }
    if (req.user.role === 'merchant' && String(order.shopId) !== String(req.user.shopId)) {
      return res.status(403).json({ success: false, message: '无权查看该分账' });
    }
    if (req.user.role === 'supplier' && String(order.supplierId) !== String(req.user.supplierId)) {
      return res.status(403).json({ success: false, message: '无权查看该分账' });
    }
    res.json({
      success: true,
      data: {
        orderNo: order.orderNo,
        payStatus: order.payStatus,
        payNo: order.payNo,
        transactionId: order.transactionId,
        splitStatus: order.splitStatus,
        splitAmount: order.splitAmount,
        supplierShare: order.supplierShare,
        platformShare: order.platformShare,
        splitNo: order.splitNo,
        channelSplitOrderId: order.channelSplitOrderId,
        splitAt: order.splitAt,
        splitRetryCount: order.splitRetryCount,
        splitError: order.splitError,
        splitLogs: order.splitLogs || [],
        compensateAmount: order.compensateAmount,
        compensateSupplierShare: order.compensateSupplierShare,
        compensatePlatformShare: order.compensatePlatformShare,
        compensateNo: order.compensateNo,
        compensateAt: order.compensateAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/purchase-orders/:id/split/retry 分账失败重试 ============
// 仅「待分账 / 已发起分账 / 分账失败」可重试；成功后 splitStatus → 分账成功
router.post('/:id/split/retry', verifyToken, async (req, res) => {
  try {
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '采购订单不存在' });
    }
    if (req.user.role === 'merchant' && String(order.shopId) !== String(req.user.shopId)) {
      return res.status(403).json({ success: false, message: '无权操作该订单' });
    }
    if (req.user.role === 'supplier' && String(order.supplierId) !== String(req.user.supplierId)) {
      return res.status(403).json({ success: false, message: '无权操作该订单' });
    }
    const retryable = [split.SPLIT_STATUS.PENDING, split.SPLIT_STATUS.INITIATED, split.SPLIT_STATUS.FAILED];
    if (!retryable.includes(order.splitStatus)) {
      return res.status(400).json({ success: false, message: `当前分账状态为「${order.splitStatus}」，无需重试` });
    }
    const supplier = await Supplier.findById(order.supplierId);
    await initiateOrderSplit(order, supplier);
    await order.save();
    res.json({ success: true, data: { splitStatus: order.splitStatus, splitRetryCount: order.splitRetryCount, splitError: order.splitError } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ POST /api/purchase-orders/:id/split/callback 支付/分账渠道回调 ============
// 由支付渠道调用（无 JWT）：校验签名 → 置支付成功 → 触发起始分账（下单付款即分账）
router.post('/:id/split/callback', async (req, res) => {
  try {
    const cb = await paymentProvider.handleCallback(req.body);
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: '采购订单不存在' });
    }
    if (cb.status === 'paid') {
      order.payStatus = 'paid';
      order.paidAt = order.paidAt || new Date();
      order.transactionId = cb.transactionId || order.transactionId;
      if (order.splitStatus === split.SPLIT_STATUS.PENDING || order.splitStatus === split.SPLIT_STATUS.FAILED) {
        const supplier = await Supplier.findById(order.supplierId);
        await initiateOrderSplit(order, supplier);
      }
    }
    split.appendSplitLog(order, { action: 'callback', status: order.splitStatus, message: `支付回调 ${cb.transactionId || ''}` });
    await order.save();
    res.json({ success: true, data: { payStatus: order.payStatus, splitStatus: order.splitStatus } });
  } catch (err) {
    const code = err && err.code;
    if (code === 'PAY_NOTIFY_VERIFY_FAILED') {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
// 供开发者后台「分账失败重试」复用
module.exports.initiateOrderSplit = initiateOrderSplit;
