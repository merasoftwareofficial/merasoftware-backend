const mongoose = require('mongoose');
const { Schema } = mongoose;
const templateSchema = new Schema({
  event: { type: String, required: true, index: true },
  name: { type: String, required: true },
  subject: { type: String, required: true },
  text: { type: String, required: true },
}, { timestamps: true });
const policySchema = new Schema({
  event: { type: String, required: true, unique: true },
  mode: { type: String, enum: ['review', 'off'], default: 'review' },
  defaultTemplate: { type: Schema.Types.ObjectId, default: null },
}, { timestamps: true });
const draftSchema = new Schema({
  event: { type: String, required: true },
  actor: { type: Schema.Types.ObjectId, default: null, index: true },
  application: { type: String, enum: ['website', 'portal'], index: true },
  dedupeKey: { type: String, unique: true, sparse: true },
  reference: { subscriberId: String, tokenHash: String },
  requiredLinks: [String],
  baseSubject: String,
  baseText: String,
  values: { type: Map, of: String },
  source: String,
  to: [String],
  subject: String,
  text: String,
  html: String,
  attachments: [{ _id: false, filename: String, content: String }],
  headers: { type: Map, of: String },
  status: { type: String, enum: ['staged', 'pending', 'sending', 'sent', 'skipped', 'failed'], default: 'staged', index: true },
  providerId: String,
  failure: String,
  sentAt: Date,
  reminderInvoice: Schema.Types.ObjectId,
  // No worker drains drafts. Expired mail can never become sendable again.
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });
// Small permanent audit records; draft content and attachments still expire.
const historySchema = new Schema({
  draftId: { type: Schema.Types.ObjectId, required: true, unique: true },
  application: { type: String, enum: ['website', 'portal'], required: true, index: true },
  event: String, actor: Schema.Types.ObjectId, decidedBy: Schema.Types.ObjectId,
  to: [String], subject: String, status: String, providerId: String, failure: String,
  expiresAt: Date, sentAt: Date,
}, { timestamps: true });
module.exports = {
  EmailTemplate: mongoose.model('EmailTemplate', templateSchema),
  EmailPolicy: mongoose.model('EmailPolicy', policySchema),
  EmailDraft: mongoose.model('EmailDraft', draftSchema),
  EmailHistory: mongoose.model('EmailHistory', historySchema),
};
