const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
  number: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['idle', 'occupied'],
    default: 'idle'
  },
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true
  }
}, { timestamps: true });

// 同一商家下桌号不重复
tableSchema.index({ shopId: 1, number: 1 }, { unique: true });

module.exports = mongoose.model('Table', tableSchema);
