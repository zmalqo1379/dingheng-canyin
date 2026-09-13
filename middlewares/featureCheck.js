const Member = require('../models/Member');
const dhConfig = require('../utils/dhConfig');
const entitlements = require('../utils/entitlements');

// 功能权限中间件工厂：checkFeature('reportBasic') 等
// 2026-09 双产品线重构：统一走 utils/entitlements 判定，不再自行比较 memberLevel。
//   - 若 featureName 命中 posFeatures → 按点餐线判定
//   - 若命中 purchaseFeatures → 按采购线判定
//   - 生效的 addon 授权（币兑小产品）可临时解锁对应 feature
function checkFeature(featureName) {
  return async (req, res, next) => {
    try {
      const shopId = req.shopId || req.body.shopId || req.query.shopId || req.params.shopId || req.headers['x-shop-id'];
      if (!shopId) {
        return res.status(401).json({ success: false, message: '缺少 shopId，无法校验权限' });
      }
      const isPos = Object.prototype.hasOwnProperty.call(dhConfig.posFeatures, featureName);
      const isPurchase = Object.prototype.hasOwnProperty.call(dhConfig.purchaseFeatures, featureName);
      if (!isPos && !isPurchase) {
        return res.status(400).json({ success: false, message: `未知功能: ${featureName}` });
      }

      let member = await Member.findOne({ shopId });
      if (!member) member = await Member.create({ shopId });

      const addonFeatures = await entitlements.getActiveAddonFeatures(shopId);
      const ok = isPos
        ? entitlements.hasPosFeature(featureName, member, addonFeatures)
        : entitlements.hasPurchaseFeature(featureName, member, addonFeatures);

      if (!ok) {
        const st = isPos ? entitlements.posState(member) : entitlements.purchaseState(member);
        return res.status(403).json({
          success: false,
          message: st.active ? '升级会员解锁此功能' : '会员已过期，开通/续费会员后即可使用',
          feature: featureName,
          productLine: isPos ? 'pos' : 'purchase',
          currentLevel: st.paidLevel,
          active: st.active
        });
      }

      req.member = member;
      next();
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  };
}

module.exports = { checkFeature };
