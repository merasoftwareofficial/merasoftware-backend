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
  // Instant message supports Multiple Templates on client/admin (`templates: [{ id (24-hex ObjectId), name, channel, subject, text, isDefault }]`)
  // while keeping top-level channel/subject/text synced to the default template for backward compatibility.
  instant: {
    type: Schema.Types.Mixed,
    default: () => ({
      audience: 'off',
      client: { channel: 'whatsapp', subject: '', text: '', templates: [] },
      admin: { channel: 'whatsapp', subject: '', text: '', templates: [] },
    }),
  },
  reminders: { type: [Schema.Types.Mixed], default: [] },
  stages: { type: [Schema.Types.Mixed], default: [] },
  // Applies to Instant Auto Msg (`auto` vs `review`); scheduled Reminders always run `auto` while trail is enabled.
  control: { type: String, enum: ['auto', 'review', 'off'], default: 'auto' },
  // Separate action-actor controls on the same trigger point (reuses existing SSOT originSurface + originFilter).
  adminActionControl: { type: String, enum: ['auto', 'review', 'off'], default: null },
  userActionControl: { type: String, enum: ['auto', 'review', 'off'], default: null },
  enabled: { type: Boolean, default: true },
  activatedAt: { type: Date, default: null },
  revision: { type: Number, default: 1, min: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'user', required: true },
}, { timestamps: true, minimize: false });

communicationTrailSchema.index({ enabled: 1, updatedAt: -1 });
communicationTrailSchema.index({ triggers: 1 });

module.exports = mongoose.models.CommunicationTrail || mongoose.model('CommunicationTrail', communicationTrailSchema);
