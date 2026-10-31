const Lead = require('../models/leadModel');
const userModel = require('../models/userModel');
const { FinalMessage, State, STATE_ID } = require('../whatsapp/src/models.js');
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
async function pendingLeads() {
  const [leads, rows, clients] = await Promise.all([
    Lead.find({ status: NEGATIVE, deletedAt: null, convertedToUserId: null, requestedByUserId: null }).sort({ _id: 1 }).lean(),
    FinalMessage.find().lean(), clientPhones(),
  ]);
  return leads.filter(lead => [null, 'in-review'].includes(blockedReason(lead, rows, clients)));
}

/** Prepares this lead's message in the current request, so the portal opens the popup. Returns 'prepared' or the reason it didn't. */
async function prepareFor(lead) {
  const [rows, clients] = await Promise.all([FinalMessage.find({ $or: [{ leadId: lead._id }, ...(normalizePhone(lead.phone) ? [{ phone: normalizePhone(lead.phone) }] : [])] }).lean(), clientPhones()]);
  const reason = blockedReason(lead, rows, clients);
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
  await FinalMessage.updateOne({ leadId: lead._id },
    { $set: { phone: normalizePhone(lead.phone), draftId, hours, status: 'review' }, $unset: { sentAt: 1, deadlineAt: 1 } }, { upsert: true });
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
  interested: { status: CONTACTED, note: 'Reply reviewed: interested. Moved to Contacted.' },
  dead: { status: DEAD, note: 'Reply reviewed: moved to Dead.' },
  keep: { status: NEGATIVE, note: 'Reply reviewed: kept in Negative.' },
};

/** The admin's answer to a real reply. Changes only the lead's stage and timeline: nothing is sent, and nothing enters the queue. */
async function decideReply(id, choice, userId) {
  const chosen = Object.prototype.hasOwnProperty.call(CHOICES, choice) ? CHOICES[choice] : null;
  if (!chosen) fail('Choose Interested, Mark Dead or Keep Negative.');
  const row = await FinalMessage.findOne({ _id: id, status: 'replied', decision: null }).lean();
  if (!row) fail('This reply has already been decided.', 409);
  const lead = await Lead.findById(row.leadId).select('name status deletedAt').lean();
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

module.exports = { EVENT, DEFAULT_HOURS, MIN_HOURS, MAX_HOURS, CAN_SEND_AGAIN, readHours, readIgnored, saveIgnored, decideReply, pendingLeads, prepareFor };
