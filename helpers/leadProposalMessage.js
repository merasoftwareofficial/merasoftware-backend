const { applyDefault, validateContent } = require("./emailController");
const { reviewWithDoc, reviewTextFromEditor } = require("./emailTemplates");
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
  return { channel: "whatsapp", to: [to], subject: mail.subject, text: mail.text, event: EVENT, ...reviewWithDoc(EVENT, mail.text, values, {}) };
}

/** The reviewed message, added to the WhatsApp queue. `body` is the popup's decision. */
async function queueProposalWhatsApp(lead, proposal, body) {
  const to = normalizePhone(lead.phone);
  if (!to) throw Object.assign(new Error("This lead has no valid WhatsApp number"), { status: 400 });
  if (process.env.ENABLE_WHATSAPP !== "true") throw Object.assign(new Error("WhatsApp is turned off"), { status: 409 });
  const values = proposalValues(lead, proposal);
  const text = withRequiredLinks(reviewTextFromEditor(EVENT, body, values, {}), [proposal.downloadLink]);
  validateContent(body.subject, text);
  const plain = compose(render(text, values, {}), {}).text;
  return enqueueWhatsApp({ to, text: messageText({ subject: body.subject, plain }), event: EVENT, application: "portal" });
}

module.exports = { EVENT, hasEmail, whatsappPreview, queueProposalWhatsApp };
