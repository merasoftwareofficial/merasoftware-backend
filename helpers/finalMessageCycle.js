const Lead = require('../models/leadModel');
const { FinalMessage, Queue } = require('../whatsapp/src/models.js');
const { DEAD, NEGATIVE, DEFAULT_CLIENT_BEHAVIOUR, leadStatusLabel } = require('./leadStatuses');
const { normalizePhone } = require('./whatsappQueue');

// One rule for leads and clients. A cycle runs from its review until Dead, a reply decision or a stop.
// While it runs nothing new is sent; once it has finished, marking the person Negative again starts a new one.
const RUNNING = ['review', 'queued', 'waiting'];
const isRunning = row => Boolean(row) && (RUNNING.includes(row.status) || (row.status === 'replied' && !row.decision));

// A lead's stage, or a client's current status.
const currentStatus = lead => (lead.convertedToUserId ? lead.clientBehaviour || DEFAULT_CLIENT_BEHAVIOUR : lead.status);

/** Why this cycle no longer belongs to its person, or null while it still does. */
function mismatch(lead, row) {
  if (!lead || lead.deletedAt) return 'Moved to Trash';
  const client = row.subjectKind === 'client';
  if (!client && lead.convertedToUserId) return 'Converted to client';
  if (client && String(lead.convertedToUserId) !== String(row.clientId)) return 'Client link changed';
  if (row.phone && normalizePhone(lead.phone) !== row.phone) return 'Phone number changed';
  const status = currentStatus(lead);
  if (status !== (row.status === 'dead' ? DEAD : NEGATIVE)) return `Status changed to ${leadStatusLabel(status)}`;
  if (client && (lead.clientBehaviourRevision || 0) !== (row.behaviourRevision || 0)) return 'Status changed';
  return null;
}

/** A Dead cycle whose closure message has not gone yet, so it can still be cancelled. */
async function closurePending(row) {
  if (row.status !== 'dead' || !row.expiryEnabled) return false;
  if (!row.expiryQueuedAt) return Boolean(row.originalMessage?.id) && !(row.lastReplyAt && row.sentAt && row.lastReplyAt >= row.sentAt);
  // One closure message per number the cycle reached: cancellable while any of them has not started.
  const queued = await Queue.find({ finalMessageExpiryId: row.draftId }).select('status sendPhase').lean();
  return queued.some(item => item.status === 'pending' || (item.status === 'sending' && item.sendPhase === 'preparing'));
}

/** Ends the cycle with a reason on the timeline. 'pending' = a send is in flight; the minute job tries again. */
async function endCycle(row, reason, actor) {
  if (row.status === 'replied') {
    // The admin moved the person instead of deciding: the reply no longer waits in Needs decision.
    const changed = await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId, status: 'replied', decision: null },
      { $set: { status: 'stopped', stoppedAt: new Date(), stopReason: reason, stopSource: 'status-change', ...(actor ? { stoppedBy: actor } : {}) } });
    return changed.modifiedCount ? 'stopped' : null;
  }
  try {
    const result = await require('./stopFinalMessage').stopCycle(row, { reason, actor, source: 'status-change' });
    return result.stopped ? 'stopped' : null;
  } catch (error) {
    if (error.status === 409) return 'pending';
    throw error;
  }
}

/** Called after every change to a person (stage, client status, conversion, Trash, phone) and by the minute job. */
async function reconcileCycle(leadId, { actor } = {}) {
  const row = await FinalMessage.findOne({ leadId }).lean();
  if (!row || !(isRunning(row) || await closurePending(row))) return null;
  const lead = await Lead.findById(leadId).lean();
  const reason = mismatch(lead, row);
  if (!reason) {
    // Only the alternate number changed: the countdown goes on, and the new alternate is the cycle's from now on.
    // Replies from the old one still count when a copy went there (row.sends).
    return await refreshAltPhone(lead, row);
  }
  // The admin's change is already saved; a failure here must not undo or fail it. The minute job tries again.
  try { return await endCycle(row, reason, actor); } catch (error) {
    console.error('[final message] the cycle could not end now; the minute job will retry:', error.message);
    return 'pending';
  }
}

/** A running cycle follows its lead's alternate number: a changed or removed one replaces it (signup.md §3.9). */
async function refreshAltPhone(lead, row) {
  if (!lead || !RUNNING.includes(row.status)) return;
  const { altSendingEnabled, usableAlt } = require('./contactNumbers');
  let alt = altSendingEnabled() ? usableAlt(lead.altPhone, lead.phone) : null;
  if ((alt || null) === (row.altPhone || null)) return;
  if (alt) {
    // The same checks as at preparation, except this cycle's own countdown, which blocks its own numbers.
    const { contactBlocks, numberBlock } = require('./leadContactBlock');
    const { onNumber } = require('./finalMessageCopies');
    if (['dead', 'wrong', 'client-dead'].includes(numberBlock(alt, await contactBlocks()))) alt = null;
    else if ((await FinalMessage.find({ leadId: { $ne: lead._id }, ...onNumber(alt) }).lean()).some(isRunning)) alt = null;
    if ((alt || null) === (row.altPhone || null)) return;
  }
  // Cycle and unsent destinations change together. A transport handoff must settle before replacing its number.
  return require('mongoose').connection.transaction(async session => {
    const current = await FinalMessage.findOne({ _id: row._id, draftId: row.draftId, status: row.status }).session(session).lean();
    if (!current) return null;
    const copies = await Queue.find({ emailDraftId: row.draftId }).session(session).lean();
    if (copies.some(copy => copy.status === 'sending' && copy.sendPhase !== 'preparing')) return 'pending';
    const sent = copies.filter(copy => copy.status === 'sent');
    const sends = [...(current.sends || [])];
    for (const copy of sent) if (!sends.some(send => send.phone === copy.to)) sends.push(require('./finalMessageCopies').sendOf(copy));
    const unsent = copies.filter(copy => copy.alt && (copy.status === 'pending' || (copy.status === 'sending' && copy.sendPhase === 'preparing')));
    const reached = alt && sends.some(send => send.phone === alt);
    let replacementNeeded = !unsent.length;
    for (const copy of unsent) {
      const replaceInPlace = copy.status === 'pending';
      if (!replaceInPlace) replacementNeeded = true;
      const filter = { _id: copy._id, status: copy.status, ...(copy.status === 'sending' ? { sendPhase: 'preparing' } : {}) };
      await Queue.updateOne(filter, alt && !reached && replaceInPlace
        ? { $set: { to: alt } }
        : { $set: { status: 'cancelled', lastError: 'Alternate number changed.', expiresAt: require('../whatsapp/src/models.js').finishedExpiry(new Date()) } }, { session });
    }
    // The old alternate already received its copy: retain that evidence and reach the new alternate in its own chat.
    if (alt && !reached && replacementNeeded && copies.length && (current.status === 'waiting' || unsent.length)) {
      const seed = copies[0];
      await require('./whatsappQueue').enqueueWhatsApp({ to: alt, alt: true, text: seed.text,
        emailDraftId: current.draftId, email: seed.email, event: 'lead.finalMessage', application: seed.application, source: 'automated' }, { session });
    }
    await FinalMessage.updateOne({ _id: current._id, draftId: current.draftId, status: current.status }, { $set: { altPhone: alt || null, sends } }, { session });
    return null;
  });
}

/** What the lead page offers: Stop only while something can still be stopped. */
async function stopOption(row) {
  if (!row) return null;
  if (row.status === 'queued' || row.status === 'waiting') {
    const originals = await Queue.find({ emailDraftId: row.draftId }).select('status sendPhase').lean();
    if (originals.some(original => original.status === 'sending' && original.sendPhase !== 'preparing')) return null;
    return row.status === 'queued' ? 'Stop final message' : 'Stop countdown';
  }
  return await closurePending(row) ? 'Cancel closure message' : null;
}

module.exports = { RUNNING, isRunning, currentStatus, mismatch, reconcileCycle, stopOption };
