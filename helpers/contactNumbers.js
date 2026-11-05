const leadModel = require('../models/leadModel');
const userModel = require('../models/userModel');
const { FinalMessage } = require('../whatsapp/src/models.js');
const { normalizePhone } = require('./whatsappQueue');

// The numbers a message goes to: the person's main number, plus the alternate number an admin saved on their lead.
// The alternate is for contact only (never login or identity), so security messages go to the main number alone.
// ALT_PHONE_SENDING_ENABLED is the owner's switch: off, nothing is sent to an alternate number and everything works as before.
const SECURITY_EVENTS = ['sendClientAccountCreatedEmail', 'auth.otp'];
const FINAL_MESSAGE_EVENT = 'lead.finalMessage';
const MARKETING_EVENTS = ['lead.message', 'lead.created', 'lead.proposal', FINAL_MESSAGE_EVENT];
const ANY_CASE = { locale: 'en', strength: 2 };

const altSendingEnabled = () => process.env.ALT_PHONE_SENDING_ENABLED === 'true';

/** A lead's alternate number, normalised, or null when it is missing, unreadable or the same as the main number. */
function usableAlt(altPhone, mainPhone) {
  const alt = normalizePhone(altPhone);
  return alt && alt !== normalizePhone(mainPhone) ? alt : null;
}

/** The lead whose alternate number this recipient also gets: the draft's own lead, else the account's own lead. */
async function personLead(draft, email, mainPhone) {
  if (draft.leadId) {
    const lead = await leadModel.findById(draft.leadId).select('phone altPhone email').lean();
    // Explicit lead context belongs to its recipient, not every address on a multi-recipient draft.
    if (lead && (!email || String(lead.email || '').toLowerCase() === String(email).toLowerCase()
      || (normalizePhone(mainPhone) && normalizePhone(lead.phone) === normalizePhone(mainPhone)))) return lead;
  }
  if (!email) return null;
  const user = await userModel.findOne({ email, deletedAt: null }).collation(ANY_CASE).select('roles isGuest').lean();
  if (user) {
    if (user.isGuest) return null;
    if ((user.roles || []).includes('customer')) return require('./wonLead').clientLeadFor(user._id, { select: 'phone altPhone' }).lean();
    if ((user.roles || []).includes('member')) return leadModel.findOne({ reservationUserId: user._id, deletedAt: null }).select('phone altPhone').lean();
    return null; // team accounts have no lead: their own number only
  }
  // No account and no lead on the draft: only a lead holding both this email and this main number speaks for the recipient.
  const main = normalizePhone(mainPhone);
  if (!main) return null;
  const leads = await leadModel.find({ email, deletedAt: null, altPhone: { $nin: ['', null] } }).collation(ANY_CASE).sort({ updatedAt: -1 }).select('phone altPhone').lean();
  return leads.find(lead => normalizePhone(lead.phone) === main) || null;
}

/**
 * The alternate number this message may also go to, or null. `mainPhone` is the number already chosen for the
 * recipient. A marketing message skips an alternate number that is blocked (Dead, Wrong, a countdown of another person).
 */
async function altNumberFor(draft, { email, mainPhone, blocks } = {}) {
  if (!altSendingEnabled() || SECURITY_EVENTS.includes(draft.event)) return null;
  if (draft.event === FINAL_MESSAGE_EVENT) {
    // The cycle decided its alternate number when it was prepared (finalMessage.js); the send follows it.
    const row = await FinalMessage.findOne({ draftId: draft._id }).select('altPhone').lean();
    return row ? usableAlt(row.altPhone, mainPhone) : null;
  }
  const lead = await personLead(draft, email, mainPhone);
  const alt = lead ? usableAlt(lead.altPhone, mainPhone || lead.phone) : null;
  if (!alt || !MARKETING_EVENTS.includes(draft.event)) return alt;
  const { contactBlocks, numberBlock } = require('./leadContactBlock');
  return numberBlock(alt, blocks || await contactBlocks()) ? null : alt;
}

/**
 * Every WhatsApp destination of a draft, one row per number: [{ email, phone }]. The main rows are given (as the
 * draft resolved them); each gets its person's alternate number after it. A number already listed is not added twice.
 */
async function withAltNumbers(draft, rows) {
  if (!altSendingEnabled() || SECURITY_EVENTS.includes(draft.event)) return rows;
  const blocks = MARKETING_EVENTS.includes(draft.event) && draft.event !== FINAL_MESSAGE_EVENT ? await require('./leadContactBlock').contactBlocks() : null;
  const result = [];
  const seen = new Set(rows.map(row => row.phone).filter(Boolean));
  for (const row of rows) {
    result.push(row);
    if (!row.phone) continue;
    const alt = await altNumberFor(draft, { email: row.email, mainPhone: row.phone, blocks });
    if (alt && !seen.has(alt)) { seen.add(alt); result.push({ ...(row.email !== undefined ? { email: row.email } : {}), phone: alt, alt: true }); }
  }
  return result;
}

module.exports = { SECURITY_EVENTS, MARKETING_EVENTS, altSendingEnabled, usableAlt, altNumberFor, withAltNumbers };
