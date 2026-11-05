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
  const queued = await Queue.findOne({ finalMessageExpiryId: row.draftId }).select('status sendPhase').lean();
  return queued?.status === 'pending' || (queued?.status === 'sending' && queued.sendPhase === 'preparing');
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
  const reason = mismatch(await Lead.findById(leadId).lean(), row);
  if (!reason) return null;
  // The admin's change is already saved; a failure here must not undo or fail it. The minute job tries again.
  try { return await endCycle(row, reason, actor); } catch (error) {
    console.error('[final message] the cycle could not end now; the minute job will retry:', error.message);
    return 'pending';
  }
}

/** What the lead page offers: Stop only while something can still be stopped. */
async function stopOption(row) {
  if (!row) return null;
  if (row.status === 'queued' || row.status === 'waiting') {
    const original = await Queue.findOne({ emailDraftId: row.draftId }).select('status sendPhase').lean();
    if (original?.status === 'sending' && original.sendPhase !== 'preparing') return null;
    return row.status === 'queued' ? 'Stop final message' : 'Stop countdown';
  }
  return await closurePending(row) ? 'Cancel closure message' : null;
}

module.exports = { RUNNING, isRunning, currentStatus, mismatch, reconcileCycle, stopOption };
