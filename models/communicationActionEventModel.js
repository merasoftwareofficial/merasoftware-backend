const mongoose = require('mongoose');
const { Schema } = mongoose;

// One business action that happened (Reminder.md §4): the trigger and stop signal for action rules,
// and the short-lived action log. Written in the same database session as the change it records,
// so an aborted payment or invoice never leaves an event behind. `expiresAt` is set only after the
// worker has handled the event: the TTL index then removes it 24 hours later (owner decision).
const event = new Schema({
  key: { type: String, required: true, unique: true },
  action: { type: String, required: true },
  entityId: { type: Schema.Types.ObjectId, required: true },
  clientId: { type: Schema.Types.ObjectId, default: null },
  orderId: { type: Schema.Types.ObjectId, default: null },
  matchKeys: { type: [String], default: [] },
  details: { type: Schema.Types.Mixed, default: {} },
  occurredAt: { type: Date, required: true },
  status: { type: String, enum: ['new', 'processing', 'done', 'failed'], default: 'new' },
  attempts: { type: Number, default: 0 },
  lockUntil: Date,
  processedAt: Date,
  error: String,
  expiresAt: Date,
}, { timestamps: true });
event.index({ status: 1, occurredAt: 1 });
event.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.CommunicationActionEvent || mongoose.model('CommunicationActionEvent', event);
