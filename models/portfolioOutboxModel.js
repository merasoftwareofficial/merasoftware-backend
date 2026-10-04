const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: String,
  hash: String,
  source: mongoose.Schema.Types.Mixed,
  revision: Number,
  lastSeen: String,
  pending: { type: Boolean, default: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lastError: { type: String, default: '' },
  deliveredAt: Date,
}, { timestamps: true });
schema.index({ pending: 1, nextAttemptAt: 1 });
module.exports = mongoose.models.PortfolioOutbox || mongoose.model('PortfolioOutbox', schema);
