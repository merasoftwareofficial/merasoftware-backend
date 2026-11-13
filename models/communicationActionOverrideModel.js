const mongoose = require('mongoose');
const { Schema } = mongoose;

// Changes made on Communication > Actions. The action list itself lives in helpers/communicationActionCatalog.js;
// a row here only overrides what the owner changed (surface, category, archived, deleted) for one action id.
const override = new Schema({
  actionId: { type: String, required: true, unique: true, maxlength: 10 },
  surface: { type: String, enum: ['Admin', 'Client', 'Website', 'System'] },
  category: { type: String, maxlength: 60 },
  archived: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'user' },
}, { timestamps: true });

module.exports = mongoose.models.CommunicationActionOverride || mongoose.model('CommunicationActionOverride', override);
