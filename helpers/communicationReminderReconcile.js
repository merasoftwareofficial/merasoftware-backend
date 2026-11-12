const Run = require('../models/communicationReminderRunModel');
const { EmailHistory } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');

const FINAL = ['sent', 'failed', 'cancelled', 'skipped', 'expired', 'partial'];
async function reconcileReminderRun(id) {
  const run = await Run.findOne({ _id: id, status: { $in: ['queued', 'unknown'] } }).lean();
  if (!run?.emailDraftId) return null;
  const [history, copies] = await Promise.all([
    EmailHistory.findOne({ draftId: run.emailDraftId }).select('delivery sentAt').lean(),
    Queue.find({ reminderRunId: run._id }).select('status sentAt').lean(),
  ]);
  const delivery = history?.delivery;
  if (!delivery?.channels?.length) {
    // Rotate unresolved rows to the back so one missing history cannot starve
    // other runs in a bounded reconciliation batch.
    await Run.updateOne({ _id: run._id, status: { $in: ['queued', 'unknown'] } }, { $currentDate: { updatedAt: true } }, { timestamps: false });
    return null;
  }
  const channels = delivery.channels;
  const email = channels.includes('email') ? delivery.emailStatus || 'unknown' : 'not-selected';
  let whatsapp = 'not-selected';
  if (channels.includes('whatsapp')) {
    if (copies.some(row => ['pending', 'sending'].includes(row.status))) whatsapp = 'queued';
    else if (copies.length && copies.every(row => row.status === 'sent')) whatsapp = 'sent';
    else if (copies.some(row => row.status === 'sent')) whatsapp = 'partial';
    else if (copies.some(row => row.status === 'failed')) whatsapp = 'failed';
    else if (copies.some(row => row.status === 'cancelled')) whatsapp = 'cancelled';
    else if (copies.some(row => row.status === 'expired')) whatsapp = 'expired';
    else if (copies.length) whatsapp = 'skipped';
    else whatsapp = FINAL.includes(run.channelOutcomes?.whatsapp) ? run.channelOutcomes.whatsapp : 'unknown';
  }
  const selected = [email, whatsapp].filter(value => value !== 'not-selected');
  let status = 'unknown';
  if (selected.some(value => ['pending', 'sending', 'queued'].includes(value))) status = 'queued';
  else if (selected.every(value => value === 'sent')) status = 'sent';
  else if (selected.includes('unknown')) status = 'unknown';
  else if (selected.includes('sent') || selected.includes('partial')) status = 'partial';
  else if (selected.includes('failed')) status = 'failed';
  else if (selected.includes('cancelled')) status = 'cancelled';
  else if (selected.includes('expired')) status = 'expired';
  else status = 'skipped';
  const channelOutcomes = { email, whatsapp };
  const times = [history?.sentAt, ...copies.map(copy => copy.sentAt)].filter(value => value && Number.isFinite(+new Date(value)));
  const completeTimes = (!channels.includes('email') || history?.sentAt) && (!channels.includes('whatsapp') || (copies.length && copies.every(copy => copy.status === 'sent' && copy.sentAt)));
  await Run.updateOne({ _id: run._id, status: { $in: ['queued', 'unknown'] } }, { $set: { status, channelOutcomes, ...(status === 'sent' && completeTimes && times.length ? { sentAt: new Date(Math.max(...times.map(value => +new Date(value)))) } : {}) } });
  return { status, channelOutcomes };
}
async function reconcilePendingReminders(limit = 100) {
  const rows = await Run.find({ status: { $in: ['queued', 'unknown'] }, emailDraftId: { $exists: true } }).sort({ updatedAt: 1, _id: 1 }).limit(Math.max(1, Math.min(500, limit))).select('_id').lean();
  for (const row of rows) await reconcileReminderRun(row._id);
  return rows.length;
}
module.exports = { reconcileReminderRun, reconcilePendingReminders };
