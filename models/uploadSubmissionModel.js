const mongoose = require('mongoose');

// Receipt identity and optional durable delivery job. File bytes live in StagedUploadFile.
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
  mode: { type: String, enum: ['request', 'staged'], default: 'request' },
  orderId: mongoose.Schema.Types.ObjectId,
  instructions: mongoose.Schema.Types.Mixed,
  manifest: [{ _id: false, id: String, name: String, type: { type: String }, size: Number, sha256: String, received: { type: Boolean, default: false } }],
  reservationId: String,
  reservedBytes: { type: Number, default: 0 },
  expiresAt: Date,
  requestId: mongoose.Schema.Types.ObjectId,
  delivery: { type: String, enum: ['queued', 'running', 'complete', 'needs_review', 'cleaning', 'cancelled'] },
  workerToken: String,
  leaseUntil: Date,
  nextAttemptAt: Date,
  attempts: { type: Number, default: 0 },
  deliveryFailure: String,
}, { timestamps: true });
schema.index({ ownerId: 1, scope: 1, uploadId: 1 }, { unique: true });
schema.index({ mode: 1, delivery: 1, nextAttemptAt: 1, leaseUntil: 1 });
schema.index({ mode: 1, status: 1, expiresAt: 1 });
module.exports = mongoose.model('UploadSubmission', schema);
