const mongoose = require('mongoose');

// History is permanent. Expiry is a read-time state, never a TTL deletion.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, immutable: true },
  offerSlug: { type: String, required: true, immutable: true },
  // The offer's public end at reservation time. A later extension of the same offer is a new
  // period, which permits one new reservation (owner decision 11, 24 Oct 2026).
  periodEndsAt: { type: Date, required: true, immutable: true },
  offerSnapshot: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  regularPrice: { type: Number, required: true, immutable: true },
  reservedPrice: { type: Number, required: true, immutable: true },
  reservedAt: { type: Date, required: true, immutable: true },
  // Original 72-hour deadline. An admin extension sets extendedUntil; this stays as history.
  expiresAt: { type: Date, required: true, immutable: true },
  extendedUntil: { type: Date, default: null },
  extensions: [{ _id: false, from: Date, to: Date, reason: String, actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'user' }, at: Date }],
  origin: { type: String, enum: ['customer', 'admin_project'], required: true, immutable: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'lead', default: null },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'order', default: null },
  confirmedAt: { type: Date, default: null },
  // What happened to the linked project after an unpaid deadline, set once by the shared operation.
  resolution: {
    type: new mongoose.Schema({
      status: { type: String, enum: ['repriced', 'unchanged', 'needs_review', 'force_applied'] },
      source: { type: String, enum: ['offer_extended', 'normal_price', 'reserved_terms', null] },
      revisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'projectPricingRevision', default: null },
      note: String,
      walletCredit: { type: Number, default: 0 },
      at: Date,
      // Set when the first bill is settled or the project closes: automation stops checking it.
      closedAt: { type: Date, default: null },
    }, { _id: false }),
    default: null,
  },
  confirmationStatus: { type: String, enum: ['pending', 'sent', 'paused', 'failed', 'expired'], default: 'pending' },
  confirmationNextAttemptAt: { type: Date, default: Date.now },
  confirmationLockedUntil: { type: Date, default: null },
  confirmationFailure: { type: String, default: '' },
  pricingNextCheckAt: { type: Date, default: () => new Date(0) },
  pricingLockedUntil: { type: Date, default: null },
}, { timestamps: true });
schema.index({ userId: 1, offerSlug: 1, periodEndsAt: 1 }, { unique: true });
schema.index({ confirmationStatus: 1, confirmationNextAttemptAt: 1 });
schema.index({ projectId: 1, confirmedAt: 1, 'resolution.status': 1 });
schema.index({ pricingNextCheckAt: 1, expiresAt: 1, _id: 1 });
module.exports = mongoose.model('offerReservation', schema);
