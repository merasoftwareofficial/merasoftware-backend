const Lead = require('../models/leadModel');
const { EmailDraft, EmailPolicy } = require('../models/emailControlModel');
const { byKey } = require('./emailCatalog');
const { applyDefault, queueMail, recordHistory } = require('./emailController');
const { buildTemplatedMail } = require('./emailTemplates');
const { hasEmail, proposalValues } = require('./leadProposalMessage');
const { readHours } = require('./finalMessage');
const { normalizePhone } = require('./whatsappQueue');

// Send message on a lead's page: any lead, any stage, as many times as the admin wants. This file only decides which
// actions fit a lead and fills them from the saved lead. Templates, the review popup, sending, the WhatsApp queue and
// History are the normal ones. It sends nothing itself, never changes the stage and never starts the Final Message wait:
// that follows its own FinalMessage rows (helpers/finalMessage.js), and none is made here.
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const latestProposal = lead => [...(lead.proposals || [])].sort((a, b) => b.version - a.version)[0];
const emailOf = lead => (hasEmail(lead) ? lead.email : '');

// Each action this popup offers, in the dropdown's order. Other actions need data a lead doesn't have.
const TYPES = {
  'lead.message': { values: lead => ({ name: lead.name || '' }) },
  'lead.created': { values: lead => ({ name: lead.name || '' }) },
  'lead.proposal': {
    fits: lead => !!latestProposal(lead),
    values: lead => proposalValues(lead, latestProposal(lead)),
    requiredLinks: lead => [latestProposal(lead).downloadLink],
  },
  'lead.finalMessage': {
    note: 'This only sends the message. The lead does not go Dead: use Send final message for that.',
    values: async lead => buildTemplatedMail('lead.finalMessage', lead, emailOf(lead), await readHours()).values,
  },
};

async function typesFor(lead) {
  const off = new Set((await EmailPolicy.find({ event: { $in: Object.keys(TYPES) }, mode: 'off' }).select('event').lean()).map(row => row.event));
  return Object.entries(TYPES).filter(([, type]) => !type.fits || type.fits(lead)).map(([id, type]) => ({
    id, label: byKey.get(id).label, enabled: !off.has(id), ...(off.has(id) ? { reason: 'Off in Email Templates' } : {}), ...(type.note ? { note: type.note } : {}),
  }));
}

async function liveLead(leadId) {
  return Lead.findOne({ _id: leadId, deletedAt: null }).lean();
}

async function mailFor(event, lead) {
  const type = TYPES[event];
  return { to: hasEmail(lead) ? [lead.email] : [], phone: lead.phone, leadId: lead._id, values: await type.values(lead), requiredLinks: type.requiredLinks?.(lead) };
}

/** The dropdown's list for this lead, read fresh each time. */
async function messageTypes(leadId) {
  const lead = await liveLead(leadId);
  return lead ? typesFor(lead) : [];
}

/** Prepares the review in the current request, so the portal opens the popup. Returns false when nothing could be prepared. */
async function prepare(lead) {
  const first = (await typesFor(lead)).find(type => type.enabled);
  if (!first) return false;
  const { draftId } = await queueMail(first.id, await mailFor(first.id, lead));
  return !!draftId;
}

/** The first dropdown. Only an untouched draft moves; values and contacts always come from the saved lead. */
async function changeMessageType(draftId, event, actor) {
  const draft = await EmailDraft.findOne({ _id: draftId, leadId: { $ne: null } }).select('leadId').lean();
  if (!draft) fail('This message is no longer available.', 404);
  const lead = await liveLead(draft.leadId);
  if (!lead) fail('This lead is no longer available.', 404);
  const type = (await typesFor(lead)).find(row => row.id === event);
  if (!type) fail('Choose a message type for this lead.', 400);
  if (!type.enabled) fail(`${type.label} is Off in Email Templates.`);
  const mail = await mailFor(event, lead);
  const content = await applyDefault(event, mail, mail.values);
  if (!content) fail(`${type.label} is Off in Email Templates.`);
  const moved = await EmailDraft.findOneAndUpdate({ _id: draftId, status: 'pending', attemptCount: 0, 'delivery.lockedAt': null }, { $set: {
    event, values: mail.values, requiredLinks: mail.requiredLinks || [], to: mail.to, whatsappTo: normalizePhone(mail.phone),
    subject: content.subject, text: content.text, plain: content.plain, html: content.html,
    templateName: content.templateName, sourceTemplateId: content.sourceTemplateId,
  } }, { new: true });
  if (!moved) fail('This message has already been decided.');
  await recordHistory(moved, actor);
}

const CHANNEL_WORDS = { email: 'Email sent', whatsapp: 'WhatsApp queued' };

/** One line on the lead's timeline after a send. Retries can't add it twice; the stage is untouched. */
async function recordOnTimeline(draftId) {
  const draft = await EmailDraft.findById(draftId).select('leadId event actor delivery').lean();
  if (!draft?.leadId) return;
  const lead = await Lead.findById(draft.leadId).select('status').lean();
  if (!lead) return;
  const channels = (draft.delivery?.channels?.length ? draft.delivery.channels : ['email']).map(channel => CHANNEL_WORDS[channel]).join(', ');
  const now = new Date();
  await Lead.updateOne({ _id: lead._id, 'followUps.messageDraftId': { $ne: draft._id } }, { $push: { followUps: {
    messageDraftId: draft._id, note: `Message: ${byKey.get(draft.event)?.label || draft.event}. ${channels}.`, badge: lead.status, date: now, createdAt: now, createdBy: draft.actor,
  } } });
}

module.exports = { prepare, messageTypes, changeMessageType, recordOnTimeline };
