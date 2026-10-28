const mongoose = require("mongoose");

// Attachment for a follow-up (optional). Reuses the same shape/Drive fields as
// proposalSchema below so file handling stays a single pattern across the model.
const followUpAttachmentSchema = new mongoose.Schema({
  name: {
    type: String,
    default: "",
  },
  driveFileId: {
    type: String,
    default: "",
  },
  downloadLink: {
    type: String,
    default: "",
  },
  type: {
    type: String,
    default: "",
  },
  size: {
    type: Number,
    default: 0,
  },
}, { _id: false });

const followUpSchema = new mongoose.Schema({
  note: {
    type: String,
    required: true,
  },
  // Pipeline-stage badge captured on this follow-up (the stage the lead was moved
  // to at this point in time). Same 4 stages as the lead's own status enum, so the
  // follow-up timeline shows how the pipeline progressed over time.
  badge: {
    type: String,
    enum: ["New", "Contacted", "Proposal Sent", "Negative", "Won"],
    default: "New",
  },
  // Optional file attached to this follow-up (uploaded to Google Drive).
  attachment: {
    type: followUpAttachmentSchema,
    default: null,
  },
  date: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const proposalSchema = new mongoose.Schema({
  version: {
    type: Number,
    required: true,
  },
  name: {
    type: String,
    default: "",
  },
  driveFileId: {
    type: String,
    default: "",
  },
  downloadLink: {
    type: String,
    default: "",
  },
  type: {
    type: String,
    default: "",
  },
  size: {
    type: Number,
    default: 0,
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
  },
}, { _id: false });

const leadSchema = new mongoose.Schema({
  // Account identity before conversion; never inferred from an editable email.
  reservationUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    default: "",
    trim: true,
  },
  email: {
    type: String,
    default: "",
    trim: true,
    lowercase: true,
  },
  source: {
    type: String,
    default: "",
    trim: true,
  },
  notes: {
    type: String,
    default: "",
  },
  status: {
    type: String,
    enum: ["New", "Contacted", "Proposal Sent", "Negative", "Won"],
    default: "New",
  },
  // Versioned proposal/quotation files (Phase 6A). Each upload is a new version
  // so the full revision history / timeline is preserved (client changes over time).
  proposals: {
    type: [proposalSchema],
    default: [],
  },
  // Reserved for Phase 2 (follow-up log).
  followUps: {
    type: [followUpSchema],
    default: [],
  },
  // Set only after Phase 4 convert. Null while the record is still a lead.
  convertedToUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null,
  },
  // Existing customer who referred this lead (Source = "Reference" in the Add Lead
  // form, matched against userModel). Tracking only — deliberately separate from
  // userModel.referredBy/referrals, which power the Partner authorization system
  // (partnerCustomers.js / updatePartnerCustomer.js let a "partner" view/edit users
  // they referred). Linking a lead here must never grant that access.
  referredByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null,
  },
  // Set while a live temporary guest account (userModel.isGuest) exists for this
  // lead. Cleared (not the lead itself) once the guest expires or is converted.
  // Deliberately separate from convertedToUserId: that field means "permanently
  // converted, Won" while this one means "a still-alive, possibly-expiring guest."
  guestUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null,
  },
  // Soft-delete (Trash system). null = active/visible as before; a date = in Trash
  // (hidden from lead lists/search), permanently purged 30 days later. Restore
  // clears it back to null. Additive + default null so existing leads are unaffected.
  deletedAt: {
    type: Date,
    default: null,
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
  },
  // Set when an existing portal client sent this lead themselves (Get a Service → Start a
  // Project, controller/lead/customerProjectRequest.js). Such a lead is never converted: the
  // person is already a client. Additive + default null so existing leads are unaffected.
  requestedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null,
  },
}, {
  timestamps: true,
});

leadSchema.index({ reservationUserId: 1 }, { unique: true, partialFilterExpression: { reservationUserId: { $type: 'objectId' } } });
const leadModel = mongoose.model("lead", leadSchema);

module.exports = leadModel;
