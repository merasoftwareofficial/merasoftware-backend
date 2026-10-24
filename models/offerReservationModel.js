const mongoose = require('mongoose');

// History is permanent. Expiry is a read-time state, never a TTL deletion.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, immutable: true },
  offerSlug: { type: String, required: true, immutable: true },
  offerSnapshot: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  regularPrice: { type: Number, required: true, immutable: true },
  reservedPrice: { type: Number, required: true, immutable: true },
  reservedAt: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  origin: { type: String, enum: ['customer', 'admin_project'], required: true, immutable: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'lead', default: null },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'order', default: null },
  confirmedAt: { type: Date, default: null },
  confirmationStatus: { type: String, enum: ['pending', 'sent', 'paused', 'failed', 'expired'], default: 'pending' },
  confirmationNextAttemptAt: { type: Date, default: Date.now },
  confirmationLockedUntil: { type: Date, default: null },
  confirmationFailure: { type: String, default: '' },
}, { timestamps: true });
schema.index({ userId: 1, offerSlug: 1 }, { unique: true });
schema.index({ confirmationStatus: 1, confirmationNextAttemptAt: 1 });
module.exports = mongoose.model('offerReservation', schema);
