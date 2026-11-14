const mongoose = require('mongoose');
const { Schema } = mongoose;

// Durable identity and frozen content for one reminder step of one business
// occurrence. Dispatch is intentionally not wired until eligibility is checked
// at both the email provider and WhatsApp handoff.
const run = new Schema({
  ruleId: { type: Schema.Types.ObjectId, ref: 'CommunicationReminderRule', required: true },
  ruleRevision: { type: Number, required: true },
  source: { type: String, enum: ['monthly_package', 'broadcast', 'action'], required: true },
  // Action rules only (helpers/actionRuleWorker.js): the starting action, the actions that stop
  // this run, and the records it belongs to (a stop matches on any shared key).
  action: String,
  stopOn: { type: [String], default: undefined },
  matchKeys: { type: [String], default: undefined },
  occurrenceKey: { type: String, required: true },
  step: { type: Number, required: true, min: 0 },
  entityId: { type: Schema.Types.ObjectId, required: true },
  clientId: { type: Schema.Types.ObjectId, required: true },
  cycle: { type: Number, min: 2 },
  anchorAt: Date,
  expectedAmount: Number,
  dueAt: { type: Date, required: true },
  subject: { type: String, required: true },
  text: { type: String, required: true },
  channel: { type: String, enum: ['whatsapp', 'email', 'both'], required: true },
  status: { type: String, enum: ['scheduled', 'preparing', 'queued', 'sent', 'partial', 'cancelled', 'skipped', 'expired', 'failed', 'unknown'], default: 'scheduled' },
  channelOutcomes: { type: Schema.Types.Mixed, default: undefined },
  sentAt: Date,
  reason: { type: String, default: '' },
  emailDraftId: Schema.Types.ObjectId,
  lockUntil: Date,
  lockOwner: String,
  workerLeaseOwner: String,
}, { timestamps: true });
run.index({ ruleId: 1, ruleRevision: 1, occurrenceKey: 1, step: 1 }, { unique: true });
run.index({ status: 1, dueAt: 1 });
run.index({ source: 1, status: 1, matchKeys: 1 });
module.exports = mongoose.models.CommunicationReminderRun || mongoose.model('CommunicationReminderRun', run);
