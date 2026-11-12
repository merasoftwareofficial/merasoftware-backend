const Run = require('../models/communicationReminderRunModel');
const Rule = require('../models/communicationReminderRuleModel');
const { broadcastReminderCandidates, checkBroadcastCandidate } = require('./broadcastReminderCandidates');
const { Broadcast } = require('../models/broadcastModel');
const DAY = 86400000;

// Persist stable per-broadcast / original-lead / step identities. The guarded
// worker calls this only for enabled rules under its lease.
async function planBroadcastReminders(rule, broadcastId) {
  if (!rule?.enabled || rule.source !== 'broadcast' || !rule.activatedAt) return 0;
  const candidates = await broadcastReminderCandidates(broadcastId, rule.activatedAt);
  const broadcast = await Broadcast.findById(broadcastId).lean();
  if (!broadcast) return 0;
  const existing = await Run.find({ ruleId: rule._id, ruleRevision: rule.revision, source: 'broadcast', entityId: broadcastId }).select('occurrenceKey step').lean();
  const planned = new Set(existing.map(row => `${row.occurrenceKey}:${row.step}`));
  let count = 0;
  // Planning only decides who is scheduled: read the blocked numbers once for the pass, not once per lead.
  // Delivery still checks the current state per recipient (eligibleBroadcastReminder, no shared map).
  let blocks = null;
  for (const candidate of candidates) {
    const occurrenceKey = `${broadcastId}:${candidate.leadId}`;
    if ((rule.steps || []).every((_, step) => planned.has(`${occurrenceKey}:${step}`))) continue;
    if (!await Rule.exists({ _id: rule._id, enabled: true, revision: rule.revision })) break;
    blocks = blocks || await require('./leadContactBlock').contactBlocks();
    const eligible = await checkBroadcastCandidate(broadcast, candidate, { blocks });
    if (!eligible) continue;
    for (const [step, item] of (rule.steps || []).entries()) {
      if (planned.has(`${occurrenceKey}:${step}`)) continue;
      const requireName = /\{\{\s*name\s*\}\}/.test(`${item.subject}\n${item.text}`);
      if (requireName && !require('./leadName').hasConfirmedName(eligible.lead)) continue;
      const dueAt = new Date(+candidate.anchorAt + Number(item.offsetDays) * DAY);
      if (!Number.isFinite(+dueAt) || dueAt < new Date(rule.activatedAt)) continue;
      const key = { ruleId: rule._id, ruleRevision: rule.revision, occurrenceKey, step };
      try {
        await Run.updateOne(key, { $setOnInsert: { ...key, source: 'broadcast', entityId: broadcastId, clientId: candidate.leadId,
          anchorAt: candidate.anchorAt, dueAt, subject: item.subject, text: item.text, channel: item.channel } }, { upsert: true, runValidators: true });
      } catch (error) { if (error.code !== 11000) throw error; }
      count++;
    }
  }
  return count;
}
module.exports = { planBroadcastReminders };
