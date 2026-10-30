const { applyDefault, validateContent } = require("./emailController");
const { reviewWithDoc, reviewTextFromEditor, reviewSubjectFromEditor, editableReview, templateOptions } = require("./emailTemplates");
const { render, compose, withRequiredLinks } = require("./emailMarkup");
const { isAccountEmail } = require("./emailValidator");
const { enqueueWhatsApp, normalizePhone, messageText } = require("./whatsappQueue");

// The message telling a lead about their proposal. Most leads have only a phone, and WhatsApp otherwise
// only copies a sent email, so: a lead with an email gets the normal reviewed email (and its WhatsApp
// copy); a lead with only a phone is reviewed in the same popup and goes straight to the WhatsApp queue.
const EVENT = "lead.proposal";

const hasEmail = (lead) => isAccountEmail(lead.email);

const proposalValues = (lead, proposal) => ({
  name: lead.name,
  amount: proposal.amount === null || proposal.amount === undefined ? "" : `₹${Number(proposal.amount).toLocaleString("en-IN")}`,
  link: proposal.downloadLink,
});

/** What the popup shows for a phone-only lead; null when the action is Off or WhatsApp can't reach them. */
async function whatsappPreview(lead, proposal) {
  const to = normalizePhone(lead.phone);
  if (!to || process.env.ENABLE_WHATSAPP !== "true") return null;
  const values = proposalValues(lead, proposal);
  const mail = await applyDefault(EVENT, { requiredLinks: [proposal.downloadLink] }, values);
  if (!mail) return null;
  const draft = { to: [], whatsappTo: to, subject: mail.subject, text: mail.text, event: EVENT, values, sourceTemplateId: mail.sourceTemplateId };
  const channels = await require('./reviewDelivery').availability(draft);
  return { ...draft, channel: "whatsapp", to: [to], ...reviewWithDoc(EVENT, mail.text, values, {}), ...await editableReview(draft),
    templateOptions: await templateOptions(EVENT), channelOptions: channels.choices, defaultChannel: 'whatsapp' };
}

/** The reviewed message, added to the WhatsApp queue. `body` is the popup's decision. */
async function queueProposalWhatsApp(lead, proposal, body) {
  const to = normalizePhone(lead.phone);
  if (!to) throw Object.assign(new Error("This lead has no valid WhatsApp number"), { status: 400 });
  if (process.env.ENABLE_WHATSAPP !== "true") throw Object.assign(new Error("WhatsApp is turned off"), { status: 409 });
  if (body.channels && body.channels !== 'whatsapp') throw Object.assign(new Error('This lead can only receive WhatsApp.'), { status: 400 });
  const values = proposalValues(lead, proposal);
  const text = withRequiredLinks(reviewTextFromEditor(EVENT, body, values, {}), [proposal.downloadLink]);
  const subject = reviewSubjectFromEditor(EVENT, body, values);
  validateContent(subject, text);
  const plain = compose(render(text, values, {}), {}).text;
  const id = new (require('mongoose').Types.ObjectId)(require('node:crypto').createHash('sha256').update(`lead-proposal:${lead._id}:${proposal.version}`).digest('hex').slice(0, 24));
  try { return await enqueueWhatsApp({ _id: id, to, text: messageText({ subject, plain }), event: EVENT, application: "portal" }); }
  catch (error) { if (error.code !== 11000) throw error; return require('../whatsapp/src/models.js').Queue.findById(id); }
}

module.exports = { EVENT, hasEmail, whatsappPreview, queueProposalWhatsApp };
