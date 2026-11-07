const mongoose = require('mongoose');

// The working copy of a package and its offer (merasoftware/src/docs/package-offers.md, owner decisions
// 7 Nov 2026). Only the name is needed to save one; nothing in pricing, pages, the portal or the offers
// reads it. Publishing on the website checks everything and copies it into the live package and offer.
// One copy per package; a published package keeps its own copy until "Publish changes" or "Discard draft".
const schema = new mongoose.Schema({
  // The package ID. A new package reserves its ID here, from its name, until it is published.
  packageId: { type: String, required: true, unique: true, immutable: true },
  name: { type: String, required: true },
  // What the form holds, as typed: { item, offer }. Checked only when it is published.
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  // Raised on every save; a save or publish made from an older copy is refused, so two people never
  // overwrite each other without knowing.
  version: { type: Number, required: true, default: 1 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
}, { timestamps: true, minimize: false });

module.exports = mongoose.models.packageDraft || mongoose.model('packageDraft', schema);
