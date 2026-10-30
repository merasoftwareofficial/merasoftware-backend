const mongoose = require('mongoose');
const { Schema } = mongoose;
const templateSchema = new Schema({
  event: { type: String, required: true, index: true },
  name: { type: String, required: true },
  subject: { type: String, required: true },
  text: { type: String, required: true },
  // The editable copy of an action's built-in wording (helpers/emailTemplates.js). One per
  // action; it can be reset to the original but never removed.
  system: { type: Boolean, default: false },
}, { timestamps: true });
templateSchema.index({ event: 1, system: 1 }, { unique: true, partialFilterExpression: { system: true } });
const policySchema = new Schema({
  event: { type: String, required: true, unique: true },
  // review/off for actions an admin performs; auto/off for customer-started mail (emailCatalog.js).
  mode: { type: String, enum: ['review', 'auto', 'off'], default: 'review' },
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
  // Sections the action built itself (refund tables); templates place them by {{key}}.
  blocks: { type: Map, of: new Schema({ html: String, text: String }, { _id: false }) },
  source: String,
  to: [String],
  subject: String,
  // `text` is the reviewable template text; `plain` is the plain-text part that is sent.
  text: String,
  plain: String,
  html: String,
  attachments: [{ _id: false, filename: String, content: String }],
  headers: { type: Map, of: String },
  status: { type: String, enum: ['staged', 'pending', 'sending', 'sent', 'queued', 'skipped', 'failed'], default: 'staged', index: true },
  providerId: String,
  failure: String,
  sentAt: Date,
  sender: String,
  templateName: String,
  sourceTemplateId: Schema.Types.ObjectId,
  whatsappTo: String,
  delivery: {
    channels: { type: [String], default: undefined },
    subject: String, text: String,
    recipients: [{ _id: false, email: String, phone: String }],
    emailStatus: String, whatsappStatus: String, failure: String,
    lockOwner: String, lockUntil: Date, lockedAt: Date,
  },
  attemptCount: { type: Number, default: 0 },
  lastAttemptAt: Date,
  attempts: [{ _id: false, at: Date, status: String, failure: String }],
  reminderInvoice: Schema.Types.ObjectId,
  // No worker drains drafts. Expired mail can never become sendable again.
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });
// Small permanent audit records; draft content and attachments still expire.
const historySchema = new Schema({
  dedupeKey: { type: String, unique: true, sparse: true },
  draftId: { type: Schema.Types.ObjectId, required: true, unique: true },
  application: { type: String, enum: ['website', 'portal'], required: true, index: true },
  event: String, actor: Schema.Types.ObjectId, decidedBy: Schema.Types.ObjectId,
  to: [String], subject: String, status: String, providerId: String, failure: String,
  expiresAt: Date, sentAt: Date,
  source: String, sender: String, templateName: String,
  delivery: Schema.Types.Mixed,
  attemptCount: { type: Number, default: 0 }, lastAttemptAt: Date,
  attempts: [{ _id: false, at: Date, status: String, failure: String }],
}, { timestamps: true });
historySchema.index({ application: 1, status: 1, sentAt: -1 });
historySchema.index({ application: 1, status: 1, lastAttemptAt: -1 });
module.exports = {
  EmailTemplate: mongoose.model('EmailTemplate', templateSchema),
  EmailPolicy: mongoose.model('EmailPolicy', policySchema),
  EmailDraft: mongoose.model('EmailDraft', draftSchema),
  EmailHistory: mongoose.model('EmailHistory', historySchema),
};
