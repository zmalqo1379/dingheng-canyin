const express = require('express');
const router = express.Router();

const StoredValue = require('../models/StoredValue');
const Marketing = require('../models/Marketing');
const { requireMerchant, extractPublicShopId, requirePublicShopId } = require('../middlewares/auth');
const { isValidPhone } = require('./customerPoints');

// 计算某笔充值可享受的赠送金额：
// 取当前时间窗内启用的「充值送」活动中，recharge 门槛 <= 充值额 的最大 bonus
function pickBonus(amount, rules) {
  let best = 0;
  let bestRule = null;
  rules.forEach(r => {
    const threshold = Number(r.recharge) || 0;
    const bonus = Number(r.bonus) || 0;
    if (bonus > 0 && amount >= threshold && bonus > best) {
      best = bonus;
      bestRule = r;
    }
  });
  return { bonus: best, rule: bestRule };
}

// ============ POST /api/stored-value/recharge ============
// 商家登记顾客线下充值：写余额（实充 + 赠送）+ 流水
router.post('/recharge', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const { phone, amount, customerName } = req.body || {};
    const phoneStr = String(phone || '').trim();
    const amt = Number(amount);

    if (!isValidPhone(phoneStr)) {
      return res.status(400).json({ success: false, message: '请输入正确的 11 位手机号' });
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ success: false, message: '充值金额必须大于 0' });
    }

    // 当前生效的「充值送」活动
    const now = new Date();
    const rules = await Marketing.find({
      shopId,
      type: 'rechargeBonus',
      enabled: true,
      startTime: { $lte: now },
      $or: [{ endTime: null }, { endTime: { $gte: now } }]
    }).lean();
    const { bonus, rule } = pickBonus(amt, rules);

    // 原子自增（$inc + upsert）：并发充值不丢更新，首次充值自动开户
    const inc = {
      balance: +(amt + bonus).toFixed(2),
      totalRecharged: +amt.toFixed(2),
      totalBonus: +bonus.toFixed(2)
    };
    const update = { $inc: inc };
    if (customerName) update.$set = { customerName: String(customerName).trim().slice(0, 30) };

    const sv = await StoredValue.findOneAndUpdate(
      { shopId, phone: phoneStr },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // 追加流水（仅追加，不影响余额；余额快照取自增后的值）
    const entries = [{
      type: 'recharge',
      amount: +amt.toFixed(2),
      balance: sv.balance,
      note: '线下充值'
    }];
    if (bonus > 0) {
      entries.push({
        type: 'bonus',
        amount: +bonus.toFixed(2),
        balance: sv.balance,
        note: rule && rule.title ? `充值送·${rule.title}` : `充值送（充${rule ? rule.recharge : ''}送${bonus}）`
      });
    }
    await StoredValue.updateOne({ _id: sv._id }, { $push: { history: { $each: entries } } });
    // 重新读取以返回含最新流水的完整账户
    const fresh = await StoredValue.findById(sv._id).lean();

    res.status(201).json({
      success: true,
      data: fresh || sv,
      appliedBonus: bonus,
      message: bonus > 0 ? `充值成功，额外赠送 ¥${bonus.toFixed(2)}` : '充值成功'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/stored-value/accounts ============
// 商家查看储值账户列表（可按手机号/姓名搜索）
router.get('/accounts', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const kw = String(req.query.keyword || '').trim();
    const filter = { shopId };
    if (kw) {
      filter.$or = [
        { phone: { $regex: kw, $options: 'i' } },
        { customerName: { $regex: kw, $options: 'i' } }
      ];
    }
    const list = await StoredValue.find(filter)
      .sort({ updatedAt: -1 })
      .limit(200)
      .select('phone customerName balance totalRecharged totalBonus updatedAt')
      .lean();
    const totalBalance = list.reduce((s, a) => s + (Number(a.balance) || 0), 0);
    res.json({ success: true, data: list, totalBalance: +totalBalance.toFixed(2) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/stored-value/accounts/:phone/history ============
// 某顾客储值流水（商家核对用）
router.get('/accounts/:phone/history', requireMerchant, async (req, res) => {
  try {
    const shopId = req.shopId;
    const phone = String(req.params.phone || '').trim();
    const sv = await StoredValue.findOne({ shopId, phone }).lean();
    if (!sv) {
      return res.status(404).json({ success: false, message: '该顾客暂无储值账户' });
    }
    const history = (sv.history || []).slice().sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json({ success: true, data: { phone: sv.phone, customerName: sv.customerName, balance: sv.balance, history } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/stored-value/public-config ============
// 顾客端判断是否展示手机号/储值区块：该店存在有余额的储值账户即视为启用
router.get('/public-config', extractPublicShopId, requirePublicShopId, async (req, res) => {
  try {
    const shopId = req.publicShopId;
    const count = await StoredValue.countDocuments({ shopId, balance: { $gt: 0 } });
    res.json({ success: true, data: { enabled: count > 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============ GET /api/stored-value/account?phone= ============
// 顾客端按手机号查询储值余额（公开，需 shopId）
router.get('/account', extractPublicShopId, requirePublicShopId, async (req, res) => {
  try {
    const shopId = req.publicShopId;
    const phone = String(req.query.phone || '').trim();
    if (!isValidPhone(phone)) {
      return res.json({ success: true, data: { balance: 0 } });
    }
    const sv = await StoredValue.findOne({ shopId, phone }).select('balance customerName').lean();
    res.json({ success: true, data: { balance: sv ? sv.balance : 0, customerName: sv ? sv.customerName : '' } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
