const mongoose = require('mongoose');

const messageTemplateSchema = new mongoose.Schema({
  purpose: { type: String, enum: ['legacy', 'broadcast'], default: 'legacy' },
  lastUsedAt: Date,
  communicationMigratedAt: Date,
  communicationTemplateId: mongoose.Schema.Types.ObjectId,
  sourceBroadcastId: mongoose.Schema.Types.ObjectId,
  name: {
    type: String,
    required: true,
    trim: true,
  },
  message: {
    type: String,
    required: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
  },
}, {
  timestamps: true,
});

messageTemplateSchema.index({ sourceBroadcastId: 1 }, { unique: true, partialFilterExpression: { sourceBroadcastId: { $type: 'objectId' } } });
const messageTemplateModel = mongoose.model("messageTemplate", messageTemplateSchema);
module.exports = messageTemplateModel;
