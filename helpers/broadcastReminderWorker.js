const { randomUUID } = require('node:crypto');
const Rule = require('../models/communicationReminderRuleModel');
const Run = require('../models/communicationReminderRunModel');
const { Broadcast } = require('../models/broadcastModel');
const { planBroadcastReminders } = require('./broadcastReminderSchedule');
const { dispatchReminder } = require('./communicationReminderDispatch');

async function processBroadcastRule(ruleId, now = new Date()) {
  const owner = randomUUID(), leaseMs = 120000;
  const rule = await Rule.findOneAndUpdate({ _id: ruleId, enabled: true, source: 'broadcast',
    $or: [{ workerLeaseUntil: null }, { workerLeaseUntil: { $lte: new Date() } }] },
  { $set: { workerLeaseOwner: owner, workerLeaseUntil: new Date(Date.now() + leaseMs) } }, { new: true }).lean();
  if (!rule) return { claimed: false };
  const owns = () => Rule.exists({ _id: rule._id, enabled: true, revision: rule.revision, workerLeaseOwner: owner, workerLeaseUntil: { $gt: new Date() } });
  const renew = setInterval(() => Rule.updateOne({ _id: rule._id, enabled: true, revision: rule.revision, workerLeaseOwner: owner }, { $set: { workerLeaseUntil: new Date(Date.now() + leaseMs) } }).catch(error => console.error('[broadcast reminders] lease:', error.message)), 30000);
  renew.unref?.();
  let planned = 0, dispatched = 0;
  try {
    // Rotate bounded batches. An earlier broadcast that finishes preparing
    // later is picked up on the next pass, without starving newer broadcasts.
    const broadcasts = await Broadcast.find({ state: { $in: ['ready', 'finished'] }, createdAt: { $gte: rule.activatedAt }, acceptanceCompletedAt: { $gte: rule.activatedAt },
      ...(rule.broadcastScanCursor ? { _id: { $gt: rule.broadcastScanCursor } } : {}) }).sort({ _id: 1 }).limit(20).select('_id').lean();
    for (const broadcast of broadcasts) {
      if (!await owns()) break;
      planned += await planBroadcastReminders(rule, broadcast._id);
      await Rule.updateOne({ _id: rule._id, workerLeaseOwner: owner, enabled: true, revision: rule.revision }, { $set: { broadcastScanCursor: broadcast._id } });
    }
    if (!broadcasts.length) await Rule.updateOne({ _id: rule._id, workerLeaseOwner: owner, enabled: true, revision: rule.revision }, { $unset: { broadcastScanCursor: 1 } });
    if (!await owns()) return { claimed: true, leaseLost: true, planned, dispatched };
    const due = await Run.aggregate([
      { $match: { ruleId: rule._id, ruleRevision: rule.revision, dueAt: { $lte: now }, $or: [{ status: 'scheduled' }, { status: 'preparing', lockUntil: { $lte: new Date() } }] } },
      { $sort: { occurrenceKey: 1, dueAt: -1, step: -1 } },
      { $group: { _id: '$occurrenceKey', latest: { $first: '$$ROOT' } } },
      { $sort: { 'latest.dueAt': 1 } }, { $limit: 100 },
    ]);
    for (const entry of due) {
      if (!await owns()) break;
      const run = entry.latest;
      const later = await Run.exists({ ruleId: rule._id, ruleRevision: rule.revision, occurrenceKey: run.occurrenceKey, dueAt: { $gt: run.dueAt, $lte: now }, status: { $in: ['preparing', 'queued', 'sent', 'partial', 'unknown', 'failed', 'expired', 'cancelled', 'skipped'] } });
      if (later) { await Run.updateOne({ _id: run._id, status: { $in: ['scheduled', 'preparing'] } }, { $set: { status: 'skipped', reason: 'A later reminder stage was already processed.' }, $unset: { lockOwner: 1, lockUntil: 1, workerLeaseOwner: 1 } }); continue; }
      await Run.updateMany({ ruleId: rule._id, ruleRevision: rule.revision, occurrenceKey: run.occurrenceKey, dueAt: { $lt: run.dueAt }, status: 'scheduled' }, { $set: { status: 'skipped', reason: 'A later reminder stage is due.' } });
      if (!await owns()) break;
      await dispatchReminder(run._id, now, owner); dispatched++;
    }
    return { claimed: true, planned, dispatched };
  } finally {
    clearInterval(renew);
    if (!await Rule.exists({ _id: rule._id, enabled: true, revision: rule.revision })) {
      await Run.updateMany({ ruleId: rule._id, ruleRevision: rule.revision, status: 'scheduled' }, { $set: { status: 'cancelled', reason: 'Rule disabled.' } });
    }
    await Rule.updateOne({ _id: rule._id, workerLeaseOwner: owner }, { $unset: { workerLeaseOwner: 1, workerLeaseUntil: 1 } });
  }
}
module.exports = { processBroadcastRule };
