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
  actor: { type: Schema.Types.ObjectId, required: true, index: true },
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
module.exports = {
  EmailTemplate: mongoose.model('EmailTemplate', templateSchema),
  EmailPolicy: mongoose.model('EmailPolicy', policySchema),
  EmailDraft: mongoose.model('EmailDraft', draftSchema),
};
