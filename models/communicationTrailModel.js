const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Single Source of Truth (SSOT) document for the Automated Message System single-form trail.
 * Stores the exact recursive trail structure losslessly (triggers, package scope, instant
 * messages, reminders, and Stop-Trigger "+" chains). On every save/update/toggle/delete,
 * helpers/communicationTrails.js compiles this document into trailId-linked
 * CommunicationActionRule execution rows for actionRuleWorker.js.
 */
const communicationTrailSchema = new Schema({
  triggers: { type: [String], required: true, default: [] },
  scope: { type: String, enum: ['all', 'monthly', 'onetime', 'include', 'exclude'], default: 'all' },
  selectedPackages: { type: [String], default: [] },
  instant: { type: Schema.Types.Mixed, default: () => ({ audience: 'off', client: { channel: 'whatsapp', subject: '', text: '' }, admin: { channel: 'whatsapp', subject: '', text: '' } }) },
  reminders: { type: [Schema.Types.Mixed], default: [] },
  control: { type: String, enum: ['auto', 'review', 'off'], default: 'auto' },
  enabled: { type: Boolean, default: true },
  activatedAt: { type: Date, default: null },
  revision: { type: Number, default: 1, min: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'user', required: true },
}, { timestamps: true });

communicationTrailSchema.index({ enabled: 1, updatedAt: -1 });
communicationTrailSchema.index({ triggers: 1 });

module.exports = mongoose.models.CommunicationTrail || mongoose.model('CommunicationTrail', communicationTrailSchema);
