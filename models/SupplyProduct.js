const mongoose = require('mongoose');

const supplyProductSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    required: true,
    trim: true
  },
  image: {
    type: String,
    default: ''
  },
  unit: {
    type: String,
    default: '个'
  },
  costPrice: {
    type: Number,
    required: true,
    min: 0
  },
  marketPrice: {
    type: Number,
    required: true,
    min: 0
  },
  rebateRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 1
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  supplierName: {
    type: String,
    required: true,
    trim: true
  },
  stock: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['上架', '下架'],
    default: '上架'
  },
  description: {
    type: String,
    default: ''
  }
}, { timestamps: true });

module.exports = mongoose.model('SupplyProduct', supplyProductSchema);
