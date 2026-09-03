const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  shopId: {
    type: String,
    required: true,
    index: true,
    trim: true
  }
}, { timestamps: true });

// 同一商家下分类名不重复
categorySchema.index({ shopId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Category', categorySchema);
