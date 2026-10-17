const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  submissionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  fileId: { type: String, required: true },
  payload: { type: Buffer, required: true, select: false },
  driveFileId: String,
  driveResult: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ submissionId: 1, fileId: 1 }, { unique: true });
module.exports = mongoose.model('StagedUploadFile', schema);
