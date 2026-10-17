const mongoose = require('mongoose');
module.exports = mongoose.model('UploadStorageBudget', new mongoose.Schema({
  _id: String,
  usedBytes: { type: Number, default: 0 },
}));
