const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
  number: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['idle', 'occupied'],
    default: 'idle'
  }
}, { timestamps: true });

module.exports = mongoose.model('Table', tableSchema);
