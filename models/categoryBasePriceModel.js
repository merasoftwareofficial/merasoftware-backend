const mongoose = require('mongoose');

// SSOT for project categories (read through helpers/projectCategories.js). The collection keeps
// its original name so the live base prices stay where they are. The key (`category`) is
// permanent because every project order stores it.
const categoryBasePriceSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    unique: true,
    match: /^[a-z][a-z0-9_]{2,39}$/,
  },
  label: {
    type: String,
    trim: true,
    maxlength: 60,
  },
  // null = not configured: customers cannot order this category until a price is saved.
  basePrice: {
    type: Number,
    default: null,
    min: 0,
  },
  description: {
    type: String,
    default: "",
  },
  startingNodeTitle: {
    type: String,
    default: "",
  },
  // Unset on rows saved before the SSOT existed; helpers/projectCategories.js supplies defaults.
  status: {
    type: String,
    enum: ["active", "archived"],
  },
  sortOrder: {
    type: Number,
    min: 0,
    max: 9999,
  },
  customerSelectable: {
    type: Boolean,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
  },
}, {
  timestamps: true,
});

const categoryBasePriceModel = mongoose.model("categoryBasePrice", categoryBasePriceSchema);
module.exports = categoryBasePriceModel;
