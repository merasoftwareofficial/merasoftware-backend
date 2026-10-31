const crypto = require('node:crypto');
const Lead = require('../models/leadModel');
const { EmailDraft } = require('../models/emailControlModel');
const { FinalMessage, Lock, Queue, State, STATE_ID, finishedExpiry } = require('../whatsapp/src/models.js');
const { DEAD, NEGATIVE } = require('./leadStatuses');
const { findLeadsByPhone } = require('./leadPhone');
const { workerAlive } = require('./whatsappReadiness');

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

async function endRow(row, status) { await FinalMessage.updateOne({ _id: row._id, status: row.status }, { $set: { status } }); }

/** What the admin decided and how far the message got. */
async function followMessage(row, time) {
  const queued = await Queue.findOne({ emailDraftId: row.draftId }).select('status to sentAt').lean();
  if (queued) {
    if (queued.status === 'sent') {
      const sentAt = queued.sentAt || time;
      await FinalMessage.updateOne({ _id: row._id, status: row.status }, { $set: { status: 'waiting', phone: queued.to, sentAt, deadlineAt: new Date(sentAt.getTime() + row.hours * 3_600_000) } });
      await addNote(row.leadId, `Final message sent. Waiting ${row.hours} hours for a reply.`);
    } else if (['pending', 'sending'].includes(queued.status)) {
      if (row.status !== 'queued') await FinalMessage.updateOne({ _id: row._id, status: row.status }, { $set: { status: 'queued', phone: queued.to } });
      const lead = await Lead.findById(row.leadId).select('status deletedAt').lean();
      if (queued.status === 'pending' && (!lead || lead.deletedAt || lead.status !== NEGATIVE)) {
        const { modifiedCount } = await Queue.updateOne({ _id: queued._id, status: 'pending' }, { $set: { status: 'cancelled', lastError: STAGE_MOVED, expiresAt: finishedExpiry(time) } });
        if (modifiedCount) await FinalMessage.updateOne({ _id: row._id }, { $set: { status: 'not-sent' } });
      }
    } else {
      await FinalMessage.updateOne({ _id: row._id, status: row.status }, { $set: { status: 'not-sent', phone: queued.to } }); // failed, expired, cancelled or skipped: no timer, and it may go again
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
  const { modifiedCount } = await FinalMessage.updateOne({ _id: row._id, status: row.status }, { $set: { status: 'replied', replySeenAt: time } });
  if (!modifiedCount) return;
  if (row.status === 'dead') await Lead.updateOne({ _id: row.leadId, status: DEAD }, { $set: { status: NEGATIVE } });
  await addNote(row.leadId, `Replied to the final message: ${row.lastReplyText || 'Message'}`);
}

/** No reply in time: Dead, only if the lead is still Negative. The admin may have moved it meanwhile. */
async function closeRow(row) {
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
    // Replies before deadlines: a reply and an expired deadline in the same minute is a reply.
    for (const row of await FinalMessage.find({ status: { $in: ['waiting', 'dead'] }, lastReplyAt: { $ne: null } }).lean()) {
      if (repliedAfterSend(row)) await attempt(row, settleReply);
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
