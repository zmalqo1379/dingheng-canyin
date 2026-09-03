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

      if (!allowedLevels.includes(member.memberLevel)) {
        return res.status(403).json({
          success: false,
          message: '升级会员解锁此功能',
          feature: featureName,
          currentLevel: member.memberLevel,
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
