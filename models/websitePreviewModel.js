const mongoose = require('mongoose');
const { Schema } = mongoose;
const previewSchema = new Schema({
  _id: { type: Schema.Types.ObjectId, ref: 'orderProduct' },
  host: { type: String, default: undefined, unique: true, sparse: true },
  visible: { type: Boolean, default: false }, revision: { type: Number, default: 0 },
  currentVersion: { type: String, default: null }, previousVersion: { type: String, default: null },
}, { timestamps: true });
const fileSchema = new Schema({ path: String, key: String, size: Number, contentType: String }, { _id: false });
const versionSchema = new Schema({
  _id: String, projectId: { type: Schema.Types.ObjectId, index: true }, adminId: Schema.Types.ObjectId,
  requestId: String, manifest: [fileSchema], manifestHash: String, totalBytes: Number,
  state: { type: String, enum: ['uploading', 'verifying', 'ready', 'failed', 'abandoned', 'deleting', 'deleted'], default: 'uploading', index: true },
  expectedVersion: { type: String, default: null }, expiresAt: Date, latestTokenExpiry: Date,
  leaseId: String, leaseUntil: Date, error: String, readyAt: Date, cleanupId: String,
}, { timestamps: true });
versionSchema.index({ projectId: 1, requestId: 1 }, { unique: true });
const receiptSchema = new Schema({ _id: String, expiresAt: { type: Date, expires: 0 } });
module.exports = {
  Preview: mongoose.models.WebsitePreview || mongoose.model('WebsitePreview', previewSchema),
  Version: mongoose.models.WebsitePreviewVersion || mongoose.model('WebsitePreviewVersion', versionSchema),
  Receipt: mongoose.models.WebsitePreviewReceipt || mongoose.model('WebsitePreviewReceipt', receiptSchema),
};
