const Lead = require('../models/leadModel');
const userModel = require('../models/userModel');
const { FinalMessage, State, STATE_ID } = require('../whatsapp/src/models.js');
const { EmailDraft } = require('../models/emailControlModel');
const { NEGATIVE } = require('./leadStatuses');
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

module.exports = { EVENT, DEFAULT_HOURS, MIN_HOURS, MAX_HOURS, CAN_SEND_AGAIN, readHours, pendingLeads, prepareFor };
