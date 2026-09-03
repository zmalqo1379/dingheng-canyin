const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const SupplyProduct = require('../models/SupplyProduct');
const ShopAccount = require('../models/ShopAccount');
const Member = require('../models/Member');
const CoinHistory = require('../models/CoinHistory');
const Coupon = require('../models/Coupon');
const dhConfig = require('../utils/dhConfig');
const rebate = require('../utils/rebate');
const coinRule = require('../utils/coinRule');
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

// 通知发送函数（预留）：当前用 console.log 模拟，后续可对接供应商 webhook
async function sendNotification(supplier, event, payload) {
  if (!supplier) return;
  console.log('[通知] 供应商:', supplier.name, '| 事件:', event, '| 接收方:', supplier.phone || supplier.webhookUrl || '未知');
  console.log('[通知] 内容:', JSON.stringify(payload, null, 2));
  // TODO: 若 supplier.webhookUrl 存在，可在此 POST 到供应商接口
  return true;
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
      .populate('supplierId', 'name contact phone')
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
    const { supplierId, items, couponId } = req.body;
    // 商家身份从 JWT 取，忽略请求体里的 shopId/shopName
    const shopId = req.user.shopId;
    const shopName = req.user.shopName || '';

    if (!shopId || !supplierId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'supplierId、items 不能为空' });
    }

    // 校验供应商存在
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应商不存在' });
    }
    // 起送价（兜底 300，避免老数据缺字段导致 undefined）
    const minOrderAmount = Number(supplier.minOrderAmount) > 0 ? Number(supplier.minOrderAmount) : 300;

    // 校验商品并计算明细；同时根据商品写入对应 supplierId（防绕过）
    let totalAmount = 0;
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
      // 优先使用请求中的 unitPrice（可改价），否则取商品供货价
      const unitPrice = it.unitPrice != null ? Number(it.unitPrice) : product.costPrice;
      const quantity = Number(it.quantity);
      const totalPrice = +(unitPrice * quantity).toFixed(2);
      totalAmount += totalPrice;
      itemDocs.push({
        productId: product._id,
        name: product.name,
        category: product.category || '',
        quantity,
        unitPrice,
        totalPrice
      });
    }
    totalAmount = +totalAmount.toFixed(2);

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
      const created = await PurchaseOrder.create([{
        orderNo,
        shopId,
        shopName,
        supplierId,
        items: itemDocs,
        totalAmount,
        appliedCouponId: coupon ? coupon._id : null,
        discountAmount,
        actualPayAmount,
        status: '待确认',
        rebateAmount: 0,
        pointsGenerated: 0,
        rewardCoin: 0
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

    // 返回时 populate 供应商名与券信息，避免前端 undefined
    const populated = await PurchaseOrder.findById(orderDoc._id)
      .populate('supplierId', 'name contact phone')
      .populate('appliedCouponId', 'type faceValue minOrder name');

    // 自动化：订单创建（待确认）→ 通知供应商
    await sendNotification(supplier, 'order_created', {
      orderNo,
      shopId,
      shopName,
      totalAmount,
      actualPayAmount,
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

// ============ 商家确认收货（自动结算：预估返点 + 积分 + 鼎恒币发币）============
// 该接口合并了原 /receive 的全部结算逻辑，并新增鼎恒币发放：
//   - status: 已发货 → 已完成，记录 receiveAt
//   - 预估返点：按当月该供应商分品类累计额实时定档（RebateRule 规则，无规则走默认兜底率），
//     写入 preRebate；实际返点由开发者月度结算（RebateSettlement）后回写并计入供应商余额
//   - 商家账户积分：pointsGenerated = totalAmount（ShopAccount.pointsBalance）
//   - 鼎恒币发币：按订单明细逐行计算——每行 = 商品金额(totalPrice) × 会员返币率(coinRate)
//     × 该商品所属品类得币倍率（CoinRule 配置，未配置按 1 倍），逐行汇总后向下取整
// 以上结算在同一事务内完成，保证原子性。
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
    const rate = dhConfig.coinRate[member.memberLevel] ?? 0;

    // 发币：按订单明细逐行计算「商品金额 × 会员返币率 × 品类得币倍率」，逐行汇总后向下取整
    // 基础版 2元=1币 => rate 0.5；进阶/尊享 1元=1币 => rate 1；倍率来自 CoinRule（未配置按 1 倍）
    const coinMultMap = await coinRule.getMultiplierMap();
    const coinCalc = await coinRule.calcOrderRewardCoin(order.items, rate, coinMultMap);
    const rewardCoin = coinCalc.rewardCoin;
    const pointsGenerated = +(order.totalAmount).toFixed(2);
    const receiveAt = new Date();

    // 预估返点：按当月该供应商分品类累计额（含本单）实时定档计算
    // 费率全部来自 RebateRule（分品类/通用规则），无规则时由服务按默认兜底率处理
    const rebateEstimate = await rebate.estimateOrderRebate({
      _id: order._id,
      supplierId: order.supplierId,
      receiveAt,
      items: order.items
    });
    const preRebate = rebateEstimate.preRebate;
    const preRebateRate = rebateEstimate.preRebateRate;
    const rebateMonth = rebateEstimate.month;
    // rebateAmount 为兼容字段，新流程下等于预估返点；实际返点月度结算后回写 actualRebateAmount
    const rebateAmount = preRebate;

    const result = await session.withTransaction(async () => {
      // 1) 更新订单：完成 + 发币/积分字段 + 预估返点字段
      const updatedOrder = await PurchaseOrder.findByIdAndUpdate(
        order._id,
        {
          status: '已完成',
          receiveAt,
          rebateAmount,
          preRebate,
          preRebateRate,
          rebateMonth,
          actualRebateAmount: null,
          rebateSettled: false,
          pointsGenerated,
          rewardCoin
        },
        { new: true, session }
      );

      // 2) 返点入账时机调整：完成时仅记录「预估返点」，不计入供应商余额；
      //    月度结算生成 RebateSettlement 后，实际返点才计入 Supplier.balance
      const supplierBalance = supplier ? Number(supplier.balance || 0) : 0;

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

      return { updatedOrder, supplierBalance, shopPointsBalance: account.pointsBalance, rewardCoin, currentBalance };
    });

    await sendNotification(supplier, 'order_received', {
      orderNo: order.orderNo,
      status: '已完成',
      rewardCoin,
      rebateAmount,
      pointsGenerated,
      supplierBalance: result.supplierBalance,
      shopPointsBalance: result.shopPointsBalance,
      currentBalance: result.currentBalance
    });

    res.json({
      success: true,
      data: result.updatedOrder,
      rewardCoin: result.rewardCoin,
      currentBalance: result.currentBalance,
      extra: {
        rebateAmount,
        pointsGenerated,
        supplierBalance: result.supplierBalance,
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
// 每笔订单限用一张券，不可叠加；用券后 actualPayAmount 减少，但收货仍按 totalAmount 发币
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

module.exports = router;
