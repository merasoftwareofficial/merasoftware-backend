const mongoose = require('mongoose');
const { Schema } = mongoose;

const step = new Schema({
  timingRef: { type: String, enum: ['after_action', 'before_due', 'on_due', 'after_due'], default: 'after_action' },
  unit: { type: String, enum: ['days', 'hours'], default: 'days' },
  days: { type: Number, min: 0, max: 365, default: 0 },
  hours: { type: Number, min: 0, max: 720, default: 0 },
  afterDays: { type: Number, min: 0, max: 365, default: 0 },
  channel: { type: String, enum: ['whatsapp', 'email', 'both'], required: true },
  subject: { type: String, default: '' },
  text: { type: String, required: true },
}, { _id: false });

const doAlsoStep = new Schema({
  type: { type: String, enum: ['change_lead_stage', 'add_lead_note', 'stop_reminders'], required: true },
  stage: { type: String, default: '' },
  note: { type: String, default: '' },
}, { _id: false });

// "When action X happens, send these steps (and repeats) until a stop action happens" (Reminder.md §4).
// Saving a change raises `revision`; runs already scheduled keep the text they were planned with.
const rule = new Schema({
  name: { type: String, required: true, maxlength: 200 },
  kind: { type: String, enum: ['template', 'reminder'], default: 'reminder' },
  action: { type: String, required: true },
  actionId: { type: String, default: '' },
  audience: { type: String, enum: ['customer', 'admin'], default: 'customer' },
  condition: { type: String, enum: ['anytime', 'unpaid', 'paid'], default: 'anytime' },
  scope: {
    kind: { type: String, enum: ['all', 'monthly', 'one_time', 'package', 'offer_payment'], default: 'all' },
    packageSlug: { type: String, default: '' },
  },
  steps: { type: [step], default: [] },
  repeat: { everyDays: { type: Number, min: 1, max: 90 }, times: { type: Number, min: 0, max: 60, default: 0 }, perDay: { type: Number, min: 1, max: 4, default: 1 } },
  stopOn: { type: [String], default: [] },
  doAlso: { type: [doAlsoStep], default: [] },
  control: { type: String, enum: ['auto', 'review', 'off'], default: 'off' },
  enabled: { type: Boolean, default: false },
  activatedAt: Date,
  origin: { type: String, enum: ['new', 'migrated', 'migrated_edited'], default: 'new' },
  migratedFrom: { type: String, default: '' },
  pairId: { type: String, default: '' },
  revision: { type: Number, default: 1, min: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'user', required: true },
}, { timestamps: true });
rule.index({ action: 1, enabled: 1 });
module.exports = mongoose.models.CommunicationActionRule || mongoose.model('CommunicationActionRule', rule);
