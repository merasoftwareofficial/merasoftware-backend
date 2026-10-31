const Lead = require('../models/leadModel');
const userModel = require('../models/userModel');
const { EmailDraft } = require('../models/emailControlModel');
const { FinalMessage, Queue } = require('../whatsapp/src/models.js');
const { DEAD, NEGATIVE, NO_MARKETING_STATUSES, WRONG } = require('./leadStatuses');
const { phoneKey } = require('./leadPhone');

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

/** Whether the admin has pressed Send on this review. Its row stays `review` until the minute job runs, and an email-only send starts no countdown. */
async function sendPressed(row) {
  if (await Queue.exists({ emailDraftId: row.draftId, status: { $in: ['pending', 'sending', 'sent'] } })) return true;
  const draft = await EmailDraft.findById(row.draftId).select('status delivery').lean();
  if (!draft || !['sending', 'sent', 'queued'].includes(draft.status)) return false;
  const channels = draft.delivery?.channels;
  return channels?.length ? channels.includes('whatsapp') : true;
}

/** Every blocked number: phone key → reason. A client's number is decided by the client's behaviour alone. */
async function contactBlocks() {
  const blocks = new Map();
  const clients = await userModel.find({ roles: 'customer', deletedAt: null, isGuest: { $ne: true }, phone: { $nin: ['', null] } }).select('phone').lean();
  const clientKeys = new Set(clients.map(user => phoneKey(user.phone)).filter(Boolean));

  const deadClients = await Lead.find({ clientBehaviour: DEAD, convertedToUserId: { $ne: null }, deletedAt: null }).select('phone convertedToUserId').lean();
  const deadIds = new Set(deadClients.map(lead => String(lead.convertedToUserId)));
  for (const lead of deadClients) { const key = phoneKey(lead.phone); if (key) blocks.set(key, 'client-dead'); }
  for (const user of clients) if (deadIds.has(String(user._id))) blocks.set(phoneKey(user.phone), 'client-dead');

  // Trashed ones count too. A client's own project request lead doesn't speak for the client.
  const closed = await Lead.find({ status: { $in: NO_MARKETING_STATUSES }, requestedByUserId: null, phone: { $nin: ['', null] } }).select('phone status').lean();
  for (const lead of closed) {
    const key = phoneKey(lead.phone);
    if (key && !clientKeys.has(key)) blocks.set(key, lead.status === WRONG ? 'wrong' : 'dead');
  }

  const rows = await FinalMessage.find({ $or: [{ status: { $in: ['review', 'queued', 'waiting'] } }, { status: 'replied', decision: null }] }).lean();
  if (!rows.length) return blocks;
  const leads = await Lead.find({ _id: { $in: rows.map(row => row.leadId) }, status: NEGATIVE, deletedAt: null }).select('phone').lean();
  const phoneOf = new Map(leads.map(lead => [String(lead._id), lead.phone]));
  for (const row of rows) {
    const leadPhone = phoneOf.get(String(row.leadId));
    if (leadPhone === undefined) continue; // the admin moved it out of Negative: the countdown no longer counts
    const key = phoneKey(row.phone || leadPhone);
    if (!key || clientKeys.has(key) || blocks.has(key)) continue;
    if (row.status === 'review' && !await sendPressed(row)) continue;
    blocks.set(key, row.status === 'replied' ? 'needs-decision' : 'final-message');
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
  if (draft.event === 'lead.finalMessage' && await FinalMessage.exists({ draftId: draft._id })) return;
  const lead = draft.leadId ? await Lead.findById(draft.leadId).select('phone status requestedByUserId').lean() : null;
  if (!lead && !draft.whatsappTo) return;
  await assertMayContact({ status: lead?.status, requestedByUserId: lead?.requestedByUserId, phone: draft.whatsappTo || lead?.phone });
}

module.exports = { MESSAGES, LABELS, contactBlocks, reasonFor, blockForLead, assertMayContact, assertDraftMayGo };
