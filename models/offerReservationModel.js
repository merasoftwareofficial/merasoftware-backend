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
  releases: [{ _id: false, projectId: mongoose.Schema.Types.ObjectId, actorId: mongoose.Schema.Types.ObjectId,
    at: Date, reason: String, resolution: mongoose.Schema.Types.Mixed }],
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
  // not-sent: the action's "Send via" can't reach this person (e.g. no phone); never retried.
  confirmationStatus: { type: String, enum: ['pending', 'sent', 'paused', 'failed', 'expired', 'not-sent'], default: 'pending' },
  confirmationNextAttemptAt: { type: Date, default: Date.now },
  confirmationLockedUntil: { type: Date, default: null },
  confirmationFailure: { type: String, default: '' },
  pricingNextCheckAt: { type: Date, default: () => new Date(0) },
  pricingLockedUntil: { type: Date, default: null },
  // The closing message (helpers/reservationClosure.js). Only reservations made after it shipped get
  // 'pending'; older rows have no value and are never messaged. Decided once after the deadline:
  // used (a project is attached), late (deadline over 24 h ago), sent, or not-sent (its route can't reach them).
  closureStatus: { type: String, enum: ['pending', 'used', 'late', 'sent', 'not-sent', 'failed'] },
  closureDecidedAt: { type: Date, default: null },
  closureNextAttemptAt: { type: Date, default: null },
  closureLockedUntil: { type: Date, default: null },
  closureFailure: { type: String, default: '' },
  // Reminders before the deadline (helpers/reservationReminders.js): 24 hours and 1 hour left. Only
  // reservations made after they shipped get remindersEnabled. Each sent one is kept as "<stage>:<deadline ISO>",
  // so an extension (a new deadline) gets its own reminders and one deadline never gets the same one twice.
  remindersEnabled: { type: Boolean, default: false },
  remindersSent: { type: [String], default: [] },
  // "Start my project" (helpers/reservationStart.js). While startRequestedAt is set and no project is
  // attached, the clock is paused: no reminder, no closing message, and the deadline is not in force.
  // pausedRemainingMs is the time that was left. A project created on it, or the admin's "Extend deadline",
  // resumes the clock and clears the pause. Every request stays in startRequests as history.
  startRequestedAt: { type: Date, default: null },
  pausedRemainingMs: { type: Number, default: 0 },
  startRequests: [{ _id: false, at: Date, remainingMs: Number,
    noticesAt: { type: Date, default: null }, noticeNextAttemptAt: { type: Date, default: null }, noticeFailure: { type: String, default: '' },
    alerts: { type: Number, default: 0 }, endedAt: { type: Date, default: null }, ended: { type: String, enum: ['project', 'resumed', null], default: null } }],
}, { timestamps: true });
schema.index({ userId: 1, offerSlug: 1, periodEndsAt: 1 }, { unique: true });
schema.index({ confirmationStatus: 1, confirmationNextAttemptAt: 1 });
schema.index({ projectId: 1, confirmedAt: 1, 'resolution.status': 1 });
schema.index({ pricingNextCheckAt: 1, expiresAt: 1, _id: 1 });
schema.index({ closureStatus: 1, closureNextAttemptAt: 1 }, { partialFilterExpression: { closureStatus: { $in: ['pending', 'failed'] } } });
schema.index({ startRequestedAt: 1 }, { partialFilterExpression: { startRequestedAt: { $type: 'date' } } });
module.exports = mongoose.model('offerReservation', schema);
