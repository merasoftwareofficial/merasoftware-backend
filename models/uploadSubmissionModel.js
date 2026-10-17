const mongoose = require('mongoose');

// Tracks an HTTP submission, not a background job. No file bytes are stored here.
const schema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  scope: { type: String, required: true },
  uploadId: { type: String, required: true },
  fingerprint: { type: String, required: true },
  status: { type: String, enum: ['processing', 'succeeded', 'failed', 'needs_review'], default: 'processing' },
  phase: { type: String, default: 'saving_files' },
  completedFiles: { type: Number, default: 0 },
  totalFiles: { type: Number, required: true },
  attemptToken: { type: String, required: true },
  result: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ ownerId: 1, scope: 1, uploadId: 1 }, { unique: true });
module.exports = mongoose.model('UploadSubmission', schema);
