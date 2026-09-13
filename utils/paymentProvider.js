/**
 * 统一支付 / 分账抽象层（paymentProvider）
 *
 * 目的：上层业务（采购下单、分账、退款、过秤补差）只调用本模块暴露的方法，
 *      不感知具体支付 SDK。等微信支付商户号确定后，只需替换 provider 内部实现
 *      （服务商分账 / 电商收付通），调用方代码不变。
 *
 * 当前为 mock 占位实现：返回可预测的模拟结果，便于单测与联调；不发起真实资金划转。
 * 切换真实实现：把 getProvider() 返回的 provider 换成接入 wechatPay 的适配器即可。
 *
 * 金额口径：对外方法参数与返回值统一用「分」（整数）。
 */
const crypto = require('crypto');
const split = require('./split');

// 支付渠道类型：mock=占位实现；wechat_sp=微信服务商分账；wechat_ecommerce=电商收付通（预留）
const PROVIDER_TYPE = process.env.PAY_PROVIDER || 'mock';
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

// ============ mock provider ============
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
    return {
      payNo,
      channel: 'mock',
      amountFen,
      status: 'unpaid',
      // 真实实现：{ timeStamp, nonceStr, package, signType, paySign } 或 { code_url }
      params: { mock: true, orderNo: order.orderNo, amountFen }
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
   * 发起分账（两笔拆账：供货价 → 供应商，差价 → 平台）
   * @param {object} order 采购订单
   * @param {object} [shares] 预计算的 { supplierShareFen, platformShareFen, supplierMchId, platformMchId }
   * @returns {{splitNo, status, channelSplitOrderId, receivers, error}}
   */
  async applyProfitSharing(order, shares) {
    const sh = shares || defaultShares(order);
    const splitNo = order.splitNo || nowNo('SP');
    if (MOCK_FAIL_SPLIT) {
      return { splitNo, status: 'failed', channelSplitOrderId: '', receivers: [], error: 'mock 分账失败（PAY_MOCK_FAIL_SPLIT=true）' };
    }
    return {
      splitNo,
      status: 'success',
      channelSplitOrderId: `MOCKSP${splitNo}`,
      receivers: [
        { role: 'supplier', account: sh.supplierMchId || '', amountFen: sh.supplierShareFen },
        { role: 'platform', account: sh.platformMchId || '', amountFen: sh.platformShareFen }
      ],
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

// 真实 provider 占位：待商户号确定后实现（委托 utils/wechatPay）
// const wechatProvider = { name:'wechat_sp', isMock:false, ... };

function getProvider() {
  // 目前仅接入 mock；PROVIDER_TYPE 为 wechat_* 时仍回退 mock，待真实 SDK 就绪后替换
  return mockProvider;
}

// 便捷方法（固定使用当前 provider）
const api = {
  providerType: PROVIDER_TYPE,
  isMock: () => getProvider().isMock,
  createPayment: (order) => getProvider().createPayment(order),
  queryPayment: (payNo) => getProvider().queryPayment(payNo),
  handleCallback: (payload) => getProvider().handleCallback(payload),
  applyProfitSharing: (order, shares) => getProvider().applyProfitSharing(order, shares),
  queryProfitSharing: (order) => getProvider().queryProfitSharing(order),
  refund: (order, amountFen) => getProvider().refund(order, amountFen),
  compensate: (order, deltaFen) => getProvider().compensate(order, deltaFen),
  getProvider
};

module.exports = api;
