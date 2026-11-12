const mongoose = require('mongoose');

// Sales configuration only. It never creates a bill, project or purchased plan.
const schema = new mongoose.Schema({
  _id: { type: String, default: 'packages' },
  packages: { type: mongoose.Schema.Types.Mixed, required: true },
  // A package's catalogue record may be permanently removed, but its ID must
  // never describe a different package later: orders, requests and snapshots
  // use it as their immutable historical identity.
  retiredPackageIds: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, minimize: false });

module.exports = mongoose.models.SalesCatalogue || mongoose.model('SalesCatalogue', schema);
