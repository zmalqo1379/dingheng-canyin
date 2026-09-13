// 分拣过秤 + 拍照送达 端到端验证（隔离测试，用完即删）
require('dotenv').config();
const BASE = 'http://localhost:3000';
const mongoose = require('mongoose');
const PurchaseOrder = require('./models/PurchaseOrder');
const Supplier = require('./models/Supplier');

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) }).then(r => r.json());
}

async function main() {
  console.log('===== 分拣过秤 + 拍照送达 端到端验证 =====\n');

  // 1. 注册测试供应商（直接拿 token + supplierId）
  console.log('[1] 注册测试供应商');
  const phone = '1' + Date.now().toString().slice(-10);
  const reg = await post('/api/auth/supplier/register', {
    name: '过秤测试供应商', contact: '测试员', phone, password: 'test123456', confirm: 'test123456', categories: ['蔬菜']
  });
  if (!reg.success) { console.log('  注册失败:', reg.message); return; }
  const sToken = reg.data.token;
  const supplierId = reg.data.supplierId;
  console.log('  注册成功 supplierId=', supplierId);

  await mongoose.connect(process.env.MONGODB_URI);

  // 2. 直插已确认测试订单（supplierId 用 ObjectId）
  console.log('\n[2] 直插已确认测试订单');
  const order = await PurchaseOrder.create({
    orderNo: 'WEIGHTEST' + Date.now(),
    shopId: 'shop_weigh_test',
    shopName: '过秤测试店',
    supplierId: supplierId,
    items: [
      { productId: '507f1f77bcf86cd799439011', name: '五花肉', category: '肉类', quantity: 5, unitPrice: 30, totalPrice: 150 },
      { productId: '507f1f77bcf86cd799439012', name: '白菜', category: '蔬菜', quantity: 10, unitPrice: 4, totalPrice: 40 }
    ],
    totalAmount: 190,
    actualPayAmount: 190,
    status: '已确认',
    confirmAt: new Date()
  });
  console.log('  订单 orderNo=', order.orderNo, '初始 total=', order.totalAmount);

  // 3. weigh：五花肉实称 4.5kg(=135)，白菜实称 8kg(=32)，total 应=167
  console.log('\n[3] POST /:id/weigh（逐行实称重算）');
  const weighRes = await post(`/api/purchase-orders/${order._id}/weigh`, {
    items: [
      { productId: '507f1f77bcf86cd799439011', actualWeight: 4.5 },
      { productId: '507f1f77bcf86cd799439012', actualWeight: 8 }
    ]
  }, sToken);
  console.log('  weigh success=', weighRes.success, weighRes.success ? '' : 'msg=' + weighRes.message);
  if (weighRes.success) {
    const d = weighRes.data;
    console.log('  五花肉 actualLineTotal=', d.items[0].actualLineTotal, '(期望 135)');
    console.log('  白菜 actualLineTotal=', d.items[1].actualLineTotal, '(期望 32)');
    console.log('  totalAmount=', d.totalAmount, '(期望 167) actualPayAmount=', d.actualPayAmount, '(期望 167)');
    console.log('  sorted=', d.sorted, '(期望 true)');
    const ok = d.items[0].actualLineTotal === 135 && d.items[1].actualLineTotal === 32 && d.totalAmount === 167 && d.sorted === true;
    console.log('  金额重算校验:', ok ? '✓ 通过' : '✗ 失败');
  }

  // 4. dev 调 weigh 应 403
  const dLogin = await post('/api/auth/dev/login', { username: 'admin', password: 'dingheng2024' });
  const weighDev = await post(`/api/purchase-orders/${order._id}/weigh`, { items: [{ productId: '507f1f77bcf86cd799439011', actualWeight: 1 }] }, dLogin.data.token);
  console.log('\n[4] dev 调 weigh 应被拒:', !weighDev.success ? '✓ 已拒(' + weighDev.message + ')' : '✗ 未拒');

  // 5. 已发货订单再 weigh 应失败
  await PurchaseOrder.updateOne({ _id: order._id }, { status: '已发货' });
  const weighShipped = await post(`/api/purchase-orders/${order._id}/weigh`, { items: [{ productId: '507f1f77bcf86cd799439011', actualWeight: 2 }] }, sToken);
  console.log('[5] 已发货订单调 weigh 应失败:', !weighShipped.success ? '✓ 已拒(' + weighShipped.message + ')' : '✗ 未拒');

  // 6. 拍照送达
  console.log('\n[6] POST /:id/deliver-photo');
  const dpRes = await post(`/api/purchase-orders/${order._id}/deliver-photo`, { deliveryPhotoUrl: '/uploads/deliver_test.jpg' }, sToken);
  console.log('  deliver-photo success=', dpRes.success, dpRes.success ? 'deliveryPhotoUrl=' + dpRes.data.deliveryPhotoUrl : 'msg=' + dpRes.message);
  if (dpRes.success) {
    const ok = dpRes.data.deliveryPhotoUrl === '/uploads/deliver_test.jpg' && dpRes.data.deliveredAt;
    console.log('  送达校验:', ok ? '✓ 通过' : '✗ 失败');
  }

  // 7. dev 调 deliver-photo 应 403
  const dpDev = await post(`/api/purchase-orders/${order._id}/deliver-photo`, { deliveryPhotoUrl: '/x.jpg' }, dLogin.data.token);
  console.log('[7] dev 调 deliver-photo 应被拒:', !dpDev.success ? '✓ 已拒' : '✗ 未拒');

  // 8. GET /:id 详情验证三端
  const detailSup = await fetch(BASE + `/api/purchase-orders/${order._id}`, { headers: { 'Authorization': 'Bearer ' + sToken } }).then(r => r.json());
  console.log('\n[8] GET /:id(供应商): success=', detailSup.success, 'sorted=', detailSup.data?.sorted, 'items[0].actualWeight=', detailSup.data?.items?.[0]?.actualWeight);

  // 清理
  console.log('\n[清理] 删除测试订单与供应商');
  await PurchaseOrder.deleteOne({ _id: order._id });
  await Supplier.deleteOne({ _id: supplierId });
  await mongoose.disconnect();
  console.log('  已清理');
  console.log('\n===== 验证结束 =====');
}

main().catch(async (e) => {
  console.error('异常:', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
