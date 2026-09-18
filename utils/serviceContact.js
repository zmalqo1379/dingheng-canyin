// ============ 平台客服联系方式（唯一事实源） ============
// 只从环境变量读取，未配置时回退到「明显是占位」的默认值；
// 真实客服电话 / 邮箱请在部署环境的 .env 中配置 SERVICE_PHONE / SUPPORT_EMAIL。
// 后端各接口（membership、supplier/profile 等）统一从这里取值下发给前端，前端不得自行硬编码。

const PLACEHOLDER_PHONE = '400-000-0000（未配置）';
const PLACEHOLDER_EMAIL = 'support@placeholder.example.com（未配置）';

function getServicePhone() {
  const v = String(process.env.SERVICE_PHONE || '').trim();
  return v || PLACEHOLDER_PHONE;
}

function getSupportEmail() {
  const v = String(process.env.SUPPORT_EMAIL || '').trim();
  return v || PLACEHOLDER_EMAIL;
}

module.exports = { getServicePhone, getSupportEmail };
