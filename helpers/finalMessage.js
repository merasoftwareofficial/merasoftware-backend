const Lead = require('../models/leadModel');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const userModel = require('../models/userModel');
const { FinalMessage, Lock, State, STATE_ID } = require('../whatsapp/src/models.js');
const { EmailDraft } = require('../models/emailControlModel');
const { DEFAULT_IGNORED_REPLIES, MAX_IGNORED_LENGTH, MAX_IGNORED_REPLIES, replyWords } = require('../whatsapp/src/finalMessageReplies.js');
const { CONTACTED, DEAD, NEGATIVE } = require('./leadStatuses');
const { findLeadsByPhone } = require('./leadPhone');
const { isAccountEmail } = require('./emailValidator');
const { normalizePhone } = require('./whatsappQueue');
const { prepareTemplatedMail } = require('./emailService');
const { registerReviewDraft } = require('./emailController');

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
  if (!clientAutomationEnabled() || !lead || lead.deletedAt || lead.status !== 'Won' || !lead.convertedToUserId || lead.clientBehaviour !== NEGATIVE) return false;
  if (row && (String(row.clientId) !== String(lead.convertedToUserId) || (row.behaviourRevision || 0) !== (lead.clientBehaviourRevision || 0) || (row.phone && normalizePhone(lead.phone) !== row.phone))) return false;
  const [account, links] = await Promise.all([
    userModel.findOne({ _id: lead.convertedToUserId, roles: 'customer', deletedAt: null, isGuest: { $ne: true } }).select('phone').lean(),
    Lead.countDocuments({ convertedToUserId: lead.convertedToUserId, deletedAt: null }),
  ]);
  if (!account || links !== 1) return false;
  const phone = normalizePhone(lead.phone);
  if (!phone || normalizePhone(account.phone) !== phone) return false;
  const accounts = await userModel.find({ roles: 'customer', deletedAt: null, isGuest: { $ne: true }, phone: { $nin: ['', null] } }).select('phone').lean();
  return accounts.filter(user => normalizePhone(user.phone) === phone).length === 1;
}

const readHours = async () => (await State.findById(STATE_ID).select('finalMessage').lean())?.finalMessage?.hours || DEFAULT_HOURS;

async function clientPhones() {
  const users = await userModel.find({ roles: 'customer', deletedAt: null, isGuest: { $ne: true }, phone: { $nin: ['', null] } }).select('phone').lean();
  return new Set(users.map(user => normalizePhone(user.phone)).filter(Boolean));
}

// A client's own project request is a lead too, and may be marked Negative: the final message is not for clients.
const isOpenNegative = lead => lead.status === NEGATIVE && !lead.deletedAt && !lead.convertedToUserId && !lead.requestedByUserId;
const reachable = lead => !!normalizePhone(lead.phone) || isAccountEmail(lead.email);

/** Why this lead can't get the message now, or null. `rows` = every final message row; `clients` = clientPhones(). */
function blockedReason(lead, rows, clients) {
  if (!isOpenNegative(lead)) return 'not-negative';
  if (!reachable(lead)) return 'unreachable';
  const phone = normalizePhone(lead.phone);
  if (phone && clients.has(phone)) return 'client';
  const own = rows.find(row => String(row.leadId) === String(lead._id));
  if (own && !CAN_SEND_AGAIN.includes(own.status)) return own.status === 'review' ? 'in-review' : 'already-sent';
  const samePerson = phone && rows.find(row => row.phone === phone && String(row.leadId) !== String(lead._id) && !CAN_SEND_AGAIN.includes(row.status));
  return samePerson ? 'already-sent' : null;
}

/** The Negative leads a tap would prepare a message for, and those whose earlier message still waits for a decision. */
async function pendingLeads(fields = null) {
  const [leads, rows, clients] = await Promise.all([
    Lead.find({ status: NEGATIVE, deletedAt: null, convertedToUserId: null, requestedByUserId: null }).select(fields).sort({ _id: 1 }).lean(),
    FinalMessage.find().select(fields ? 'leadId phone status' : null).lean(), clientPhones(),
  ]);
  return leads.filter(lead => [null, 'in-review'].includes(blockedReason(lead, rows, clients)));
}

async function pendingClients() {
  if (!clientAutomationEnabled()) return [];
  const leads = await Lead.find({ status: 'Won', clientBehaviour: NEGATIVE, convertedToUserId: { $ne: null }, deletedAt: null }).sort({ _id: 1 }).lean();
  const phones = leads.map(lead => normalizePhone(lead.phone)).filter(Boolean);
  const rows = await FinalMessage.find({ $or: [{ leadId: { $in: leads.map(lead => lead._id) } }, { phone: { $in: phones } }] }).lean();
  const result = [];
  for (const lead of leads) {
    if (!await clientEligible(lead)) continue;
    const own = rows.find(row => String(row.leadId) === String(lead._id));
    const other = rows.find(row => String(row.leadId) !== String(lead._id) && row.phone === normalizePhone(lead.phone) && ['review', 'queued', 'waiting', 'replied'].includes(row.status));
    if (other) continue;
    if (!own || (isClientRow(own) && ['review', 'not-sent'].includes(own.status)) || (!isClientRow(own) && ['dead', 'stopped', 'not-sent', 'email-only'].includes(own.status))) result.push(lead);
  }
  return result;
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

async function prepareForUnlocked(lead, { newEpisode = false } = {}) {
  const [rows, clients] = await Promise.all([FinalMessage.find({ $or: [{ leadId: lead._id }, ...(normalizePhone(lead.phone) ? [{ phone: normalizePhone(lead.phone) }] : [])] }).lean(), clientPhones()]);
  const client = Boolean(lead.convertedToUserId);
  if (client && !await clientEligible(lead)) return 'client-ineligible';
  const own = rows.find(row => String(row.leadId) === String(lead._id));
  const other = rows.find(row => String(row.leadId) !== String(lead._id) && row.phone === normalizePhone(lead.phone) && ['review', 'queued', 'waiting', 'replied'].includes(row.status));
  const oldActive = own && !isClientRow(own) && ['review', 'queued', 'waiting', 'replied'].includes(own.status);
  const resolved = isClientRow(own) && (['dead', 'stopped', 'email-only'].includes(own.status) || (own.status === 'replied' && own.decision));
  const reason = client ? (other || oldActive ? 'already-sent' : isClientRow(own) && own.status === 'review' ? 'in-review' : isClientRow(own) && !CAN_SEND_AGAIN.includes(own.status) && !(newEpisode && resolved) ? 'already-sent' : null) : blockedReason(lead, rows, clients);
  if (reason === 'in-review') {
    // Closed without a decision, or the page was left: the same draft opens again.
    const own = rows.find(row => String(row.leadId) === String(lead._id));
    const draft = await EmailDraft.findById(own.draftId).lean();
    return draft && registerReviewDraft(draft) ? 'prepared' : 'in-review';
  }
  if (reason) return reason;
  const hours = await readHours();
  const email = isAccountEmail(lead.email) ? lead.email : '';
  const { draftId } = await prepareTemplatedMail(EVENT, lead, email, hours);
  if (!draftId) return 'unavailable';
  const old = own && client && (!isClientRow(own) || (newEpisode && resolved)) ? Object.fromEntries(Object.entries(own).filter(([key]) => !['_id', '__v', 'episodeHistory'].includes(key))) : null;
  const update = { $set: { phone: normalizePhone(lead.phone), draftId, hours, status: 'review', expiryEnabled: true, ...(client ? { subjectKind: 'client', clientId: lead.convertedToUserId, behaviourRevision: lead.clientBehaviourRevision || 0, episodeId: crypto.randomUUID() } : {}) }, $unset: { sentAt: 1, deadlineAt: 1, expiryQueuedAt: 1, originalMessage: 1, lastReplyAt: 1, lastReplyText: 1, replySeenAt: 1, lastIgnoredAt: 1, lastIgnoredText: 1, ignoredNotedAt: 1, decision: 1, decidedAt: 1, decidedBy: 1 }, ...(old ? { $push: { episodeHistory: old } } : {}) };
  await FinalMessage.updateOne({ leadId: lead._id }, update, { upsert: true });
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
  if (chosen.status === CONTACTED && !lead.name) fail("Add this lead's name first: use Edit Lead.");
  const { modifiedCount } = await FinalMessage.updateOne({ _id: row._id, decision: null }, { $set: { decision: choice, decidedAt: new Date(), decidedBy: userId } });
  if (!modifiedCount) fail('This reply has already been decided.', 409);
  // Dead covers every Negative lead with this number, as the job does: another would stay in Broadcast's Negative group.
  const others = choice === 'dead' && row.phone ? await findLeadsByPhone(row.phone, { status: NEGATIVE, deletedAt: null, convertedToUserId: null }) : [];
  const ids = [...new Set([String(row.leadId), ...others.map(other => String(other._id))])];
  await Lead.updateMany({ _id: { $in: ids }, status: NEGATIVE }, { $set: { status: chosen.status }, $push: { followUps: lineWith(chosen.note, chosen.status, userId) } });
  return { status: chosen.status };
}

module.exports = { EVENT, DEFAULT_HOURS, MIN_HOURS, MAX_HOURS, CAN_SEND_AGAIN, readHours, readIgnored, saveIgnored, decideReply, pendingLeads, pendingClients, prepareFor, clientEligible, clientAutomationEnabled, isClientRow };
