const User = require('../models/userModel');

// Where team mail goes: each active admin's own contact settings (Admin → Settings in the portal and the
// website; both save user.adminContact through /api/admin/my-settings). The backend owns this rule; the two
// frontends only show and save the settings. Used by every action addressed to the admins
// (emailCatalog.js isAdminRecipientEvent): the draft's recipients (emailController.js prepareMail) and their
// WhatsApp numbers (whatsappQueue.js, reviewDelivery.js).
//   - contact email, else the admin's login email when only numbers are saved
//   - up to two WhatsApp numbers each; an admin with no saved numbers keeps the account phone (savedPhoneFor)
//   - an admin who saved nothing gets no team mail
// FALLBACK (owner decision 7 Nov 2026) is used only while no active admin has saved anything, so team mail
// never stops silently.
const FALLBACK = { email: 'syncvap@gmail.com', numbers: ['+919256537003', '+919356393094'] };
const TEAM_FALLBACK_EMAILS = [FALLBACK.email];
const lower = value => String(value || '').trim().toLowerCase();

async function teamContacts() {
  const admins = await User.find({ roles: 'admin', isGuest: { $ne: true }, isActive: { $ne: false }, deletedAt: null })
    .select('email adminContact').lean();
  const saved = admins.filter(admin => admin.adminContact?.email || admin.adminContact?.whatsappNumbers?.length)
    .map(admin => ({ email: lower(admin.adminContact.email || admin.email), numbers: admin.adminContact.whatsappNumbers || [] }));
  return saved.length ? saved : [{ email: FALLBACK.email, numbers: FALLBACK.numbers }];
}
/** The team mail's recipients, one address each. */
async function teamRecipients() {
  return [...new Set((await teamContacts()).map(row => row.email).filter(Boolean))];
}
/** The WhatsApp numbers saved for this team address (at most two), or null when none are saved for it. */
async function teamNumbersFor(email) {
  const key = lower(email);
  const numbers = [...new Set((await teamContacts()).filter(row => row.email === key).flatMap(row => row.numbers))].slice(0, 2);
  return numbers.length ? numbers : null;
}

module.exports = { teamContacts, teamRecipients, teamNumbersFor, TEAM_FALLBACK_EMAILS, FALLBACK };
