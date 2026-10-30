const Lead = require('../models/leadModel');
const { CONTACTED, POSITIVE, NEGATIVE, WON, PROPOSAL_SENT } = require('./leadStatuses');
const { normalizePhone } = require('./whatsappQueue');
const { fail } = require('./broadcastContent');
const GROUPS = [CONTACTED, POSITIVE, NEGATIVE, WON, PROPOSAL_SENT].map(id => ({ id, label: id === WON ? 'Matured' : id }));
function groupQuery(group) {
  if (!GROUPS.some(row => row.id === group)) fail('Choose a lead group.');
  return { deletedAt: null, ...(group === PROPOSAL_SENT
    ? { status: { $in: [CONTACTED, POSITIVE] }, proposalSentAt: { $ne: null } }
    : { status: group }) };
}
async function audience(group) {
  const leads = await Lead.find(groupQuery(group)).select('_id name phone status proposalSentAt').sort({ _id: 1 }).lean();
  const phones = new Set(), recipients = [];
  const excluded = { invalidPhone: 0, duplicatePhone: 0 };
  for (const lead of leads) {
    const phone = normalizePhone(lead.phone);
    if (!phone) { excluded.invalidPhone++; continue; }
    if (phones.has(phone)) { excluded.duplicatePhone++; continue; }
    phones.add(phone); recipients.push({ leadId: lead._id, phone, name: lead.name });
  }
  return { recipients, total: leads.length, count: recipients.length, excluded };
}
async function eligible(group, recipient) {
  const lead = await Lead.findOne({ ...groupQuery(group), _id: recipient.leadId }).select('name phone').lean();
  return lead && normalizePhone(lead.phone) === recipient.phone ? lead : null;
}
module.exports = { GROUPS, groupQuery, audience, eligible };
