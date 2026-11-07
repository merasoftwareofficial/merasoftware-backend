const mongoose = require('mongoose');

// "Start my project" on a package without a running offer (merasoftware/src/docs/package-offers.md,
// owner decisions 7 Nov 2026). No price is held and nothing expires: the team sets up the project.
// One open request per person and package; a closed one stays as history.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, immutable: true },
  packageId: { type: String, required: true, immutable: true },
  // The package as the customer saw it when asking (name and price); the project uses the live package.
  packageSnapshot: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  requestedAt: { type: Date, required: true, immutable: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'lead', default: null },
  // Messages: sent once (noticesAt), retried after a failure; the team is reminded once a day, at most 3 times.
  noticesAt: { type: Date, default: null },
  noticeNextAttemptAt: { type: Date, default: null },
  noticeFailure: { type: String, default: '' },
  alerts: { type: Number, default: 0 },
  // Closed when the team creates a project on this package for this person, or closes it by hand.
  closedAt: { type: Date, default: null },
  closedReason: { type: String, enum: ['project_created', 'closed_by_team', null], default: null },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'order', default: null },
}, { timestamps: true });
schema.index({ userId: 1, packageId: 1 }, { unique: true, partialFilterExpression: { closedAt: null } });
schema.index({ closedAt: 1, requestedAt: 1 });

module.exports = mongoose.models.packageStartRequest || mongoose.model('packageStartRequest', schema);
