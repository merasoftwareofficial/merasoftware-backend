const mongoose = require('mongoose');
const { Schema } = mongoose;

const step = new Schema({
  offsetDays: { type: Number, required: true },
  subject: { type: String, required: true },
  text: { type: String, required: true },
  channel: { type: String, enum: ['whatsapp', 'email', 'both'], required: true },
}, { _id: false });

// Rules are disabled on creation; activation is explicit and prospective.
const rule = new Schema({
  name: { type: String, required: true, maxlength: 100 },
  source: { type: String, enum: ['monthly_package', 'broadcast'], required: true },
  enabled: { type: Boolean, default: false },
  revision: { type: Number, default: 1, min: 1 },
  activatedAt: Date,
  workerLeaseOwner: String,
  workerLeaseUntil: Date,
  broadcastScanCursor: Schema.Types.ObjectId,
  steps: { type: [step], default: [] },
  createdBy: { type: Schema.Types.ObjectId, ref: 'user', required: true },
}, { timestamps: true });
rule.index({ source: 1, enabled: 1 });
// Until audience targeting exists, two enabled rules for the same source would
// schedule the same people twice. Disabled drafts remain unrestricted.
rule.index({ source: 1 }, { unique: true, partialFilterExpression: { enabled: true } });
module.exports = mongoose.models.CommunicationReminderRule || mongoose.model('CommunicationReminderRule', rule);
