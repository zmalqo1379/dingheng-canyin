// 查找已确认订单 + 供应商，用于真实 weigh 路由测试
require('dotenv').config();
const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  // 找一个已确认订单
  const order = await PurchaseOrder.findOne({ status: '已确认' }).populate('supplierId').lean();
  console.log('已确认订单:', order ? { _id: String(order._id), orderNo: order.orderNo, shopId: order.shopId, supplierId: String(order.supplierId), supplierName: order.supplierId?.name, supplierLogin: order.supplierId?.loginAccount } : '无');
  if (order) {
    console.log('  items:', JSON.stringify(order.items.map(i => ({ name: i.name, qty: i.quantity, unitPrice: i.unitPrice, totalPrice: i.totalPrice, actualWeight: i.actualWeight, weighed: i.weighed })), null, 2));
    console.log('  totalAmount=', order.totalAmount, 'actualPayAmount=', order.actualPayAmount, 'discountAmount=', order.discountAmount);
    console.log('  supplier phone=', order.supplierId?.phone);
  }
  // 列出所有供应商
  const suppliers = await Supplier.find({}).select('name loginAccount phone').lean();
  console.log('\n所有供应商:');
  suppliers.forEach(s => console.log(`  name=${s.name} loginAccount=${s.loginAccount} phone=${s.phone}`));
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
