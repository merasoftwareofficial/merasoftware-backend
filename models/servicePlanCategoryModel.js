const mongoose = require('mongoose');

// SSOT for plan categories (read through helpers/planCategories.js), a list separate from project
// categories. The key is permanent because every plan stores it in servicePlan.categoryKey, so a
// category is only ever archived, never deleted or re-keyed.
const servicePlanCategorySchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    match: /^[a-z][a-z0-9_]{2,39}$/,
  },
  label: {
    type: String,
    required: true,
    trim: true,
    maxlength: 60,
  },
  description: {
    type: String,
    default: '',
    maxlength: 1000,
  },
  // Optional link to a project category key (helpers/projectCategories.js). Reference only.
  linkedProjectCategory: {
    type: String,
    default: null,
  },
  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
  },
  sortOrder: {
    type: Number,
    min: 0,
    max: 9999,
    default: 9999,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('servicePlanCategory', servicePlanCategorySchema);
