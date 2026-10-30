const Lead = require('../models/leadModel');
const { INQUIRY, CONTACTED, POSITIVE, NEGATIVE, WON, PROPOSAL_SENT } = require('./leadStatuses');
const { normalizePhone } = require('./whatsappQueue');
const { fail } = require('./broadcastContent');
const GROUPS = [CONTACTED, POSITIVE, NEGATIVE, WON, PROPOSAL_SENT, INQUIRY].map(id => ({ id, label: id === WON ? 'Matured' : id }));
function groupQuery(group) {
  if (!GROUPS.some(row => row.id === group)) fail('Choose a lead group.');
  return { deletedAt: null, ...(group === PROPOSAL_SENT
    ? { status: { $in: [CONTACTED, POSITIVE] }, proposalSentAt: { $ne: null } }
    : { status: group }) };
}
// requireName: the message greets by name, so a lead with none is left out rather than sent "Hi , thanks".
// `noName` always counts them, so the admin sees how many such a message would skip.
async function audience(group, { requireName = false } = {}) {
  const leads = await Lead.find(groupQuery(group)).select('_id name phone status proposalSentAt').sort({ _id: 1 }).lean();
  const phones = new Set(), recipients = [];
  const excluded = { invalidPhone: 0, duplicatePhone: 0, noName: 0 };
  for (const lead of leads) {
    const phone = normalizePhone(lead.phone);
    if (!phone) { excluded.invalidPhone++; continue; }
    if (phones.has(phone)) { excluded.duplicatePhone++; continue; }
    if (!lead.name) { excluded.noName++; if (requireName) continue; } // before the number is taken: another lead with it may have a name
    phones.add(phone);
    recipients.push({ leadId: lead._id, phone, name: lead.name });
  }
  return { recipients, total: leads.length, count: recipients.length, excluded };
}
async function eligible(group, recipient, { requireName = false } = {}) {
  const lead = await Lead.findOne({ ...groupQuery(group), _id: recipient.leadId }).select('name phone').lean();
  if (!lead || (requireName && !lead.name)) return null;
  return normalizePhone(lead.phone) === recipient.phone ? lead : null;
}
module.exports = { GROUPS, groupQuery, audience, eligible };
