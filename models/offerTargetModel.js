const mongoose = require('mongoose');
const { CONTACTED, OFFER_STAGES } = require('../helpers/leadStatuses');

// One person in one offer. The offer itself stays on the website; only its slug and title are kept here.
// The stage is this offer's alone: it never changes the lead's own status. Follow-ups stay on the lead (followUps[].offerSlug).
const offerTargetSchema = new mongoose.Schema({
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'lead', required: true, immutable: true },
  offerSlug: { type: String, required: true, immutable: true },
  offerTitle: { type: String, default: '' },
  stage: { type: String, enum: OFFER_STAGES, default: CONTACTED },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  boughtAt: { type: Date, default: null },
  boughtBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
}, { timestamps: true });

offerTargetSchema.index({ leadId: 1, offerSlug: 1 }, { unique: true });
offerTargetSchema.index({ offerSlug: 1, createdAt: -1 });

module.exports = mongoose.model('offerTarget', offerTargetSchema);
