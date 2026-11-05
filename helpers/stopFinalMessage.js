const mongoose = require('mongoose');
const Lead = require('../models/leadModel');
const { EmailDraft } = require('../models/emailControlModel');
const { FinalMessage, Queue, OutgoingAttempt, finishedExpiry } = require('../whatsapp/src/models.js');
const ACTIVE = ['review', 'queued', 'waiting', 'dead'];
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
const cycleGuard = row => ({ _id: row._id, draftId: row.draftId, status: row.status, ...(row.subjectKind === 'client' ? { episodeId: row.episodeId } : {}) });
const inFlight = item => item?.status === 'sending' && item.sendPhase !== 'preparing';

async function stopCycle(row, { reason, actor, source = 'admin' }) {
  return mongoose.connection.transaction(async session => {
    const current = await FinalMessage.findOne({ _id: row._id, draftId: row.draftId }).session(session).lean();
    if (!current) fail('This countdown changed. Refresh before stopping it.');
    if (current.status === 'stopped' && current.stopSource) return { stopped: true, alreadyStopped: true };
    if (!ACTIVE.includes(current.status)) fail('This countdown is no longer active.');
    // Every copy counts: the cycle may reach two numbers (helpers/finalMessageCopies.js).
    const expiries = await Queue.find({ finalMessageExpiryId: row.draftId }).session(session).lean();
    const originals = await Queue.find({ emailDraftId: row.draftId }).session(session).lean();
    const draft = await EmailDraft.findById(row.draftId).session(session).lean();
    if (expiries.some(expiry => expiry.status === 'sent')) fail('The closure message has already been sent and cannot be recalled.');
    if (expiries.some(inFlight) || originals.some(inFlight) || draft?.status === 'sending' || draft?.delivery?.lockUntil > new Date()) fail('A message is already being sent. Refresh after it finishes; an in-progress send cannot be recalled.');
    const at = new Date();
    const changed = await FinalMessage.updateOne({ _id: current._id, draftId: row.draftId, status: current.status }, { $set: {
      status: 'stopped', stoppedAt: at, stopReason: reason, stopSource: source, ...(actor ? { stoppedBy: actor } : {}),
    } }, { session });
    if (!changed.modifiedCount) fail('The countdown changed. Refresh and try again.');
    await Queue.updateMany({ $and: [{ $or: [{ status: 'pending' }, { status: 'sending', sendPhase: 'preparing' }] }, { $or: [{ emailDraftId: row.draftId }, { finalMessageExpiryId: row.draftId }] }] },
      { $set: { status: 'cancelled', lastError: `Countdown stopped: ${reason}`, expiresAt: finishedExpiry(at) } }, { session });
    await EmailDraft.updateOne({ _id: row.draftId, status: { $in: ['staged', 'pending', 'failed'] } }, { $set: { status: 'skipped' } }, { session });
    const lead = await Lead.findById(row.leadId).select('status clientBehaviour convertedToUserId').session(session).lean();
    if (lead) await Lead.updateOne({ _id: row.leadId }, { $push: { followUps: { note: `Final message countdown stopped: ${reason}`, badge: require('./finalMessageCycle').currentStatus(lead), date: at, createdAt: at, ...(actor ? { createdBy: actor } : {}) } } }, { session });
    return { stopped: true, alreadyStopped: false };
  });
}

// Outgoing echoes can precede the sender's messageId write. Defer classification while that chat
// has a send in flight; the deadline job and sender guard also consult this durable evidence.
async function processOutbound(row) {
  const cycleStart = row.cycleStartedAt || row.draftId?.getTimestamp?.() || row.sentAt || row.createdAt;
  // Our messages on any number of the cycle: the main, the alternate, or one a copy went to.
  const to = { $in: require('./finalMessageCopies').cycleNumbers(row) };
  const ownCopies = new Set([row.originalMessage?.id, ...(row.sends || []).map(send => send.id)].filter(Boolean));
  const checks = [...(row.outboundChecks || [])];
  if (cycleStart) {
    // The sender may crash after delivery but before noteOutgoing, and WhatsApp need not echo.
    // Durable attempt outcomes recover successful manual sends; uncertain ones postpone closure.
    const attempts = await OutgoingAttempt.find({ to, createdAt: { $gte: cycleStart }, source: { $in: ['manual', 'unknown'] },
      $or: [{ phase: 'sent' }, { phase: { $in: ['handoff', 'failed'] }, handedOffAt: { $ne: null } }] }).lean();
    for (const attempt of attempts) {
      if (attempt.phase !== 'sent' && attempt.queueId) {
        const accepted = await Queue.findOne({ _id: attempt.queueId, to, status: 'sent',
          $or: [{ attemptMessageId: attempt._id }, { messageId: attempt._id }] }).lean();
        if (accepted) {
          await OutgoingAttempt.updateOne({ _id: attempt._id }, { $set: { phase: 'sent', resultMessageId: accepted.messageId || attempt._id } });
          attempt.phase = 'sent';
          attempt.resultMessageId = accepted.messageId || attempt._id;
        }
      }
      const id = attempt.resultMessageId || attempt._id;
      if (!checks.some(item => item.id === id)) checks.push({ id, at: attempt.createdAt });
    }
    // Without a successful result or an own-message echo, handoff is not proof of delivery.
    if (attempts.some(attempt => attempt.phase !== 'sent' && !(row.outboundChecks || []).some(item => item.id === attempt._id || item.id === attempt.resultMessageId))) return 'pending';
  }
  for (const item of checks) {
    if (!cycleStart || item.at.getTime() + 999 < cycleStart.getTime() || ownCopies.has(item.id)) {
      await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId }, { $pull: { outboundChecks: { id: item.id } } });
      continue;
    }
    const attempt = await OutgoingAttempt.findOne({ to, $or: [{ _id: item.id }, { resultMessageId: item.id }] }).lean();
    const sent = attempt ? null : await Queue.findOne({ messageId: item.id, to }).lean();
    // An old worker may have sent without retaining its ID. Do not turn a lost acknowledgement
    // into a fabricated manual chat. Keep the evidence unresolved for operator reconciliation.
    if (!attempt && !sent && (item.source === 'unknown' || await Queue.exists({ to, $or: [{ status: { $in: ['sending', 'failed'] } }, { status: 'pending', attempts: { $gt: 0 } }], attemptMessageId: null, messageId: null, createdAt: { $lte: new Date(item.at.getTime() + 999) } }))) {
      await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId, 'outboundChecks.id': item.id }, { $set: { 'outboundChecks.$.source': 'unknown' } });
      return 'pending';
    }
    const source = attempt?.source || (sent ? await require('./whatsappQueue').queueSource(sent) : 'manual');
    if (source === 'unknown') {
      await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId, 'outboundChecks.id': item.id }, { $set: { 'outboundChecks.$.source': 'unknown' } });
      return 'pending';
    }
    if (source === 'manual') {
      if (await Queue.exists({ finalMessageExpiryId: row.draftId, status: 'sent' })) {
        await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId }, { $pull: { outboundChecks: { id: item.id } } });
        continue;
      }
      try { await stopCycle(row, { reason: 'A message was sent from our side in this chat.', source: 'outgoing' }); }
      catch (error) { if (error.status === 409) return 'pending'; throw error; }
      return 'stopped';
    }
    await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId }, { $pull: { outboundChecks: { id: item.id } } });
  }
  return 'clear';
}

async function noteOutgoing(phone, id, at) {
  if (!id || !at) return;
  const query = { ...require('./finalMessageCopies').onNumber(phone), status: { $in: ACTIVE }, createdAt: { $lte: new Date(at.getTime() + 999) } };
  await FinalMessage.updateMany(query, { $addToSet: { outboundChecks: { id, at } } });
  for (const row of await FinalMessage.find(query).lean()) await processOutbound(row);
}
// Stop and handoff write the same queue/cycle documents in a transaction. Exactly one can win.
// The handoff is the boundary: after it commits, a crash may leave delivery ambiguous, never retried blindly.
async function claimHandoff(item) {
  const { laterCopyMayGo } = require('./finalMessageCopies');
  const draftId = item.finalMessageExpiryId || (item.event === 'lead.finalMessage' && item.emailDraftId);
  const claim = session => Queue.updateOne({ _id: item._id, status: 'sending', sendPhase: 'preparing', attemptMessageId: item.attemptMessageId }, { $set: { sendPhase: 'handoff' } }, session ? { session } : {});
  if (!draftId) return Boolean((await claim()).modifiedCount);
  return mongoose.connection.transaction(async session => {
    const row = await FinalMessage.findOne({ draftId }).session(session).lean();
    if (row) {
      if (!(item.finalMessageExpiryId ? row.status === 'dead' : ['review', 'queued'].includes(row.status) || laterCopyMayGo(row, item)) || row.outboundChecks?.length || (row.lastReplyAt && row.sentAt && row.lastReplyAt >= row.sentAt)) return false;
      // Touch the cycle to conflict with concurrent Stop, reply and replacement writes.
      await FinalMessage.updateOne(cycleGuard(row), { $inc: { sendRevision: 1 } }, { session });
    } else if (item.finalMessageExpiryId) return false;
    return Boolean((await claim(session)).modifiedCount);
  });
}
module.exports = { stopCycle, processOutbound, noteOutgoing, cycleGuard, claimHandoff };
