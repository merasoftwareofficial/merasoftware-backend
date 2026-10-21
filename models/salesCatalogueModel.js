const mongoose = require('mongoose');

// Sales configuration only. It never creates a bill, project or purchased plan.
const schema = new mongoose.Schema({
  _id: { type: String, default: 'packages' },
  packages: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true, minimize: false });

module.exports = mongoose.models.SalesCatalogue || mongoose.model('SalesCatalogue', schema);
