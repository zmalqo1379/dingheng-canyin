// 清理：恢复测试商家(13800138001)的配送字段为空，删除自查脚本
require('dotenv').config();
const mongoose = require('mongoose');
const Setting = require('./models/Setting');
const ShopAccount = require('./models/ShopAccount');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const acc = await ShopAccount.findOne({ phone: '13800138001' });
  if (!acc) { console.log('测试商家不存在，跳过'); await mongoose.disconnect(); return; }
  const res = await Setting.updateOne(
    { shopId: acc.shopId },
    { $set: { shopLongitude: null, shopLatitude: null, shopAddress: '', storeFrontPhoto: '', streetViewPhoto: '', receiveMethod: 'door_container', expectedReceiveStart: '06:00', expectedReceiveEnd: '09:00' } }
  );
  console.log('已恢复测试商家配送字段，matched=', res.matched, 'modified=', res.modified);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
