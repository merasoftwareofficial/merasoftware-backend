const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Lead = require('../models/leadModel');
const { EmailDraft } = require('../models/emailControlModel');
const { FinalMessage, Lock, Queue, State, STATE_ID, finishedExpiry } = require('../whatsapp/src/models.js');
const { DEAD, NEGATIVE } = require('./leadStatuses');
const { findLeadsByPhone } = require('./leadPhone');
const { workerAlive } = require('./whatsappReadiness');
const { clientEligible, clientAutomationEnabled, isClientRow } = require('./finalMessage');

// Every minute (index.js): follows each final message after the admin's decision. Never sends: a message only
// reaches the queue through the review popup. A lead becomes Dead only here, or by the admin's hand.
const LOCK_ID = 'final-message-job';
const LOCK_MS = 120_000;
const LEGACY_COPY_MS = 5 * 60_000; // an email sent without a channel choice queues its WhatsApp copy just after
const STAGE_MOVED = 'Not sent: the lead was moved out of Negative.';

const timelineEntry = (note, badge) => ({ note, badge, date: new Date(), createdAt: new Date() });

/** A timeline note, under the stage the lead is in now. */
async function addNote(leadId, note) {
  const lead = await Lead.findById(leadId).select('status').lean();
  if (lead) await Lead.updateOne({ _id: leadId }, { $push: { followUps: timelineEntry(note, lead.status) } });
}

const rowGuard = row => ({ _id: row._id, status: row.status, ...(isClientRow(row) ? { episodeId: row.episodeId } : {}) });
async function endRow(row, status) { await FinalMessage.updateOne(rowGuard(row), { $set: { status } }); }

/** What the admin decided and how far the message got. */
async function followMessage(row, time) {
  const queued = await Queue.findOne({ emailDraftId: row.draftId }).select('status to sentAt').lean();
  if (isClientRow(row) && !await clientEligible(await Lead.findById(row.leadId).lean(), row)) {
    if (queued?.status === 'pending') await Queue.updateOne({ _id: queued._id, status: 'pending' }, { $set: { status: 'cancelled', lastError: STAGE_MOVED, expiresAt: finishedExpiry(time) } });
    if (queued?.status !== 'sending') await endRow(row, 'stopped');
    return;
  }
  if (queued) {
    if (queued.status === 'sent') {
      const sentAt = queued.sentAt || time;
      const changed = await FinalMessage.updateOne(rowGuard(row), { $set: { status: 'waiting', phone: queued.to, sentAt, deadlineAt: new Date(sentAt.getTime() + row.hours * 3_600_000) } });
      if (changed.modifiedCount) await addNote(row.leadId, `Final message sent. Waiting ${row.hours} hours for a reply.`);
    } else if (['pending', 'sending'].includes(queued.status)) {
      if (row.status !== 'queued') await FinalMessage.updateOne(rowGuard(row), { $set: { status: 'queued', phone: queued.to } });
      const lead = await Lead.findById(row.leadId).select('status deletedAt').lean();
      if (!isClientRow(row) && queued.status === 'pending' && (!lead || lead.deletedAt || lead.status !== NEGATIVE)) {
        const { modifiedCount } = await Queue.updateOne({ _id: queued._id, status: 'pending' }, { $set: { status: 'cancelled', lastError: STAGE_MOVED, expiresAt: finishedExpiry(time) } });
        if (modifiedCount) await FinalMessage.updateOne({ _id: row._id }, { $set: { status: 'not-sent' } });
      }
    } else {
      await FinalMessage.updateOne(rowGuard(row), { $set: { status: 'not-sent', phone: queued.to } }); // failed, expired, cancelled or skipped: no timer, and it may go again
    }
    return;
  }
  const draft = await EmailDraft.findById(row.draftId).select('status delivery sentAt').lean();
  if (!draft || draft.status === 'skipped' || row.status === 'queued') return endRow(row, 'not-sent'); // expired undecided, Don't Send, or a queue row that is gone
  const channels = draft.delivery?.channels;
  if (channels && !channels.includes('whatsapp') && draft.delivery.emailStatus === 'sent') return endRow(row, 'email-only');
  if (!channels && draft.status === 'sent' && draft.sentAt && time - draft.sentAt > LEGACY_COPY_MS) return endRow(row, 'email-only');
  return undefined; // still waiting for the decision, or for a failed send's retry
}

const repliedAfterSend = row => row.lastReplyAt && row.sentAt && row.lastReplyAt >= row.sentAt;

/** A reply of any kind: the lead stays Negative and the admin sees it. A late one brings a Dead lead back to Negative. */
async function settleReply(row, time) {
  if (isClientRow(row)) {
    const lead = await Lead.findById(row.leadId).lean();
    if (row.status === 'dead') {
      if (!clientAutomationEnabled() || !lead || lead.deletedAt || lead.clientBehaviour !== DEAD || String(lead.convertedToUserId) !== String(row.clientId) || (lead.clientBehaviourRevision || 0) !== (row.behaviourRevision || 0)) return endRow(row, 'stopped');
      await mongoose.connection.transaction(async session => {
        const claimed = await FinalMessage.updateOne(rowGuard(row), { $set: { status: 'replied', replySeenAt: time } }, { session });
        if (!claimed.modifiedCount) return;
        const changed = await Lead.updateOne({ _id: lead._id, deletedAt: null, convertedToUserId: row.clientId, clientBehaviour: DEAD, clientBehaviourRevision: row.behaviourRevision ? row.behaviourRevision : { $in: [null, 0] } }, { $set: { clientBehaviour: NEGATIVE }, $push: { followUps: timelineEntry(`Replied to the final message: ${row.lastReplyText || 'Message'}`, 'Won') } }, { session });
        if (!changed.modifiedCount) throw new Error('Client changed while a late reply was being recorded.');
      });
      return;
    } else if (!await clientEligible(lead, row)) return endRow(row, 'stopped');
  }
  const { modifiedCount } = await FinalMessage.updateOne(rowGuard(row), { $set: { status: 'replied', replySeenAt: time } });
  if (!modifiedCount) return;
  if (row.status === 'dead' && !isClientRow(row)) await Lead.updateOne({ _id: row.leadId, status: DEAD }, { $set: { status: NEGATIVE } });
  await addNote(row.leadId, `Replied to the final message: ${row.lastReplyText || 'Message'}`);
}

/** An ignored message changes nothing but shows on the timeline, so the admin can see what the person wrote. */
async function noteIgnored(row) {
  const { modifiedCount } = await FinalMessage.updateOne({ _id: row._id, lastIgnoredAt: row.lastIgnoredAt }, { $set: { ignoredNotedAt: row.lastIgnoredAt } });
  if (modifiedCount) await addNote(row.leadId, `Message after the final message, not counted as a reply: ${row.lastIgnoredText || 'Message'}`);
}
const ignoredToNote = row => row.sentAt && row.lastIgnoredAt >= row.sentAt && (!row.ignoredNotedAt || row.lastIgnoredAt > row.ignoredNotedAt);

/** No reply in time: Dead, only if the lead is still Negative. The admin may have moved it meanwhile. */
async function closeRow(row) {
  if (isClientRow(row)) {
    const lead = await Lead.findById(row.leadId).lean();
    if (!await clientEligible(lead, row)) return endRow(row, 'stopped');
    await mongoose.connection.transaction(async session => {
      // Incoming replies update this same row. A competing inbound write makes
      // Mongo retry the transaction, which then sees the reply and cannot close.
      const claimed = await FinalMessage.updateOne({ _id: row._id, episodeId: row.episodeId, status: 'waiting', $or: [{ lastReplyAt: null }, { lastReplyAt: { $lt: row.sentAt } }] }, { $set: { status: 'dead' } }, { session });
      if (!claimed.modifiedCount) return;
      const changed = await Lead.updateOne({ _id: row.leadId, deletedAt: null, convertedToUserId: row.clientId, status: 'Won', clientBehaviour: NEGATIVE, clientBehaviourRevision: row.behaviourRevision ? row.behaviourRevision : { $in: [null, 0] } }, { $set: { clientBehaviour: DEAD }, $push: { followUps: timelineEntry(`No reply to the final message in ${row.hours} hours. Client behaviour moved to Dead.`, 'Won') } }, { session });
      if (!changed.modifiedCount) throw new Error('Client changed while the final message was closing.');
    });
    return;
  }
  const leads = await findLeadsByPhone(row.phone, { status: NEGATIVE, deletedAt: null, convertedToUserId: null });
  const own = leads.some(lead => String(lead._id) === String(row.leadId));
  if (!own) return endRow(row, 'stopped');
  for (const lead of leads) {
    await Lead.updateOne({ _id: lead._id, status: NEGATIVE },
      { $set: { status: DEAD }, $push: { followUps: timelineEntry(`No reply to the final message in ${row.hours} hours. Moved to Dead.`, DEAD) } });
  }
  return endRow(row, 'dead');
}

async function followFinalMessages() {
  if (process.env.ENABLE_WHATSAPP !== 'true') return { reason: 'disabled' };
  const owner = crypto.randomUUID();
  const time = new Date();
  try {
    await Lock.updateOne({ _id: LOCK_ID, $or: [{ expiresAt: { $lte: time } }, { owner }] }, { $set: { owner, expiresAt: new Date(time.getTime() + LOCK_MS) } }, { upsert: true });
  } catch (error) { if (error.code === 11000) return { reason: 'busy' }; throw error; }
  const attempt = async (row, work) => {
    try { await work(row, time); } catch (error) { console.error('[final message] could not follow a message, will try again:', error.message); }
  };
  try {
    for (const row of await FinalMessage.find({ status: { $in: ['review', 'queued'] } }).lean()) await attempt(row, followMessage);
    if (!clientAutomationEnabled()) {
      for (const row of await FinalMessage.find({ subjectKind: 'client', status: 'waiting' }).lean()) await attempt(row, item => endRow(item, 'stopped'));
    }
    // Replies before deadlines: a reply and an expired deadline in the same minute is a reply.
    for (const row of await FinalMessage.find({ status: { $in: ['waiting', 'dead'] }, lastReplyAt: { $ne: null } }).lean()) {
      if (repliedAfterSend(row)) await attempt(row, settleReply);
    }
    for (const row of await FinalMessage.find({ lastIgnoredAt: { $ne: null }, status: { $in: ['waiting', 'dead', 'replied'] } }).lean()) {
      if (ignoredToNote(row)) await attempt(row, noteIgnored);
    }
    // A worker that isn't listening can't have seen a reply, so nothing goes Dead until it is back.
    const state = await State.findById(STATE_ID).select('heartbeatAt connection').lean();
    if (workerAlive(state, time) && state.connection === 'connected') {
      for (const row of await FinalMessage.find({ status: 'waiting', deadlineAt: { $lte: time } }).lean()) await attempt(row, closeRow);
    }
    return { reason: 'done' };
  } finally {
    await Lock.updateOne({ _id: LOCK_ID, owner }, { $set: { expiresAt: new Date(0) } });
  }
}

module.exports = { followFinalMessages };
