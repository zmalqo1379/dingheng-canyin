const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  dishName: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  tableNumber: {
    type: String,
    required: true
  },
  items: [orderItemSchema],
  totalPrice: {
    type: Number,
    required: true,
    default: 0
  },
  status: {
    type: String,
    enum: ['pending', 'completed'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
