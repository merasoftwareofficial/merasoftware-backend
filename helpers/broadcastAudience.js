const Lead = require('../models/leadModel');
const { CONTACTED, WON, PROPOSAL_SENT, PROPOSAL_GROUP_STATUSES, MARKETABLE_CLIENT_BEHAVIOURS, LEAD_CATEGORIES, CLIENT_BEHAVIOURS, NO_MARKETING_STATUSES, leadStatusLabel } = require('./leadStatuses');
const { normalizePhone } = require('./whatsappQueue');
const { fail } = require('./broadcastContent');
const { contactBlocks } = require('./leadContactBlock');
const { hasConfirmedName } = require('./leadName');
const { altSendingEnabled, usableAlt } = require('./contactNumbers');
// Legacy audience IDs remain readable for accepted runs and older clients. New UI uses CATALOG.
const GROUPS = [...LEAD_CATEGORIES.filter(value => !NO_MARKETING_STATUSES.includes(value)), WON, PROPOSAL_SENT].map(id => ({ id, label: leadStatusLabel(id) }));
const CATALOG = [...LEAD_CATEGORIES.map(value => ({ id: `leads:${value}`, label: leadStatusLabel(value), kind: 'leads', blocked: NO_MARKETING_STATUSES.includes(value) })), { id: `leads:${PROPOSAL_SENT}`, label: PROPOSAL_SENT, kind: 'leads', blocked: false }, ...CLIENT_BEHAVIOURS.map(value => ({ id: `clients:${value}`, label: leadStatusLabel(value), kind: 'clients', blocked: !MARKETABLE_CLIENT_BEHAVIOURS.includes(value) }))];
function groupQuery(group) {
  if (typeof group === 'string' && group.includes(':')) {
    const descriptor = CATALOG.find(row => row.id === group);
    if (!descriptor) fail('Choose a valid audience.');
    const value = group.slice(group.indexOf(':') + 1);
    return { deletedAt: null, requestedByUserId: null, ...(descriptor.kind === 'clients' ? { status: WON, convertedToUserId: { $ne: null }, clientBehaviour: value === CONTACTED ? { $in: MARKETABLE_CLIENT_BEHAVIOURS } : value } : { convertedToUserId: null, ...(value === PROPOSAL_SENT ? { status: { $in: PROPOSAL_GROUP_STATUSES }, proposalSentAt: { $ne: null } } : { status: value }) }) };
  }
  if (!GROUPS.some(row => row.id === group)) fail('Choose a lead group.');
  return { deletedAt: null, ...(group === PROPOSAL_SENT
    ? { status: { $in: PROPOSAL_GROUP_STATUSES }, proposalSentAt: { $ne: null } }
    // Matured: only Neutral clients. Not Now, Unhappy, Negative and Dead clients are not marketed to (owner, 8 Nov 2026).
    : group === WON ? { status: WON, clientBehaviour: { $in: MARKETABLE_CLIENT_BEHAVIOURS } }
    : { status: group }) };
}
// requireName: the message greets by name, so a lead with none is left out rather than sent "Hi , thanks".
// `noName` always counts them, so the admin sees how many such a message would skip.
async function audience(group, { requireName = false, channel = 'whatsapp', blocks: knownBlocks } = {}) {
  const [leads, blocks] = await Promise.all([Lead.find(groupQuery(group)).select('_id name nameFromWhatsapp phone altPhone email status proposalSentAt convertedToUserId clientBehaviour').sort({ _id: 1 }).lean(), knownBlocks ? Promise.resolve(knownBlocks) : contactBlocks()]);
  const phones = new Set(), emails = new Set(), recipients = [];
  const descriptor = CATALOG.find(row => row.id === group);
  const clientIds = descriptor?.kind === 'clients' ? new Set((await require('../models/userModel').find({ _id: { $in: leads.map(row => row.convertedToUserId) }, roles: 'customer', deletedAt: null, isActive: { $ne: false }, isGuest: { $ne: true } }).select('_id').lean()).map(row => String(row._id))) : null;
  const excluded = { invalidPhone: 0, duplicatePhone: 0, noName: 0, doNotDisturb: 0, ...(channel !== 'whatsapp' ? { invalidEmail: 0, duplicateEmail: 0 } : {}) };
  for (const lead of leads) {
    if (descriptor?.blocked || (clientIds && !clientIds.has(String(lead.convertedToUserId)))) { excluded.doNotDisturb++; continue; }
    const numberKeys = [normalizePhone(lead.phone), usableAlt(lead.altPhone, lead.phone)].filter(Boolean);
    if (numberKeys.some(number => blocks.has(number))) { excluded.doNotDisturb++; continue; }
    let countedName = false;
    const allowNamedDestination = () => {
      if (!hasConfirmedName(lead) && !countedName) { excluded.noName++; countedName = true; }
      return !requireName || hasConfirmedName(lead);
    };
    if (channel !== 'whatsapp') {
      const email = String(lead.email || '').trim().toLowerCase();
      if (!require('./emailValidator').isAccountEmail(email)) excluded.invalidEmail++;
      else if (emails.has(email)) excluded.duplicateEmail++;
      else if (allowNamedDestination()) { emails.add(email); recipients.push({ leadId: lead._id, email, channel: 'email', name: hasConfirmedName(lead) ? lead.name : '' }); }
      if (channel === 'email') continue;
    }
    const phone = normalizePhone(lead.phone);
    if (!phone) { excluded.invalidPhone++; continue; }
    if (blocks.has(phone)) { excluded.doNotDisturb++; continue; }
    if (phones.has(phone)) { excluded.duplicatePhone++; continue; }
    if (!allowNamedDestination()) continue;
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
// `blocks`: an already-read contactBlocks() map, for a caller that checks many recipients in one pass (the
// follow-up planner). Without it every check reads the current blocks, as a send does.
async function eligible(group, recipient, { requireName = false, blocks: knownBlocks } = {}) {
  if (CATALOG.find(row => row.id === group)?.blocked) return null;
  const lead = await Lead.findOne({ ...groupQuery(group), _id: recipient.leadId }).select('name nameFromWhatsapp phone altPhone email convertedToUserId').lean();
  if (!lead || (requireName && !hasConfirmedName(lead))) return null;
  if (group.startsWith('clients:') && !await require('../models/userModel').exists({ _id: lead.convertedToUserId, roles: 'customer', deletedAt: null, isActive: { $ne: false }, isGuest: { $ne: true } })) return null;
  if (recipient.channel === 'email') {
    if (String(lead.email || '').trim().toLowerCase() !== recipient.email) return null;
    const blocks = knownBlocks || await contactBlocks();
    return [normalizePhone(lead.phone), usableAlt(lead.altPhone, lead.phone)].some(number => number && blocks.has(number)) ? null : lead;
  }
  // The number must still be this lead's: its main number, or its alternate while alternate sending is on.
  const main = normalizePhone(lead.phone);
  if (recipient.phone !== main && !(altSendingEnabled() && main && usableAlt(lead.altPhone, lead.phone) === recipient.phone)) return null;
  return (knownBlocks || await contactBlocks()).has(recipient.phone) ? null : lead;
}
module.exports = { GROUPS, CATALOG, groupQuery, audience, eligible };
