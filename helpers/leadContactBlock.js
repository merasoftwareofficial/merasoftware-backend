const Lead = require('../models/leadModel');
const userModel = require('../models/userModel');
const { EmailDraft } = require('../models/emailControlModel');
const { FinalMessage, Queue } = require('../whatsapp/src/models.js');
const { DEAD, NEGATIVE, NO_MARKETING_STATUSES, WRONG } = require('./leadStatuses');
const { phoneKey, leadPhoneKeys } = require('./leadPhone');

// The one answer to "may we market to this person?". It goes by phone number, so a second lead with the same
// number can't get round it. Broadcast, offer targets, Send message and the proposal message ask here. Service
// messages (projects, invoices, payments) and Auto Reply answering someone who wrote first don't: they never ask.
const MESSAGES = {
  dead: 'This lead is Dead, so it gets no messages. Change its stage first if this person should hear from you again.',
  wrong: 'This lead is marked Wrong, so it gets no messages. Change its stage first if that was a mistake.',
  'client-dead': "This client's behaviour is Dead, so they get no marketing messages. Change it first if they should hear from you again.",
  'final-message': 'The final message countdown is running for this person, so nothing else goes until it ends.',
  'needs-decision': 'This person replied to the final message. Decide on the reply in Communication first.',
};
const LABELS = { dead: 'Dead', wrong: 'Wrong', 'client-dead': 'Client behaviour: Dead', 'final-message': 'Final message: countdown', 'needs-decision': 'Final message: reply needs a decision' };
const MARKETING_EVENTS = ['lead.message', 'lead.created', 'lead.proposal', 'lead.finalMessage'];

/** Which reviews the admin has pressed Send on, in one read however many there are. A row stays `review` until the minute job runs, and an email-only send starts no countdown. */
async function reviewsSent(rows) {
  const reviews = rows.filter(row => row.status === 'review');
  if (!reviews.length) return { pressed: new Set(), unlinked: false };
  const ids = reviews.map(row => row.draftId).filter(Boolean);
  // A row with no draft keeps its old answer: any queue row with no draft link counts for it.
  const [queued, drafts, unlinked] = await Promise.all([
    Queue.find({ emailDraftId: { $in: ids }, status: { $in: ['pending', 'sending', 'sent'] } }).select('emailDraftId').lean(),
    EmailDraft.find({ _id: { $in: ids } }).select('status delivery').lean(),
    ids.length < reviews.length ? Queue.exists({ emailDraftId: null, status: { $in: ['pending', 'sending', 'sent'] } }) : null,
  ]);
  const pressed = new Set(queued.map(row => String(row.emailDraftId)));
  for (const draft of drafts) {
    if (!['sending', 'sent', 'queued'].includes(draft.status)) continue;
    const channels = draft.delivery?.channels;
    if (channels?.length ? channels.includes('whatsapp') : true) pressed.add(String(draft._id));
  }
  return { pressed, unlinked: Boolean(unlinked) };
}

/**
 * Every blocked number: phone key → reason. A client's number is decided by the client's behaviour alone.
 * A blocked lead blocks its alternate number too, so a Dead or Wrong person can't be reached there instead.
 */
async function contactBlocks() {
  const blocks = new Map();
  const [clients, deadClients, closed, rows] = await Promise.all([
    userModel.find({ roles: 'customer', deletedAt: null, isGuest: { $ne: true }, phone: { $nin: ['', null] } }).select('phone').lean(),
    Lead.find({ clientBehaviour: DEAD, convertedToUserId: { $ne: null }, deletedAt: null }).select('phone altPhone convertedToUserId').lean(),
    // Trashed ones count too. A client's own project request lead doesn't speak for the client.
    Lead.find({ status: { $in: NO_MARKETING_STATUSES }, requestedByUserId: null, $or: [{ phone: { $nin: ['', null] } }, { altPhone: { $nin: ['', null] } }] }).select('phone altPhone status').lean(),
    FinalMessage.find({ $or: [{ status: { $in: ['review', 'queued', 'waiting'] } }, { status: 'replied', decision: null }] }).lean(),
  ]);
  const clientKeys = new Set(clients.map(user => phoneKey(user.phone)).filter(Boolean));

  const deadIds = new Set(deadClients.map(lead => String(lead.convertedToUserId)));
  for (const lead of deadClients) for (const key of leadPhoneKeys(lead)) blocks.set(key, 'client-dead');
  for (const user of clients) if (deadIds.has(String(user._id))) blocks.set(phoneKey(user.phone), 'client-dead');

  for (const lead of closed) {
    for (const key of leadPhoneKeys(lead)) if (!clientKeys.has(key)) blocks.set(key, lead.status === WRONG ? 'wrong' : 'dead');
  }

  if (!rows.length) return blocks;
  const [leads, sent] = await Promise.all([
    Lead.find({ _id: { $in: rows.map(row => row.leadId) }, $or: [{ status: NEGATIVE }, { status: 'Won', clientBehaviour: NEGATIVE, convertedToUserId: { $ne: null } }], deletedAt: null }).select('phone altPhone status clientBehaviour clientBehaviourRevision convertedToUserId').lean(),
    reviewsSent(rows),
  ]);
  const phoneOf = new Map(leads.map(lead => [String(lead._id), lead]));
  for (const row of rows) {
    const lead = phoneOf.get(String(row.leadId));
    if (!lead) continue;
    const client = row.subjectKind === 'client';
    if (client && (process.env.CLIENT_FINAL_MESSAGE_ENABLED !== 'true' || lead.status !== 'Won' || String(lead.convertedToUserId) !== String(row.clientId) || (lead.clientBehaviourRevision || 0) !== (row.behaviourRevision || 0))) continue;
    if (!client && lead.status !== NEGATIVE) continue;
    if (row.status === 'review' && !(row.draftId ? sent.pressed.has(String(row.draftId)) : sent.unlinked)) continue;
    // Every number of the cycle (its main, its alternate, any a copy went to) and the lead's own alternate.
    const numbers = [row.phone || lead.phone, ...require('./finalMessageCopies').cycleNumbers(row), lead.altPhone];
    const keys = new Set(numbers.map(value => (value ? phoneKey(value) : '')).filter(Boolean));
    for (const key of keys) {
      if ((!client && clientKeys.has(key)) || blocks.has(key)) continue;
      blocks.set(key, row.status === 'replied' ? 'needs-decision' : 'final-message');
    }
  }
  return blocks;
}

/** This lead's reason, or null. `blocks` lets a list reuse one contactBlocks() read. */
function reasonFor(lead, blocks) {
  const key = phoneKey(lead.phone);
  if (key) return blocks.get(key) || null;
  // No number to match: only its own stage can say.
  if (lead.requestedByUserId || !NO_MARKETING_STATUSES.includes(lead.status)) return null;
  return lead.status === WRONG ? 'wrong' : 'dead';
}
const blockForLead = async lead => reasonFor(lead, await contactBlocks());
/** One number's reason, or null. A lead's other number is checked on its own: a blocked alternate gets nothing, the main still may. */
const numberBlock = (phone, blocks) => (phone && blocks.get(phoneKey(phone))) || null;

/** Fails with the reason when this lead may not be messaged. */
async function assertMayContact(lead) {
  const reason = await blockForLead(lead);
  if (reason) throw Object.assign(new Error(MESSAGES[reason]), { status: 409, code: reason });
}

/** A review popup may have stayed open while the person became blocked: checked again when Send is pressed. */
async function assertDraftMayGo(draftId) {
  const draft = await EmailDraft.findById(draftId).select('event leadId whatsappTo').lean();
  if (!draft || !MARKETING_EVENTS.includes(draft.event)) return;
  // The Final Message's own draft: the block exists because of it.
  if (draft.event === 'lead.finalMessage') {
    const row = await FinalMessage.findOne({ draftId: draft._id }).lean();
    if (!row && !draft.leadId) throw Object.assign(new Error('This final message is not tracked yet. Retry from the client or lead page before sending.'), { status: 409 });
    if (row?.subjectKind === 'client') {
      const lead = await Lead.findById(row.leadId).lean();
      if (!await require('./finalMessage').clientEligible(lead, row) || row.status !== 'review') throw Object.assign(new Error('This client or final message changed. Refresh before sending.'), { status: 409 });
      return;
    }
    if (row) return;
  }
  const lead = draft.leadId ? await Lead.findById(draft.leadId).select('phone status requestedByUserId').lean() : null;
  if (!lead && !draft.whatsappTo) return;
  await assertMayContact({ status: lead?.status, requestedByUserId: lead?.requestedByUserId, phone: draft.whatsappTo || lead?.phone });
}

module.exports = { MESSAGES, LABELS, contactBlocks, reasonFor, numberBlock, blockForLead, assertMayContact, assertDraftMayGo };
