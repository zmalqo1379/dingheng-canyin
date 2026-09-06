const Member = require('../models/Member');
const dhConfig = require('../utils/dhConfig');

// 功能权限中间件工厂：checkFeature('customerPoints') 等
// 读取当前商家 Member.memberLevel，比对 dhConfig.features[featureName] 允许的等级
// shopId 来源：req.shopId（鉴权后注入）或 body/query/params/header 兜底
function checkFeature(featureName) {
  return async (req, res, next) => {
    try {
      const shopId = req.shopId || req.body.shopId || req.query.shopId || req.params.shopId || req.headers['x-shop-id'];
      if (!shopId) {
        return res.status(401).json({ success: false, message: '缺少 shopId，无法校验权限' });
      }
      const allowedLevels = dhConfig.features[featureName];
      if (!allowedLevels) {
        return res.status(400).json({ success: false, message: `未知功能: ${featureName}` });
      }

      let member = await Member.findOne({ shopId });
      if (!member) member = await Member.create({ shopId });

      // 会员必须在有效期内（未开通/体验过期/月卡过期均视为无有效会员，不可用会员功能）
      const membershipActive = dhConfig.isMembershipActive(member);
      if (!allowedLevels.includes(member.memberLevel) || !membershipActive) {
        return res.status(403).json({
          success: false,
          message: membershipActive ? '升级会员解锁此功能' : '会员已过期，开通/续费会员后即可使用',
          feature: featureName,
          currentLevel: member.memberLevel,
          membershipActive,
          needLevel: allowedLevels
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
