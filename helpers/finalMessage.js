const Lead = require('../models/leadModel');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const userModel = require('../models/userModel');
const { FinalMessage, Lock, State, STATE_ID } = require('../whatsapp/src/models.js');
const { EmailDraft } = require('../models/emailControlModel');
const { DEFAULT_IGNORED_REPLIES, MAX_IGNORED_LENGTH, MAX_IGNORED_REPLIES, replyWords } = require('../whatsapp/src/finalMessageReplies.js');
const { CONTACTED, DEAD, NEGATIVE } = require('./leadStatuses');
const { findLeadsByPhone } = require('./leadPhone');
const { hasConfirmedName } = require('./leadName');
const { isAccountEmail } = require('./emailValidator');
const { normalizePhone } = require('./whatsappQueue');
const { prepareTemplatedMail } = require('./emailService');
const { registerReviewDraft, unregisterReviewDraft } = require('./emailController');
const { clientReadiness } = require('./clientFinalMessageReadiness');
const { isRunning } = require('./finalMessageCycle');
const { cycleNumbers, onNumber } = require('./finalMessageCopies');

// The last message to a Negative lead. It goes through the normal review popup and template (action lead.finalMessage),
// so the admin chooses Send or Don't Send, and the channel. The job (finalMessageJobs.js) follows what happened next.
const EVENT = 'lead.finalMessage';
const DEFAULT_HOURS = 24;
const MIN_HOURS = 1;
const MAX_HOURS = 720;
const CAN_SEND_AGAIN = ['not-sent'];
const clientAutomationEnabled = () => process.env.CLIENT_FINAL_MESSAGE_ENABLED === 'true';
const isClientRow = row => row?.subjectKind === 'client';

// Check the account and the canonical lead on every action, not just at preparation.
async function clientEligible(lead, row) {
  return (await clientReadiness(lead, row)).ready;
}

const readHours = async () => (await State.findById(STATE_ID).select('finalMessage').lean())?.finalMessage?.hours || DEFAULT_HOURS;

async function clientPhones() {
  const users = await userModel.find({ roles: 'customer', deletedAt: null, isGuest: { $ne: true }, phone: { $nin: ['', null] } }).select('phone').lean();
  return new Set(users.map(user => normalizePhone(user.phone)).filter(Boolean));
}

// A client's own project request is a lead too, and may be marked Negative: the final message is not for clients.
const isOpenNegative = lead => lead.status === NEGATIVE && !lead.deletedAt && !lead.convertedToUserId && !lead.requestedByUserId;
const reachable = lead => !!normalizePhone(lead.phone) || isAccountEmail(lead.email);

/** Why this lead can't get the message now, or null. `rows` = every final message row; `clients` = clientPhones().
 *  A finished cycle allows a new one for this lead (finalMessageCycle.js); the Leads button keeps to people never messaged. */
function blockedReason(lead, rows, clients, { allowFinished = false } = {}) {
  if (!isOpenNegative(lead)) return 'not-negative';
  if (!reachable(lead)) return 'unreachable';
  const phone = normalizePhone(lead.phone);
  if (phone && clients.has(phone)) return 'client';
  const blocks = row => (allowFinished ? isRunning(row) : !CAN_SEND_AGAIN.includes(row.status));
  const own = rows.find(row => String(row.leadId) === String(lead._id));
  if (own && blocks(own)) return own.status === 'review' ? 'in-review' : 'already-sent';
  const samePerson = phone && rows.find(row => cycleNumbers(row).includes(phone) && String(row.leadId) !== String(lead._id) && blocks(row));
  return samePerson ? 'already-sent' : null;
}

/** The Negative leads a tap would prepare a message for, and those whose earlier message still waits for a decision. */
async function pendingLeads(fields = null) {
  const [leads, rows, clients] = await Promise.all([
    Lead.find({ status: NEGATIVE, deletedAt: null, convertedToUserId: null, requestedByUserId: null }).select(fields).sort({ _id: 1 }).lean(),
    FinalMessage.find().select(fields ? 'leadId phone altPhone sends.phone status' : null).lean(), clientPhones(),
  ]);
  return leads.filter(lead => [null, 'in-review'].includes(blockedReason(lead, rows, clients)));
}

async function pendingClients() {
  if (!clientAutomationEnabled()) return [];
  // One row per client: their lead as clientLeadFor picks it (readiness still refuses a client with two live leads).
  const sorted = await Lead.find({ status: 'Won', clientBehaviour: NEGATIVE, convertedToUserId: { $ne: null }, deletedAt: null }).sort(require('./wonLead').CLIENT_LEAD_ORDER).lean();
  const seenClients = new Set();
  const leads = sorted.filter(lead => !seenClients.has(String(lead.convertedToUserId)) && seenClients.add(String(lead.convertedToUserId)));
  const phones = leads.map(lead => normalizePhone(lead.phone)).filter(Boolean);
  const rows = await FinalMessage.find({ $or: [{ leadId: { $in: leads.map(lead => lead._id) } }, { phone: { $in: phones } }, { altPhone: { $in: phones } }, { 'sends.phone': { $in: phones } }] }).lean();
  const result = [];
  for (const lead of leads) {
    if (!await clientEligible(lead)) continue;
    const own = rows.find(row => String(row.leadId) === String(lead._id));
    const other = rows.find(row => String(row.leadId) !== String(lead._id) && cycleNumbers(row).includes(normalizePhone(lead.phone)) && isRunning(row));
    if (other) continue;
    if (!own || (isClientRow(own) && ['review', 'not-sent'].includes(own.status)) || (!isClientRow(own) && ['dead', 'stopped', 'not-sent', 'email-only'].includes(own.status))) result.push(lead);
  }
  return result;
}

/** Why a final message can't start for this person now, or null. The lead page shows Start final message only on null. */
async function startBlocker(lead) {
  const phone = normalizePhone(lead.phone);
  const rows = await FinalMessage.find({ $or: [{ leadId: lead._id }, ...(phone ? onNumber(phone).$or : [])] }).lean();
  if (!lead.convertedToUserId) return blockedReason(lead, rows, await clientPhones(), { allowFinished: true });
  if (lead.deletedAt || lead.clientBehaviour !== NEGATIVE) return 'not-negative';
  if (!(await require('./clientFinalMessageReadiness').clientStartReadiness(lead)).ready) return 'client-ineligible';
  const own = rows.find(row => String(row.leadId) === String(lead._id));
  if (own?.status === 'review') return 'in-review';
  return isRunning(own) || rows.some(row => String(row.leadId) !== String(lead._id) && isRunning(row)) ? 'already-sent' : null;
}

/** Prepares this lead's message in the current request, so the portal opens the popup. Returns 'prepared' or the reason it didn't. */
async function prepareFor(lead, options = {}) {
  if (!lead.convertedToUserId) return prepareForUnlocked(lead, options);
  const owner = crypto.randomUUID();
  const now = new Date();
  const key = `client-final-message:${lead._id}`;
  try {
    await Lock.updateOne({ _id: key, $or: [{ expiresAt: { $lte: now } }, { owner }] }, { $set: { owner, expiresAt: new Date(now.getTime() + 120000) } }, { upsert: true });
  } catch (error) {
    if (error.code === 11000) return 'in-review';
    throw error;
  }
  try {
    const current = await Lead.findById(lead._id).lean();
    return current ? await prepareForUnlocked(current, options) : 'client-ineligible';
  } finally {
    await Lock.updateOne({ _id: key, owner }, { $set: { expiresAt: new Date(0) } });
  }
}

/**
 * The alternate number this cycle also goes to (signup.md §3.9), or null: alternate sending is on, the number is
 * usable and not the main one, it is not blocked, and no other person's cycle is running on it.
 */
async function cycleAltPhone(lead) {
  const { altSendingEnabled, usableAlt } = require('./contactNumbers');
  const alt = altSendingEnabled() && normalizePhone(lead.phone) ? usableAlt(lead.altPhone, lead.phone) : null;
  if (!alt) return null;
  const { contactBlocks, numberBlock } = require('./leadContactBlock');
  if (numberBlock(alt, await contactBlocks())) return null;
  const others = await FinalMessage.find({ leadId: { $ne: lead._id }, ...onNumber(alt) }).lean();
  return others.some(isRunning) ? null : alt;
}

// Same rule for leads and clients: a running cycle blocks a new one, a finished one is kept in episodeHistory.
async function prepareForUnlocked(lead) {
  const client = Boolean(lead.convertedToUserId);
  if (client && !await clientEligible(lead)) return 'client-ineligible';
  // A cycle that no longer matches this person (moved, converted, phone changed) ends first, with its reason.
  if (await require('./finalMessageCycle').reconcileCycle(lead._id) === 'pending') return 'already-sent';
  const [rows, clients] = await Promise.all([FinalMessage.find({ $or: [{ leadId: lead._id }, ...(normalizePhone(lead.phone) ? onNumber(normalizePhone(lead.phone)).$or : [])] }).lean(), clientPhones()]);
  const own = rows.find(row => String(row.leadId) === String(lead._id));
  const other = rows.find(row => String(row.leadId) !== String(lead._id) && cycleNumbers(row).includes(normalizePhone(lead.phone)) && isRunning(row));
  const reason = client
    ? (other ? 'already-sent' : own?.status === 'review' ? 'in-review' : isRunning(own) ? 'already-sent' : null)
    : blockedReason(lead, rows, clients, { allowFinished: true });
  if (reason === 'in-review') {
    // Closed without a decision, or the page was left: the same draft opens again.
    const draft = await EmailDraft.findById(own.draftId).lean();
    if (client && (!draft || draft.expiresAt <= new Date() || draft.status === 'skipped')) {
      await FinalMessage.updateOne({ _id: own._id, draftId: own.draftId, status: 'review' }, { $set: { status: 'not-sent' } });
      return prepareForUnlocked(lead);
    }
    return draft && registerReviewDraft(draft) ? 'prepared' : 'in-review';
  }
  if (reason) return reason;
  const hours = await readHours();
  const email = isAccountEmail(lead.email) ? lead.email : '';
  let dedupeKey = client ? `client-final:${lead._id}:${lead.clientBehaviourRevision || 0}:${own?.draftId || 'first'}` : undefined;
  if (client) {
    let previous = await EmailDraft.findOne({ dedupeKey }).lean();
    while (previous && (previous.status === 'skipped' || previous.expiresAt <= new Date())) {
      if (['sent', 'sending', 'queued'].includes(previous.status)) return 'already-sent';
      dedupeKey += `:retry:${previous._id}`;
      previous = await EmailDraft.findOne({ dedupeKey }).lean();
    }
  }
  const altPhone = await cycleAltPhone(lead);
  const cycleStartedAt = new Date();
  const { draftId } = await prepareTemplatedMail(EVENT, lead, email, hours, { dedupeKey });
  if (!draftId) return 'unavailable';
  const draft = client ? await EmailDraft.findById(draftId).lean() : null;
  const promisedHours = Number.parseInt(draft?.values?.timeLimit, 10) || hours;
  const old = own && own.status !== 'not-sent' ? Object.fromEntries(Object.entries(own).filter(([key]) => !['_id', '__v', 'episodeHistory'].includes(key))) : null;
  const update = { $set: { phone: normalizePhone(lead.phone), altPhone, draftId, cycleStartedAt, hours, status: 'review', expiryEnabled: true, ...(client ? { subjectKind: 'client', clientId: lead.convertedToUserId, behaviourRevision: lead.clientBehaviourRevision || 0, episodeId: crypto.randomUUID() } : {}) }, $unset: { sends: 1, sentAt: 1, deadlineAt: 1, expiryQueuedAt: 1, originalMessage: 1, stoppedAt: 1, stopReason: 1, stoppedBy: 1, stopSource: 1, outboundChecks: 1, lastReplyAt: 1, lastReplyText: 1, replySeenAt: 1, lastIgnoredAt: 1, lastIgnoredText: 1, ignoredNotedAt: 1, decision: 1, decidedAt: 1, decidedBy: 1 }, ...(old ? { $push: { episodeHistory: old } } : {}) };
  if (client) update.$set.hours = promisedHours;
  try {
    if (client) {
      const current = await Lead.findById(lead._id).lean();
      if (!await clientEligible(current) || (current.clientBehaviourRevision || 0) !== (lead.clientBehaviourRevision || 0)) {
        unregisterReviewDraft(draftId);
        return 'client-ineligible';
      }
      const guard = own ? { _id: own._id, draftId: own.draftId, status: own.status } : { leadId: lead._id, draftId: { $exists: false } };
      const saved = await FinalMessage.updateOne(guard, update, { upsert: !own });
      if (!saved.modifiedCount && !saved.upsertedCount) { unregisterReviewDraft(draftId); return 'in-review'; }
    } else {
      const guard = own ? require('./stopFinalMessage').cycleGuard(own) : { leadId: lead._id, draftId: { $exists: false } };
      const saved = await FinalMessage.updateOne(guard, update, { upsert: !own });
      if (!saved.modifiedCount && !saved.upsertedCount) { unregisterReviewDraft(draftId); return 'in-review'; }
    }
  } catch (error) {
    if (client) unregisterReviewDraft(draftId);
    if (client && error.code === 11000) return 'in-review';
    throw error;
  }
  if (draft) registerReviewDraft(draft);
  return 'prepared';
}

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const readIgnored = async () => (await State.findById(STATE_ID).select('finalMessage').lean())?.finalMessage?.ignoredReplies ?? DEFAULT_IGNORED_REPLIES;

async function saveIgnored(list) {
  if (!Array.isArray(list) || list.some(entry => typeof entry !== 'string')) fail('Send the list of messages.');
  const seen = new Set();
  const clean = list.map(entry => entry.trim()).filter(entry => {
    const words = replyWords(entry);
    if (!words || seen.has(words)) return false;
    seen.add(words);
    return true;
  });
  if (clean.length > MAX_IGNORED_REPLIES) fail(`Keep the list to ${MAX_IGNORED_REPLIES} messages.`);
  if (clean.some(entry => entry.length > MAX_IGNORED_LENGTH)) fail(`Keep each message under ${MAX_IGNORED_LENGTH} letters.`);
  await State.updateOne({ _id: STATE_ID }, { $set: { 'finalMessage.ignoredReplies': clean } }, { upsert: true });
  return clean;
}

const lineWith = (note, status, userId) => ({ note, badge: status, date: new Date(), createdAt: new Date(), createdBy: userId });
const CHOICES = {
  interested: { status: CONTACTED, note: 'Reply reviewed: interested. Moved to Neutral.' },
  dead: { status: DEAD, note: 'Reply reviewed: moved to Dead.' },
  keep: { status: NEGATIVE, note: 'Reply reviewed: kept in Negative.' },
};

/** The admin's answer to a real reply. Changes only the lead's stage and timeline: nothing is sent, and nothing enters the queue. */
async function decideReply(id, choice, userId) {
  const chosen = Object.prototype.hasOwnProperty.call(CHOICES, choice) ? CHOICES[choice] : null;
  if (!chosen) fail('Choose Interested, Mark Dead or Keep Negative.');
  const row = await FinalMessage.findOne({ _id: id, status: 'replied', decision: null }).lean();
  if (!row) fail('This reply has already been decided.', 409);
  const lead = await Lead.findById(row.leadId).lean();
  if (isClientRow(row)) {
    if (!await clientEligible(lead, row)) fail('This client or their behaviour has changed. Open the client in Leads.', 409);
    await mongoose.connection.transaction(async session => {
      const claimed = await FinalMessage.updateOne({ _id: row._id, status: 'replied', episodeId: row.episodeId, decision: null }, { $set: { decision: choice, decidedAt: new Date(), decidedBy: userId } }, { session });
      if (!claimed.modifiedCount) fail('This reply has already been decided.', 409);
      const changed = await Lead.updateOne({ _id: lead._id, deletedAt: null, convertedToUserId: row.clientId, status: 'Won', clientBehaviour: NEGATIVE, clientBehaviourRevision: row.behaviourRevision ? row.behaviourRevision : { $in: [null, 0] } }, { $set: { clientBehaviour: chosen.status }, $inc: { clientBehaviourRevision: 1 }, $push: { followUps: lineWith(chosen.note, lead.status, userId) } }, { session });
      if (!changed.modifiedCount) fail('This client changed. Refresh and try again.', 409);
    });
    return { status: chosen.status };
  }
  if (!lead || lead.deletedAt || lead.status !== NEGATIVE) fail('This lead has moved out of Negative. Open it in Leads.', 409);
  if (chosen.status === CONTACTED && !hasConfirmedName(lead)) fail("Add this lead's name first: use Edit Lead.");
  const { modifiedCount } = await FinalMessage.updateOne({ _id: row._id, decision: null }, { $set: { decision: choice, decidedAt: new Date(), decidedBy: userId } });
  if (!modifiedCount) fail('This reply has already been decided.', 409);
  // Dead covers every Negative lead with this number, as the job does: another would stay in Broadcast's Negative group.
  const others = choice === 'dead' && row.phone ? await findLeadsByPhone(row.phone, { status: NEGATIVE, deletedAt: null, convertedToUserId: null }) : [];
  const ids = [...new Set([String(row.leadId), ...others.map(other => String(other._id))])];
  await Lead.updateMany({ _id: { $in: ids }, status: NEGATIVE }, { $set: { status: chosen.status }, $push: { followUps: lineWith(chosen.note, chosen.status, userId) } });
  return { status: chosen.status };
}

module.exports = { EVENT, DEFAULT_HOURS, MIN_HOURS, MAX_HOURS, CAN_SEND_AGAIN, readHours, readIgnored, saveIgnored, decideReply, pendingLeads, pendingClients, prepareFor, startBlocker, clientEligible, clientAutomationEnabled, isClientRow };
