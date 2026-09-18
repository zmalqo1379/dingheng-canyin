/**
 * 统一支付 / 分账抽象层（paymentProvider）
 *
 * 目的：上层业务（采购下单、分账、退款、过秤补差）只调用本模块暴露的方法，
 *      不感知具体支付渠道与资金流走向。
 *
 * 两个运行时配置（utils/payRuntime.js，开发者后台可实时切换，立即生效）：
 *   - 支付模式 payMode：'mock'（演示，禁止调用真实接口）/ 'wechat'（真实微信支付）
 *   - 资金流模式 paymentFlowMode：
 *       'supplier_first'（默认）：门店货款直接进供应商特约商户号，平台分账抽走「加价部分」
 *         → 平台抽成远低于微信 30% 默认分账上限，无需申请高比例分账白名单
 *       'platform_first'：货款先进平台账户，再按供货价分账给供应商
 *         → 需微信「高比例分账」白名单批复后才可切换
 *     金额口径不变（utils/split.js）：供货价归供应商、加价归平台；本配置只决定资金路径。
 *
 * 金额口径：对外方法参数与返回值统一用「分」（整数）。
 */
const crypto = require('crypto');
const split = require('./split');
const payRuntime = require('./payRuntime');
const wechatPay = require('./wechatPay');

const MOCK_KEY = process.env.PAY_MOCK_KEY || '';
// 强制分账失败（仅测试分账失败 → 重试链路用）
const MOCK_FAIL_SPLIT = String(process.env.PAY_MOCK_FAIL_SPLIT || '') === 'true';

function nowNo(prefix) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}${ts}${rand}`;
}

/**
 * 按资金流模式解析「收款方（出资方）特约商户号」与分账接收方构造。
 * 金额口径（utils/split.js 权威计算，本函数不改金额）：
 *   supplier_first：钱进供应商 → 分账只把 platformShareFen 分给平台，剩余（供货价）解冻留在供应商账户
 *   platform_first：钱进平台   → 分账只把 supplierShareFen 分给供应商，剩余（加价）解冻留在平台账户
 */
function buildFlowTargets(sh) {
  const flowMode = payRuntime.getPaymentFlowMode();
  if (flowMode === 'supplier_first') {
    return {
      flowMode,
      payeeMchId: sh.supplierMchId || '',                      // 收款方 = 供应商特约商户号
      receivers: [{                                            // 分账接收方 = 平台（服务商商户号）
        type: 'MERCHANT_ID',
        role: 'platform',
        account: sh.platformMchId || '',
        amountFen: sh.platformShareFen,
        description: '平台加价部分'
      }]
    };
  }
  return {
    flowMode,
    payeeMchId: sh.platformMchId || '',                        // 收款方 = 平台（特约/服务商商户号）
    receivers: [{                                              // 分账接收方 = 供应商
      type: 'MERCHANT_ID',
      role: 'supplier',
      account: sh.supplierMchId || '',
      amountFen: sh.supplierShareFen,
      description: '供货价结算'
    }]
  };
}

// ============ mock provider（演示模式：所有交易均为模拟数据，不发起任何真实资金划转）============
const mockProvider = {
  name: 'mock',
  isMock: true,

  /**
   * 创建支付单：返回支付参数（真实实现返回微信下单参数 / code_url 等）
   * @param {object} order 采购订单（含 orderNo、totalAmount 等）
   * @returns {{payNo, channel, amountFen, status, params}}
   */
  async createPayment(order) {
    const payNo = order.payNo || nowNo('PAY');
    const amountFen = Math.round(Number(order.actualPayAmount != null ? order.actualPayAmount : order.totalAmount || 0) * 100);
    const flowMode = payRuntime.getPaymentFlowMode();
    return {
      payNo,
      channel: 'mock',
      amountFen,
      status: 'unpaid',
      // 真实实现：{ timeStamp, nonceStr, package, signType, paySign } 或 { code_url }
      params: {
        mock: true,
        orderNo: order.orderNo,
        amountFen,
        flowMode,
        // 资金流向说明（演示用）：supplier_first=钱进供应商账户 / platform_first=钱进平台账户
        flowDesc: flowMode === 'supplier_first'
          ? '货款直接进供应商特约商户账户，平台随后分账抽走加价部分'
          : '货款先进平台账户，平台随后按供货价分账给供应商'
      }
    };
  },

  /**
   * 查询支付结果
   */
  async queryPayment(payNo) {
    // mock：视为已支付
    return { payNo, status: 'paid', transactionId: `MOCKTX${payNo}`, amountFen: 0 };
  },

  /**
   * 处理支付回调（校验签名 + 解密），返回归一化结果
   * @param {object} payload 回调载荷（真实实现为 { headers, rawBody }）
   */
  async handleCallback(payload) {
    const p = payload || {};
    // mock 签名校验：配置了 PAY_MOCK_KEY 时校验 HMAC；未配置时放行（占位阶段）
    let verified = true;
    if (MOCK_KEY && p.sign) {
      const expect = crypto.createHmac('sha256', MOCK_KEY).update(String(p.raw || '')).digest('hex');
      verified = expect === p.sign;
    }
    if (!verified) {
      const e = new Error('支付回调验签失败');
      e.code = 'PAY_NOTIFY_VERIFY_FAILED';
      throw e;
    }
    return {
      verified,
      payNo: p.payNo || '',
      orderNo: p.orderNo || '',
      transactionId: p.transactionId || '',
      status: p.status || 'paid',
      amountFen: Number(p.amountFen) || 0
    };
  },

  /**
   * 发起分账（金额口径：utils/split.js 两笔拆账，本层只决定资金路径）
   * @param {object} order 采购订单
   * @param {object} [shares] 预计算的 { supplierShareFen, platformShareFen, supplierMchId, platformMchId }
   * @returns {{splitNo, status, channelSplitOrderId, flowMode, payeeMchId, receivers, error}}
   */
  async applyProfitSharing(order, shares) {
    const sh = shares || defaultShares(order);
    const splitNo = order.splitNo || nowNo('SP');
    if (MOCK_FAIL_SPLIT) {
      return { splitNo, status: 'failed', channelSplitOrderId: '', receivers: [], error: 'mock 分账失败（PAY_MOCK_FAIL_SPLIT=true）' };
    }
    const t = buildFlowTargets(sh);
    return {
      splitNo,
      status: 'success',
      channelSplitOrderId: `MOCKSP${splitNo}`,
      flowMode: t.flowMode,
      payeeMchId: t.payeeMchId,
      receivers: t.receivers,
      error: ''
    };
  },

  /**
   * 查询分账结果
   */
  async queryProfitSharing(order) {
    const splitNo = (order && order.splitNo) || '';
    return { splitNo, status: 'success', channelSplitOrderId: `MOCKSP${splitNo}`, receivers: [] };
  },

  /**
   * 退款（过秤实际少于下单时，把差额退给顾客）
   * @param {number} amountFen 退款金额（分，正数）
   */
  async refund(order, amountFen) {
    return {
      refundNo: nowNo('RF'),
      status: 'success',
      amountFen: Math.abs(Math.round(Number(amountFen) || 0))
    };
  },

  /**
   * 过秤补差（含补分账 / 追回）
   * @param {object} order 采购订单（items 已写入 actualWeight）
   * @param {number} [deltaFen] 补差金额（分，正=补收，负=退款）；缺省按 order 计算
   */
  async compensate(order, deltaFen) {
    const comp = split.calcCompensation(order);
    const dFen = (deltaFen != null) ? Math.round(Number(deltaFen)) : comp.compensateFen;
    if (dFen === 0) {
      return { compensateNo: '', status: 'none', compensateFen: 0, supplierFen: 0, platformFen: 0 };
    }
    const compensateNo = order.compensateNo || nowNo('CB');
    if (dFen > 0) {
      // 补收：顾客补付，其中 supplierFen 补分账给供应商，其余补分账给平台
      return {
        compensateNo,
        status: 'success',
        compensateFen: dFen,
        supplierFen: comp.compensateSupplierFen,
        platformFen: comp.compensatePlatformFen
      };
    }
    // 退款：退款给顾客，按比例追回供应商 / 平台（金额为负值表示追回）
    return {
      compensateNo,
      status: 'success',
      compensateFen: dFen,
      supplierFen: comp.compensateSupplierFen,
      platformFen: comp.compensatePlatformFen
    };
  }
};

// ============ 真实微信支付 provider（服务商模式 + 服务商分账）============
// 演示模式（payMode='mock'）下所有方法直接拒绝 —— 防止误调真实资金接口。
// 资金流模式由 utils/payRuntime 动态决定：
//   supplier_first：下单 sub_mchid = 供应商特约商户号（钱进供应商），分账把加价部分分给平台；
//   platform_first：下单 sub_mchid = 平台收款商户号（钱进平台），分账把供货价分给供应商。
const wechatSpProvider = {
  name: 'wechat_sp',
  isMock: false,

  _assertReal() {
    if (payRuntime.isDemoMode()) {
      const e = new Error('当前为演示模式（payMode=mock），已拒绝调用真实微信支付接口');
      e.code = 'DEMO_MODE_FORBIDDEN';
      throw e;
    }
    if (!wechatPay.isConfigured()) {
      const e = new Error('微信支付未配置（缺少 WXPAY_* 环境变量），无法发起真实支付');
      e.code = 'WXPAY_NOT_CONFIGURED';
      throw e;
    }
  },

  async createPayment(order) {
    this._assertReal();
    const flowMode = payRuntime.getPaymentFlowMode();
    const supplierSubMchId = (order && order.supplierWechatSubMchId) || '';
    // supplier_first 必须有钱进供应商的特约商户号（未进件订单在业务层已降级为人工分账，不应走到这里）
    const payeeSubMchId = flowMode === 'supplier_first' ? supplierSubMchId : wechatPay.subMchId();
    if (flowMode === 'supplier_first' && !payeeSubMchId) {
      const e = new Error('supplier_first 模式下供应商未配置特约商户号，无法收款');
      e.code = 'SUPPLIER_SUB_MCHID_MISSING';
      throw e;
    }
    const payNo = order.payNo || nowNo('PAY');
    const amountFen = Math.round(Number(order.actualPayAmount != null ? order.actualPayAmount : order.totalAmount || 0) * 100);
    const resp = await wechatPay.nativePrepay(
      {
        outTradeNo: order.orderNo,
        description: `鼎恒采购订单 ${order.orderNo}`,
        amountFen,
        attach: JSON.stringify({ payNo, orderId: String(order._id || ''), flowMode }),
        timeExpire: undefined
      },
      { subMchId: payeeSubMchId, profitSharing: true } // 带分账标识：支付成功后资金冻结，可发起分账
    );
    return {
      payNo,
      channel: 'wechat_sp',
      amountFen,
      status: 'unpaid',
      params: { codeUrl: resp && resp.code_url, flowMode, payeeSubMchId }
    };
  },

  async queryPayment(payNo) {
    this._assertReal();
    const resp = await wechatPay.queryOrder(payNo);
    return {
      payNo,
      status: resp && resp.trade_state === 'SUCCESS' ? 'paid' : 'unpaid',
      transactionId: (resp && resp.transaction_id) || '',
      amountFen: (resp && resp.amount && resp.amount.total) || 0
    };
  },

  async handleCallback(payload) {
    this._assertReal();
    const resource = await wechatPay.verifyAndDecryptNotify(payload.headers, payload.rawBody);
    return {
      verified: true,
      payNo: resource.out_trade_no || '',
      orderNo: resource.out_trade_no || '',
      transactionId: resource.transaction_id || '',
      status: resource.trade_state === 'SUCCESS' ? 'paid' : 'unpaid',
      amountFen: (resource.amount && resource.amount.total) || 0
    };
  },

  async applyProfitSharing(order, shares) {
    this._assertReal();
    const sh = shares || defaultShares(order);
    const t = buildFlowTargets(sh);
    const splitNo = order.splitNo || nowNo('SP');
    // 先确保接收方已添加（按出资方 sub_mchid 绑定；已存在视为成功）
    const receiver = t.receivers[0];
    if (receiver && receiver.account) {
      await wechatPay.addSplitReceiver(
        { account: receiver.account, name: '', relationType: 'SERVICE_PROVIDER' },
        { subMchId: t.payeeMchId }
      );
    }
    // 发起分账：unfreeze_unsplit=true → 只分 receiver 一笔，剩余资金自动解冻留给出资方
    const resp = await wechatPay.requestProfitSharing(
      {
        transactionId: order.transactionId,
        outOrderNo: splitNo,
        receivers: receiver && receiver.account
          ? [{ type: 'MERCHANT_ID', receiver_account: receiver.account, amount: receiver.amountFen, description: receiver.description }]
          : [],
        unfreezeUnsplit: true
      },
      { subMchId: t.payeeMchId }
    );
    return {
      splitNo,
      status: (resp && resp.state === 'PROCESSING') || resp ? 'success' : 'failed',
      channelSplitOrderId: (resp && resp.order_id) || '',
      flowMode: t.flowMode,
      payeeMchId: t.payeeMchId,
      receivers: t.receivers,
      error: ''
    };
  },

  async queryProfitSharing(order) {
    this._assertReal();
    const resp = await wechatPay.queryProfitSharing(
      { outOrderNo: order.splitNo, transactionId: order.transactionId },
      { subMchId: order.paymentFlowMode === 'supplier_first' ? (order.supplierWechatSubMchId || '') : wechatPay.subMchId() }
    );
    return { splitNo: order.splitNo, status: (resp && resp.state) || 'unknown', channelSplitOrderId: (resp && resp.order_id) || '', receivers: [] };
  },

  async refund(order, amountFen) {
    this._assertReal();
    const resp = await wechatPay.refund({
      transactionId: order.transactionId,
      outRefundNo: nowNo('RF'),
      refundFen: Math.abs(Math.round(Number(amountFen) || 0)),
      totalFen: Math.round(Number(order.actualPayAmount != null ? order.actualPayAmount : order.totalAmount || 0) * 100),
      reason: '过秤补差退款'
    });
    return { refundNo: (resp && resp.out_refund_no) || '', status: 'success', amountFen: Math.abs(Math.round(Number(amountFen) || 0)) };
  },

  async compensate(order, deltaFen) {
    this._assertReal();
    // 真实渠道：补收走二次下单收款，退款走 refund；金额拆分同 mock（split.js 权威计算）
    const comp = split.calcCompensation(order);
    const dFen = (deltaFen != null) ? Math.round(Number(deltaFen)) : comp.compensateFen;
    if (dFen === 0) {
      return { compensateNo: '', status: 'none', compensateFen: 0, supplierFen: 0, platformFen: 0 };
    }
    const compensateNo = order.compensateNo || nowNo('CB');
    if (dFen < 0) {
      const r = await this.refund(order, -dFen);
      return { compensateNo: r.refundNo, status: 'success', compensateFen: dFen, supplierFen: comp.compensateSupplierFen, platformFen: comp.compensatePlatformFen };
    }
    // 补收（dFen > 0）：真实场景需顾客二次支付，占位返回待补收标记，由人工/后续迭代接管
    return { compensateNo, status: 'pending_collect', compensateFen: dFen, supplierFen: comp.compensateSupplierFen, platformFen: comp.compensatePlatformFen };
  }
};

// 由订单计算默认分账份额（分）
function defaultShares(order) {
  const r = split.calcOrderSplit(order);
  return {
    supplierShareFen: Math.round(r.supplierShare * 100),
    platformShareFen: Math.round(r.platformShare * 100),
    supplierMchId: (order && order.supplierWechatSubMchId) || '',
    platformMchId: process.env.WXPAY_SP_MCHID || ''
  };
}

// 演示模式守卫：任何代码尝试直接取真实 provider 都会拿到守卫对象（调用即拒绝）
function getProvider() {
  if (payRuntime.getPayMode() === 'wechat') {
    return wechatSpProvider;
  }
  return mockProvider;
}

// 便捷方法（动态取当前 provider：支付模式切换后立即走新分支，不用重启）
const api = {
  providerType: () => getProvider().name,
  isMock: () => getProvider().isMock,
  createPayment: (order) => getProvider().createPayment(order),
  queryPayment: (payNo) => getProvider().queryPayment(payNo),
  handleCallback: (payload) => getProvider().handleCallback(payload),
  applyProfitSharing: (order, shares) => getProvider().applyProfitSharing(order, shares),
  queryProfitSharing: (order) => getProvider().queryProfitSharing(order),
  refund: (order, amountFen) => getProvider().refund(order, amountFen),
  compensate: (order, deltaFen) => getProvider().compensate(order, deltaFen),
  getProvider,
  // 供测试/开发者后台直接探测真实接口是否被演示模式拦截
  assertRealProvider: () => wechatSpProvider._assertReal()
};

module.exports = api;
