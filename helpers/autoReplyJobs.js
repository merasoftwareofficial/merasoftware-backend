const crypto = require('node:crypto');
const Lead = require('../models/leadModel');
const { AUTO_REPLY_EVENT, FinalMessage, Inbox, Lock, OUR_SIDE_REPLIED, Queue, Rule, State, STATE_ID, finishedExpiry } = require('../whatsapp/src/models.js');
const { RULE_KEY } = require('../whatsapp/src/autoReplyRules.js');
const { CONTACTED, DEAD, INQUIRY, NEGATIVE } = require('./leadStatuses');
const { findAccountsByPhone, findLeadsByPhone, isKnownPerson } = require('./leadPhone');
const { replyText } = require('./autoReplyContent');
const { enqueueWhatsApp } = require('./whatsappQueue');
const { ensureWonLead, isClient } = require('./wonLead');

// Every minute (index.js): turns recognised messages into a lead and a queued reply, as the admin's switches say.
// Never sends: the reply goes into the queue and waits its turn like every other message (whatsapp/src/sender.js).
const LOCK_ID = 'auto-reply-job';
const LOCK_MS = 120_000;
const BATCH = 50;
const SOURCE = 'WhatsApp ad';
const OFF_REASON = 'Not sent: Auto Reply replies were turned off.';
const UNSETTLED = ['pending', 'sending', 'failed']; // a failed reply can still be sent again by hand from Queue History
const TEAM_ROLES = ['admin', 'manager', 'developer'];
const IN_TRANSIT = ['pending', 'sending'];

const readSwitches = async () => {
  const state = await State.findById(STATE_ID).select('autoReply').lean();
  return { recognise: !!state?.autoReply?.recognise, sendReplies: !!state?.autoReply?.sendReplies, addLeads: !!state?.autoReply?.addLeads };
};

/** Turning replies off stops the ones still waiting too. A reply the sender has already claimed is left alone. */
async function cancelWaitingReplies() {
  const { modifiedCount } = await Queue.updateMany({ event: AUTO_REPLY_EVENT, status: 'pending' },
    { $set: { status: 'cancelled', lastError: OFF_REASON, expiresAt: finishedExpiry(new Date()) } });
  return modifiedCount;
}

const inquiryDetails = row => ({ inboxId: row._id, message: row.text, firstAt: row.sentAt, lastAt: row.sentAt, profileName: row.profileName || '' });
const dayLabel = date => new Date(date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

/** One remark per message, in one write with the lead's change, so a retry after a crash can't add it twice. */
async function addRemark(lead, row, { status = lead.status, cameBackFrom } = {}) {
  const note = `New WhatsApp ad message on ${dayLabel(row.sentAt)}: ${row.text}${cameBackFrom ? `\nCame back from ${cameBackFrom}.` : ''}`;
  const changes = { status };
  if (lead.deletedAt) Object.assign(changes, { deletedAt: null, deletedBy: null });
  if (lead.inquiry) changes['inquiry.lastAt'] = row.sentAt;
  else if (status === INQUIRY) changes.inquiry = inquiryDetails(row);
  const date = new Date();
  await Lead.updateOne({ _id: lead._id, 'followUps.inboxId': { $ne: row._id } },
    { $set: changes, $push: { followUps: { inboxId: row._id, note, badge: status, date, createdAt: date } } });
  await Inbox.updateOne({ _id: row._id }, { $set: { matchedLeadId: lead._id } });
}

/** A lead that came back ends its final message: no Dead later, and no decision waiting on the old reply. A message still in the queue is cancelled by finalMessageJobs.js. */
async function endFinalMessage(leadId) {
  await FinalMessage.updateMany({ leadId, status: { $in: ['waiting', 'dead'] } }, { $set: { status: 'stopped' } });
  await FinalMessage.updateMany({ leadId, status: 'replied', decision: null }, { $set: { decision: 'interested', decidedAt: new Date() } });
}

async function reopen(lead, row, cameBackFrom) {
  await endFinalMessage(lead._id);
  // A trashed Matured lead stays Matured: it belongs to a client.
  const status = lead.convertedToUserId ? lead.status : lead.name ? CONTACTED : INQUIRY;
  await addRemark(lead, row, { status, cameBackFrom });
}

/** A website member with no lead yet: the account's lead, as an offer reservation or plan request makes it. */
async function makeMemberLead(user, row) {
  try {
    return await Lead.create({
      name: user.name || user.email, email: user.email, phone: user.phone, source: SOURCE, reservationUserId: user._id,
      inquiry: inquiryDetails(row),
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    return Lead.findOne({ reservationUserId: user._id });
  }
}

/** Records the message on this person's one lead. Returns 'created' when a new lead was made, else 'updated'. */
async function recordKnownPerson(row, accounts) {
  const client = accounts.find(isClient);
  if (client) {
    await addRemark(await ensureWonLead(client), row);
    return 'updated';
  }
  const member = accounts.find(user => !user.deletedAt && !user.isGuest && user.roles?.includes('member'));
  const linked = member ? await Lead.findOne({ reservationUserId: member._id }) : null;
  const byPhone = await findLeadsByPhone(row.phone);
  const leads = linked && !byPhone.some(lead => String(lead._id) === String(linked._id)) ? [linked, ...byPhone] : byPhone;
  const live = leads.filter(lead => !lead.deletedAt);
  const active = live.find(lead => ![NEGATIVE, DEAD].includes(lead.status));
  if (active) {
    await addRemark(active, row);
    return 'updated';
  }
  if (live.length) {
    await reopen(live[0], row, live[0].status);
    return 'updated';
  }
  if (leads.length) {
    await reopen(leads[0], row, 'Trash');
    return 'updated';
  }
  if (member) {
    const lead = await makeMemberLead(member, row);
    await addRemark(lead, row);
    await Inbox.updateOne({ _id: row._id }, { $set: { leadId: lead._id }, $unset: { matchedLeadId: 1 } });
    return 'created';
  }
  await makeLead(row); // only a trashed client or a guest holds this number: their account stays as it is
  return 'created';
}

/** Someone the business already knows wrote from an ad: their lead notes it and they get the reply, whatever the stage. */
async function processKnownPerson(row, switches, rule) {
  const accounts = await findAccountsByPhone(row.phone);
  if (accounts.some(user => !user.deletedAt && !user.isGuest && user.roles?.some(role => TEAM_ROLES.includes(role)))) return 'team-number';
  const recorded = switches.addLeads ? await recordKnownPerson(row, accounts) : null;
  const replied = switches.sendReplies && !row.ourSideReplied ? await queueReply(row, rule) : false;
  if (recorded === 'created') return replied ? 'lead-and-reply' : 'lead-only';
  if (recorded) return replied ? 'updated-and-reply' : 'updated-only';
  return replied ? 'reply-only' : 'known-person';
}

async function makeLead(row) {
  // A crash after the create and before the row closed: this row's lead already exists.
  const existing = await Lead.findOne({ 'inquiry.inboxId': row._id }).select('_id').lean();
  const lead = existing || await Lead.create({
    phone: `+${row.phone}`, status: INQUIRY, source: SOURCE,
    inquiry: inquiryDetails(row),
  });
  await Inbox.updateOne({ _id: row._id }, { $set: { leadId: lead._id } });
  return lead._id;
}

async function queueReply(row, rule) {
  // One reply at a time: a second message while the first reply still waits adds no second one.
  const replyWaiting = await Queue.exists({ _id: { $ne: row._id }, to: row.phone, event: AUTO_REPLY_EVENT, status: { $in: IN_TRANSIT } });
  if (replyWaiting) return false;
  const text = row.replyText || replyText(rule);
  // Saved first, so a crash retries with the same words and our own message can find it.
  await Inbox.updateOne({ _id: row._id }, { $set: { replyText: text, replyStatus: 'pending' } });
  try {
    await enqueueWhatsApp({ _id: row._id, to: row.phone, text, event: AUTO_REPLY_EVENT, application: 'website' });
  } catch (error) { if (error.code !== 11000) throw error; }
  return true;
}

async function processRow(row, switches, rule) {
  if (!switches.recognise) return 'switched-off';
  let known = row.personKnown;
  if (known === undefined || known === null) {
    known = await isKnownPerson(row.phone);
    await Inbox.updateOne({ _id: row._id }, { $set: { personKnown: known } });
  }
  if (known) return processKnownPerson(row, switches, rule);
  const lead = switches.addLeads ? await makeLead(row) : null;
  // A message from our side stops the reply, not the lead: the person still wrote in.
  const replied = switches.sendReplies && !row.ourSideReplied ? await queueReply(row, rule) : false;
  if (lead && replied) return 'lead-and-reply';
  if (lead) return 'lead-only';
  if (replied) return 'reply-only';
  return 'detected-only';
}

/** Copies each reply's result from the queue, which forgets it after 30 days. */
async function copyReplyResults() {
  for (const row of await Inbox.find({ replyStatus: { $in: UNSETTLED } }).select('_id').lean()) {
    const queued = await Queue.findById(row._id).select('status').lean();
    // No queue row: a crash before it was added is finished by processRow; only a closed row has lost its reply.
    if (queued) await Inbox.updateOne({ _id: row._id }, { $set: { replyStatus: queued.status } });
    else await Inbox.updateOne({ _id: row._id, status: 'closed' }, { $set: { replyStatus: 'expired' } });
  }
}

async function processInbox() {
  if (process.env.ENABLE_WHATSAPP !== 'true') return { reason: 'disabled', closed: 0 };
  const owner = crypto.randomUUID();
  const time = new Date();
  try {
    await Lock.updateOne({ _id: LOCK_ID, $or: [{ expiresAt: { $lte: time } }, { owner }] }, { $set: { owner, expiresAt: new Date(time.getTime() + LOCK_MS) } }, { upsert: true });
  } catch (error) { if (error.code === 11000) return { reason: 'busy', closed: 0 }; throw error; }
  let closed = 0;
  try {
    for (const { _id } of await Inbox.find({ status: 'new' }).sort({ createdAt: 1 }).limit(BATCH).select('_id').lean()) {
      try {
        // Read fresh for each row: the admin's switch or our own message may have just changed things.
        const [row, state, rule] = await Promise.all([Inbox.findById(_id).lean(), readSwitches(), Rule.findOne({ key: RULE_KEY }).lean()]);
        const outcome = await processRow(row, state, rule);
        await Inbox.updateOne({ _id, status: 'new' }, { $set: { status: 'closed', outcome } });
        closed += 1;
        // Either of these can happen while the reply is on its way into the queue, too late for the check above.
        const [after, now] = await Promise.all([Inbox.findById(_id).select('ourSideReplied replyStatus').lean(), readSwitches()]);
        if (after.replyStatus === 'pending' && (after.ourSideReplied || !now.sendReplies || !now.recognise)) {
          await Queue.updateOne({ _id, status: 'pending' }, { $set: { status: 'cancelled', lastError: after.ourSideReplied ? OUR_SIDE_REPLIED : OFF_REASON, expiresAt: finishedExpiry(new Date()) } });
        }
      } catch (error) {
        console.error('[auto reply] could not process a message, will try again:', error.message); // the row stays new
      }
    }
    await copyReplyResults();
    return { reason: 'done', closed };
  } finally {
    await Lock.updateOne({ _id: LOCK_ID, owner }, { $set: { expiresAt: new Date(0) } });
  }
}

module.exports = { processInbox, cancelWaitingReplies, SOURCE };
