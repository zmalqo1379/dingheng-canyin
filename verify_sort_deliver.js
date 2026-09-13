// 分拣打票与配送支持 - 自查脚本
require('dotenv').config();
const BASE = 'http://localhost:3000';

async function login(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json());
  return res;
}

async function main() {
  console.log('========== 分拣打票与配送支持 自查 ==========\n');

  // 1. 商家登录，测配送设置写入
  console.log('[1] 商家登录 + 配送设置写入/读取');
  const mLogin = await login('/api/auth/merchant/login', { phone: '13800138001', password: '123456' });
  if (!mLogin.success) { console.log('  商家登录失败:', mLogin.message); return; }
  const mToken = mLogin.data.token;
  const shopId = mLogin.data.shopId;
  console.log('  商家登录成功 shopId=', shopId);

  const putBody = {
    shopName: '鼎恒餐饮测试店',
    shopLongitude: 117.736,
    shopLatitude: 36.961,
    shopAddress: '测试市测试路1号',
    receiveMethod: 'open_door',
    expectedReceiveStart: '06:30',
    expectedReceiveEnd: '09:30',
    storeFrontPhoto: '/uploads/test_front.jpg'
  };
  const putRes = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + mToken, 'x-shop-id': shopId },
    body: JSON.stringify(putBody)
  }).then(r => r.json());
  console.log('  PUT /api/settings success=', putRes.success);
  console.log('  回读 receiveMethod=', putRes.data?.receiveMethod, 'lng=', putRes.data?.shopLongitude, 'addr=', putRes.data?.shopAddress);

  // GET 读回
  const getRes = await fetch(`${BASE}/api/settings?shopId=${shopId}`).then(r => r.json());
  console.log('  GET /api/settings shopAddress=', getRes.data?.shopAddress, 'storeFrontPhoto=', getRes.data?.storeFrontPhoto, 'expectedReceiveStart=', getRes.data?.expectedReceiveStart);

  // 非法 receiveMethod 应被剔除（保持默认）
  const badRes = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + mToken, 'x-shop-id': shopId },
    body: JSON.stringify({ receiveMethod: '非法值' })
  }).then(r => r.json());
  console.log('  非法 receiveMethod 被剔除后默认=', badRes.data?.receiveMethod, '(应保持上一步的 open_door 或默认 door_container)\n');

  // 2. dev 登录，测订单详情接口
  console.log('[2] dev 登录 + 订单列表/详情接口');
  const dLogin = await login('/api/auth/dev/login', { username: 'admin', password: 'dingheng2024' });
  if (!dLogin.success) { console.log('  dev 登录失败:', dLogin.message); return; }
  const dToken = dLogin.data.token;
  console.log('  dev 登录成功');

  // 列表（dev 看全部），验证新字段是否带出
  const listRes = await fetch(`${BASE}/api/purchase-orders`, {
    headers: { 'Authorization': 'Bearer ' + dToken }
  }).then(r => r.json());
  const orders = listRes.data || [];
  console.log('  订单总数=', orders.length);
  if (orders.length > 0) {
    const o = orders[0];
    console.log('  首单 _id=', String(o._id), 'orderNo=', o.orderNo, 'status=', o.status);
    console.log('  首单新字段: sorted=', o.sorted, 'deliveryPhotoUrl=', o.deliveryPhotoUrl, 'shopAddress=', o.shopAddress, 'storeFrontPhoto=', o.storeFrontPhoto, 'receiveMethod=', o.receiveMethod);
    console.log('  首单 items[0] 新字段: actualWeight=', o.items?.[0]?.actualWeight, 'weighed=', o.items?.[0]?.weighed, 'actualLineTotal=', o.items?.[0]?.actualLineTotal);

    // 测 GET /:id
    const idRes = await fetch(`${BASE}/api/purchase-orders/${o._id}`, {
      headers: { 'Authorization': 'Bearer ' + dToken }
    }).then(r => r.json());
    console.log('  GET /:id success=', idRes.success, '| sorted=', idRes.data?.sorted, '| shopAddress=', idRes.data?.shopAddress, '| shopPhone=', idRes.data?.shopPhone);
  }

  // 3. 权限隔离测试：商家 token 访问他人订单详情应 403（用一个非自家订单）
  //    取一个订单，若不属于当前商家，应被拒
  if (orders.length > 0) {
    const o = orders[0];
    const crossRes = await fetch(`${BASE}/api/purchase-orders/${o._id}`, {
      headers: { 'Authorization': 'Bearer ' + mToken, 'x-shop-id': shopId }
    }).then(r => r.json());
    const isOwn = String(o.shopId) === String(shopId);
    console.log('\n[3] 权限隔离: 商家用 GET /:id 访问', isOwn ? '自家订单(应200)' : '他人订单(应403)', '=> success=', crossRes.success, crossRes.success ? '' : ('msg=' + crossRes.message));
  }

  console.log('\n========== 自查结束 ==========');
}

main().catch(e => console.error('脚本异常:', e));
