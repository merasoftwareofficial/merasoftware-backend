const userModel = require('../models/userModel');
const leadModel = require('../models/leadModel');
const { Queue, finishedExpiry } = require('../whatsapp/src/models.js');

// Owner rule (27 Oct 2026): no WhatsApp is ever sent directly. Every one, automatic or typed by an
// admin, is added here with enqueueWhatsApp and waits its turn; the worker (whatsapp/src/sender.js) is
// the only code that talks to a chat, one message at a time. tests/whatsappQueue.test.js checks both.
// Owner rule: every email that is really sent also goes out on WhatsApp, with the same text.
const NO_PHONE = 'No phone number is saved for this email address.';
const BAD_PHONE = 'The saved phone number is not a valid mobile number.';
const ANY_CASE = { locale: 'en', strength: 2 }; // emails are unique but not always stored lower-case
const MAX_TEXT = 60_000;

/** '98765 43210', '098765-43210', '+91 98765 43210', '919876543210' → '919876543210'; anything else → null. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[\s\-().]/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^(\+|00)?91[6-9]\d{9}$/.test(digits)) return digits.replace(/^(\+|00)/, '');
  // Other countries need their +code; a +91 number that failed the Indian check above stays invalid.
  if (/^(\+|00)(?!91)[1-9]\d{9,14}$/.test(digits)) return digits.replace(/^(\+|00)/, '');
  return null;
}

/** The phone saved with this email: the user account first (active before deleted), then the newest lead. */
async function savedPhoneFor(email) {
  const withPhone = { email, phone: { $nin: [null, ''] } };
  const user = await userModel.findOne(withPhone).collation(ANY_CASE).sort({ deletedAt: 1 }).select('phone').lean();
  if (user) return user.phone;
  const lead = await leadModel.findOne(withPhone).collation(ANY_CASE).sort({ deletedAt: 1, updatedAt: -1 }).select('phone').lean();
  return lead?.phone || null;
}

/** The email as WhatsApp text: its subject in bold on the first line, then the email's own plain text. */
function messageText(draft) {
  const subject = String(draft.subject || '').replace(/\*/g, '').trim();
  return `${subject ? `*${subject}*\n\n` : ''}${draft.plain || draft.text || ''}`.slice(0, MAX_TEXT);
}

/**
 * The only way into the WhatsApp queue. A row without a usable number is stored as 'skipped' with
 * the reason, so the admin page shows why nothing went. Throws on a database error (11000 = already queued).
 */
async function enqueueWhatsApp({ to, text, skipReason, ...fields }, { session } = {}) {
  const row = to
    ? { status: 'pending', to }
    : { status: 'skipped', lastError: skipReason || NO_PHONE, expiresAt: finishedExpiry(new Date()) };
  const data = { source: ['lead.message', 'lead.proposal'].includes(fields.event) ? 'manual' : 'automated', ...fields, text: String(text || '').slice(0, MAX_TEXT), ...row };
  return session ? (await Queue.create([data], { session }))[0] : Queue.create(data);
}

/**
 * Queues one WhatsApp per recipient of a sent email. A recipient without a usable phone gets a
 * 'skipped' row with the reason, so the admin page shows why nothing went. Off unless ENABLE_WHATSAPP.
 */
async function enqueueWhatsAppForEmail(draft, { recipients, strict = false } = {}) {
  if (process.env.ENABLE_WHATSAPP !== 'true') {
    if (strict) throw new Error('WhatsApp is turned off.');
    return;
  }
  const text = messageText(draft);
  const source = draft.leadId ? 'manual' : 'automated';
  let targets = recipients;
  if (!targets) {
    // An automatic send: each recipient's saved number, then their alternate number (helpers/contactNumbers.js).
    const main = await Promise.all((draft.to || []).map(async email => {
      const saved = await savedPhoneFor(email);
      return { email, phone: normalizePhone(saved), saved };
    }));
    targets = await require('./contactNumbers').withAltNumbers(draft, main);
  }
  const failures = [];
  for (const target of targets) {
    const { email } = target;
    try {
      const saved = recipients ? target.phone : target.alt ? target.phone : target.saved;
      // A retry may meet a changed saved number: this recipient's main (or alternate) copy is queued once.
      const sameCopy = { emailDraftId: draft._id, email: email ? String(email).trim().toLowerCase() : null, alt: target.alt ? true : { $ne: true } };
      if (await Queue.exists(sameCopy)) continue;
      await enqueueWhatsApp({ to: normalizePhone(saved), skipReason: saved ? BAD_PHONE : NO_PHONE,
        emailDraftId: draft._id, email, event: draft.event, application: draft.application, text,
        source, ...(target.alt ? { alt: true } : {}) });
    } catch (error) {
      // 11000: this recipient is already queued. Any other error loses only this recipient's copy.
      if (error.code !== 11000) {
        failures.push(error);
        console.error(`[whatsapp] Could not queue the WhatsApp copy of ${draft.event}:`, error.message);
      }
    }
  }
  if (strict && failures.length) throw failures[0];
}

// Compatibility for queues created before provenance was stored. Missing temporary lead drafts
// are unknown, never silently reclassified as automatic. New queue rows need no draft lookup.
async function queueSource(item) {
  if (item.source) return item.source;
  if (item.event === 'lead.message') return 'manual';
  if (item.event === 'lead.finalMessage' || item.finalMessageExpiryId) return 'automated';
  if (item.emailDraftId) {
    const draft = await require('../models/emailControlModel').EmailDraft.findById(item.emailDraftId).select('leadId').lean();
    if (!draft) return 'unknown';
    if (draft.leadId) return 'manual';
  }
  return item.event && !item.event.startsWith('lead.') ? 'automated' : 'unknown';
}
module.exports = { enqueueWhatsApp, enqueueWhatsAppForEmail, normalizePhone, savedPhoneFor, messageText, queueSource };
