const Lead = require('../models/leadModel');
const { INQUIRY, CONTACTED, POSITIVE, ACTIVE, LAZY, TOUGH, NOT_NOW, NEGATIVE, UNHAPPY, WON, PROPOSAL_SENT, PROPOSAL_GROUP_STATUSES, leadStatusLabel } = require('./leadStatuses');
const { normalizePhone } = require('./whatsappQueue');
const { fail } = require('./broadcastContent');
const { contactBlocks } = require('./leadContactBlock');
const { hasConfirmedName } = require('./leadName');
const { altSendingEnabled, usableAlt } = require('./contactNumbers');
// Dead and Wrong are never a group.
const GROUPS = [CONTACTED, POSITIVE, ACTIVE, NOT_NOW, NEGATIVE, UNHAPPY, WON, PROPOSAL_SENT, INQUIRY].map(id => ({ id, label: leadStatusLabel(id) }));
function groupQuery(group) {
  if (!GROUPS.some(row => row.id === group)) fail('Choose a lead group.');
  return { deletedAt: null, ...(group === PROPOSAL_SENT
    ? { status: { $in: PROPOSAL_GROUP_STATUSES }, proposalSentAt: { $ne: null } }
    : { status: group }) };
}
// requireName: the message greets by name, so a lead with none is left out rather than sent "Hi , thanks".
// `noName` always counts them, so the admin sees how many such a message would skip.
async function audience(group, { requireName = false } = {}) {
  const [leads, blocks] = await Promise.all([Lead.find(groupQuery(group)).select('_id name nameFromWhatsapp phone altPhone status proposalSentAt').sort({ _id: 1 }).lean(), contactBlocks()]);
  const phones = new Set(), recipients = [];
  const excluded = { invalidPhone: 0, duplicatePhone: 0, noName: 0, doNotDisturb: 0 };
  for (const lead of leads) {
    const phone = normalizePhone(lead.phone);
    if (!phone) { excluded.invalidPhone++; continue; }
    if (blocks.has(phone)) { excluded.doNotDisturb++; continue; }
    if (phones.has(phone)) { excluded.duplicatePhone++; continue; }
    if (!hasConfirmedName(lead)) { excluded.noName++; if (requireName) continue; } // before the number is taken: another lead with it may have a name
    phones.add(phone);
    recipients.push({ leadId: lead._id, phone, name: hasConfirmedName(lead) ? lead.name : '' });
    // The lead's alternate number gets its own copy, unless it is blocked or another lead already has it.
    const alt = altSendingEnabled() ? usableAlt(lead.altPhone, lead.phone) : null;
    if (alt && !blocks.has(alt) && !phones.has(alt)) {
      phones.add(alt);
      recipients.push({ leadId: lead._id, phone: alt, name: hasConfirmedName(lead) ? lead.name : '' });
    }
  }
  return { recipients, total: leads.length, count: recipients.length, excluded };
}
async function eligible(group, recipient, { requireName = false } = {}) {
  const lead = await Lead.findOne({ ...groupQuery(group), _id: recipient.leadId }).select('name nameFromWhatsapp phone altPhone').lean();
  if (!lead || (requireName && !hasConfirmedName(lead))) return null;
  // The number must still be this lead's: its main number, or its alternate while alternate sending is on.
  const main = normalizePhone(lead.phone);
  if (recipient.phone !== main && !(altSendingEnabled() && main && usableAlt(lead.altPhone, lead.phone) === recipient.phone)) return null;
  return (await contactBlocks()).has(recipient.phone) ? null : lead;
}
module.exports = { GROUPS, groupQuery, audience, eligible };
