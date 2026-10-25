const mongoose = require('mongoose');
// An admin must consume the exact state they reviewed, once and before expiry.
const schema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, required: true },
  reservationId: { type: mongoose.Schema.Types.ObjectId, required: true },
  stateHash: { type: String, required: true },
  usedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });
module.exports = mongoose.model('reservationActionPreview', schema);
