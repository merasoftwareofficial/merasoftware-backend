const { Broadcast, BroadcastRecipient } = require('../models/broadcastModel');

// Use the accepted snapshot, never a fresh audience query. A lead qualifies
// only when every original destination and every part actually finished.
// This function is read-only; it neither schedules nor sends follow-ups.
async function broadcastReminderCandidates(broadcastId, activatedAt, leadId = null) {
  const broadcast = await Broadcast.findOne({ _id: broadcastId, state: { $in: ['ready', 'finished'] }, createdAt: { $gte: activatedAt }, acceptanceCompletedAt: { $gte: activatedAt } }).lean();
  if (!broadcast) return [];
  const rows = await BroadcastRecipient.find({ broadcastId, ...(leadId ? { leadId } : {}) }).lean();
  const byLead = new Map();
  for (const row of rows) {
    const id = String(row.leadId);
    if (!byLead.has(id)) byLead.set(id, []);
    byLead.get(id).push(row);
  }
  return [...byLead.values()].flatMap(recipients => {
    if (recipients.some(row => row.state !== 'sent' || !row.sentAt || !Number.isFinite(+new Date(row.sentAt)))) return [];
    const destinations = new Map();
    for (const row of recipients) {
      const key = `${row.channel}:${row.channel === 'email' ? row.email : row.phone}`;
      if (!destinations.has(key)) destinations.set(key, []);
      destinations.get(key).push(row);
    }
    for (const parts of destinations.values()) {
      const total = Number(parts[0].parts);
      if (!Number.isInteger(total) || total < 1 || parts.length !== total || parts.some(row => Number(row.parts) !== total) || new Set(parts.map(row => row.part)).size !== total || parts.some(row => row.part < 0 || row.part >= total)) return [];
    }
    return [{ broadcastId: broadcast._id, leadId: recipients[0].leadId,
      anchorAt: new Date(Math.max(...recipients.map(row => +new Date(row.sentAt)))), recipients }];
  });
}
// Reuse Broadcast's live audience/block/number checks against every original
// destination. This helper does not create or send a reminder by itself.
async function eligibleBroadcastReminder(broadcastId, leadId, activatedAt, anchorAt, { requireName = false } = {}) {
  const broadcast = await Broadcast.findById(broadcastId).lean();
  if (!broadcast) return null;
  const candidate = (await broadcastReminderCandidates(broadcastId, activatedAt, leadId))[0];
  if (!candidate || +candidate.anchorAt !== +new Date(anchorAt)) return null;
  return checkBroadcastCandidate(broadcast, candidate, { requireName });
}
async function checkBroadcastCandidate(broadcast, candidate, { requireName = false, blocks } = {}) {
  const { eligible } = require('./broadcastAudience');
  let lead = null;
  const checked = new Set();
  for (const recipient of candidate.recipients) {
    const key = `${recipient.channel}:${recipient.channel === 'email' ? recipient.email : recipient.phone}`;
    if (checked.has(key)) continue;
    checked.add(key);
    lead = await eligible(broadcast.audience, recipient, { requireName, blocks });
    if (!lead) return null;
  }
  return { ...candidate, lead, broadcast };
}
module.exports = { broadcastReminderCandidates, eligibleBroadcastReminder, checkBroadcastCandidate };
