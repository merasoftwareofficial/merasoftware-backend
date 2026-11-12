const mongoose = require('mongoose');
const Run = require('../models/communicationReminderRunModel');
const { EmailDraft } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models');
const { maySendReminder } = require('./communicationReminderEligibility');

// Only retry a known queue-creation failure. Never replay an uncertain provider
// handoff, an existing WhatsApp copy, or the already accepted email.
async function retryQueueFailure(id) {
  if (!mongoose.isValidObjectId(id)) throw new Error('Unknown reminder.');
  const run = await Run.findOne({ _id: id, source: { $in: ['monthly_package', 'broadcast'] }, status: 'partial', 'channelOutcomes.email': 'sent', 'channelOutcomes.whatsapp': 'failed' }).lean();
  if (!run?.emailDraftId) throw new Error('This reminder cannot be retried safely here.');
  const draft = await EmailDraft.findById(run.emailDraftId).lean();
  if (!draft || draft.status !== 'failed' || draft.expiresAt <= new Date() || draft.delivery?.emailStatus !== 'sent' || draft.delivery?.whatsappStatus !== 'failed' || await Queue.exists({ reminderRunId: run._id })) throw new Error('This delivery needs manual review; it cannot be retried safely here.');
  const eligibility = await maySendReminder(run._id);
  if (!eligibility.allowed) throw new Error(eligibility.reason);
  const claimed = await Run.updateOne({ _id: run._id, status: 'partial', 'channelOutcomes.email': 'sent', 'channelOutcomes.whatsapp': 'failed' }, { $set: { status: 'scheduled', reason: 'Retry requested by an admin.' } });
  if (!claimed.modifiedCount) throw Object.assign(new Error('This reminder changed. Refresh and try again.'), { status: 409 });
  return { status: await require('./communicationReminderDispatch').dispatchReminder(run._id) };
}
module.exports = { retryQueueFailure };
