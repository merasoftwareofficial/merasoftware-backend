const mongoose = require('mongoose');

// Immutable commercial history of a project price change. The order keeps the current
// agreement; each revision keeps exactly what it replaced, so issued amounts stay traceable.
const snapshot = { type: mongoose.Schema.Types.Mixed, required: true, immutable: true };
const schema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'order', required: true, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, immutable: true },
  reservationId: { type: mongoose.Schema.Types.ObjectId, ref: 'offerReservation', required: true, immutable: true },
  revision: { type: Number, required: true, immutable: true },
  reason: { type: String, enum: ['reservation_expired', 'force_apply'], required: true, immutable: true },
  source: { type: String, enum: ['offer_extended', 'normal_price', 'reserved_terms'], required: true, immutable: true },
  // { finalPrice, agreement, installments, invoice: { id, amount, lineItems } }
  before: snapshot,
  after: snapshot,
  offerQuoteKey: { type: String, default: null, immutable: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null, immutable: true },
  note: { type: String, default: '', immutable: true },
}, { timestamps: true });
schema.index({ orderId: 1, revision: 1 }, { unique: true });
module.exports = mongoose.model('projectPricingRevision', schema);
