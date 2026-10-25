const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  reservationId: { type: mongoose.Schema.Types.ObjectId, required: true },
  version: { type: Number, required: true },
  deadline: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'paused', 'failed', 'sent', 'expired', 'superseded'], default: 'pending' },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date, default: null },
  failure: { type: String, default: '' },
}, { timestamps: true });
schema.index({ reservationId: 1, version: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1 });
module.exports = mongoose.model('reservationNotice', schema);
