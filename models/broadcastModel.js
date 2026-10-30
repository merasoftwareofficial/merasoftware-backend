const mongoose = require('mongoose');
const { Schema } = mongoose;
const broadcastSchema = new Schema({
  createdBy: { type: Schema.Types.ObjectId, required: true },
  requestKey: { type: String, required: true }, fingerprint: { type: String, required: true },
  audience: { type: String, required: true }, message: { type: String, required: true },
  templateId: Schema.Types.ObjectId, origin: { type: String, enum: ['new', 'template'], required: true },
  state: { type: String, enum: ['preparing', 'ready', 'finished'], default: 'preparing' },
  total: { type: Number, default: 0 }, finishedAt: Date, acceptanceCompletedAt: Date,
}, { timestamps: true });
broadcastSchema.index({ createdBy: 1, requestKey: 1 }, { unique: true });
const recipientSchema = new Schema({
  broadcastId: { type: Schema.Types.ObjectId, required: true },
  leadId: { type: Schema.Types.ObjectId, required: true }, phone: { type: String, required: true },
  state: { type: String, enum: ['waiting', 'releasing', 'pending', 'sending', 'sent', 'failed', 'skipped', 'expired', 'cancelled'], default: 'waiting' },
  reason: String, queueText: String, queuedAt: Date, sentAt: Date,
}, { timestamps: true });
recipientSchema.index({ broadcastId: 1, phone: 1 }, { unique: true });
recipientSchema.index({ state: 1, createdAt: 1 });
// Persistent release slot prevents separate dispatchers from feeding different recipients.
const gateSchema = new Schema({ _id: String, recipientId: Schema.Types.ObjectId }, { versionKey: false });
module.exports = {
  Broadcast: mongoose.model('Broadcast', broadcastSchema),
  BroadcastRecipient: mongoose.model('BroadcastRecipient', recipientSchema),
  BroadcastGate: mongoose.model('BroadcastGate', gateSchema),
};
