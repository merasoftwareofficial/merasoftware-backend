const mongoose = require('mongoose');
const { Schema } = mongoose;

const step = new Schema({
  afterDays: { type: Number, required: true, min: 0, max: 365 },
  channel: { type: String, enum: ['whatsapp', 'email', 'both'], required: true },
  subject: { type: String, default: '' },
  text: { type: String, required: true },
}, { _id: false });

// "When action X happens, send these steps (and repeats) until a stop action happens" (Reminder.md §4).
// Saving a change raises `revision`; runs already scheduled keep the text they were planned with.
const rule = new Schema({
  name: { type: String, required: true, maxlength: 200 },
  action: { type: String, required: true },
  audience: { type: String, enum: ['customer'], default: 'customer' },
  steps: { type: [step], default: [] },
  repeat: { everyDays: { type: Number, min: 1, max: 90 }, times: { type: Number, min: 0, max: 10, default: 0 } },
  stopOn: { type: [String], default: [] },
  control: { type: String, enum: ['auto', 'off'], default: 'off' },
  enabled: { type: Boolean, default: false },
  activatedAt: Date,
  revision: { type: Number, default: 1, min: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'user', required: true },
}, { timestamps: true });
rule.index({ action: 1, enabled: 1 });
module.exports = mongoose.models.CommunicationActionRule || mongoose.model('CommunicationActionRule', rule);
