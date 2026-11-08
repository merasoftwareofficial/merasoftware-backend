const mongoose = require('mongoose');
const Lead = require('../models/leadModel');
const userModel = require('../models/userModel');
const Target = require('../models/offerTargetModel');
const { CLIENT_BEHAVIOURS, CONTACTED, DEFAULT_CLIENT_BEHAVIOUR, SELECTABLE_OFFER_STAGES, WON, leadStatusLabel, offerPanelOptions } = require('./leadStatuses');
const { LABELS, MESSAGES, contactBlocks, reasonFor } = require('./leadContactBlock');
const { phoneKey } = require('./leadPhone');
const { findLiveWebsiteOffer } = require('./websiteOffers');
const { CLIENT_LEAD_ORDER, ensureWonLead, isClient } = require('./wonLead');

// Who is in which offer. One person keeps one lead: this file only adds a row per offer and lines on that lead's
// timeline. It never sends anything and never changes the lead's own status. Only the admin moves a person.
const MAX_ADD = 500;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const validId = id => mongoose.isValidObjectId(id);
const validSlug = slug => /^[a-z0-9][a-z0-9-]{0,119}$/i.test(String(slug || ''));
const requireSlug = slug => { if (!validSlug(slug)) fail('Choose a valid offer.'); return String(slug); };
const line = (note, badge, userId, offerSlug) => ({ note, badge, date: new Date(), createdAt: new Date(), createdBy: userId, ...(offerSlug ? { offerSlug } : {}) });
const emailKey = value => String(value || '').trim().toLowerCase();
const blockFields = reason => (reason ? { block: reason, blockLabel: LABELS[reason] } : {});

const liveClients = () => userModel.find({ roles: 'customer', deletedAt: null, isGuest: { $ne: true } }).select('name email phone roles isGuest deletedAt').lean();

/** Everyone who can be chosen for this offer: each client account once, and each other lead once per number. */
async function people(slug) {
  requireSlug(slug);
  const [clients, leads, targets, blocks] = await Promise.all([
    liveClients(),
    Lead.find({ deletedAt: null, requestedByUserId: null, convertedToUserId: { $ne: null } }).sort(CLIENT_LEAD_ORDER).select('convertedToUserId clientBehaviour').lean(),
    Target.find({ offerSlug: slug }).select('leadId').lean(),
    contactBlocks(),
  ]);
  const inOffer = new Set(targets.map(row => String(row.leadId)));
  // Each client's own lead, picked as clientLeadFor picks it (the first in CLIENT_LEAD_ORDER).
  const wonByUser = new Map();
  for (const lead of leads) if (!wonByUser.has(String(lead.convertedToUserId))) wonByUser.set(String(lead.convertedToUserId), lead);
  const clientPhones = new Set(clients.map(user => phoneKey(user.phone)).filter(Boolean));
  const clientEmails = new Set(clients.map(user => emailKey(user.email)).filter(Boolean));
  const rows = clients.map((user) => {
    const won = wonByUser.get(String(user._id));
    return {
      type: 'client', id: String(user._id), name: user.name || user.email || '', phone: user.phone || '', email: user.email || '',
      category: won?.clientBehaviour || DEFAULT_CLIENT_BEHAVIOUR, inOffer: Boolean(won && inOffer.has(String(won._id))),
      ...blockFields(reasonFor({ phone: user.phone }, blocks)),
    };
  });
  const open = await Lead.find({ deletedAt: null, requestedByUserId: null, convertedToUserId: null, status: { $ne: WON } }).select('name phone email status').sort({ updatedAt: -1 }).lean();
  const seen = new Set();
  for (const lead of open) {
    const key = phoneKey(lead.phone);
    if ((key && (clientPhones.has(key) || seen.has(key))) || (lead.email && clientEmails.has(emailKey(lead.email)))) continue;
    if (key) seen.add(key);
    rows.push({
      type: 'lead', id: String(lead._id), name: lead.name || '', phone: lead.phone || '', email: lead.email || '',
      category: lead.status, inOffer: inOffer.has(String(lead._id)), ...blockFields(reasonFor(lead, blocks)),
    });
  }
  return rows;
}

/** The lead this chosen person's row in the offer hangs on, or the reason there can't be one. */
async function leadForPerson(person, actor, clients) {
  if (!person || !validId(person.id)) return { reason: 'This person was not found.' };
  if (person.type === 'client') {
    const user = await userModel.findById(person.id);
    if (!isClient(user)) return { reason: 'This client is no longer available.' };
    const lead = await ensureWonLead(user, actor);
    if (lead?.deletedAt) return { name: user.name, reason: "This client's lead is in Trash. Restore it first." };
    return { lead, name: user.name };
  }
  const lead = await Lead.findOne({ _id: person.id, deletedAt: null });
  if (!lead) return { reason: 'This lead is no longer available.' };
  if (lead.convertedToUserId || lead.requestedByUserId || lead.status === WON || clients.has(phoneKey(lead.phone))) return { name: lead.name, reason: 'This person is a client. Choose them from the clients list.' };
  return { lead, name: lead.name };
}

/** Adds the chosen people. Blocked people and those already in are reported, not added: nothing here can bring a Dead person back. */
async function addPeople(slug, chosen, actor) {
  requireSlug(slug);
  if (!Array.isArray(chosen) || !chosen.length) fail('Choose at least one person.');
  if (chosen.length > MAX_ADD) fail(`Add up to ${MAX_ADD} people at a time.`);
  const offer = await findLiveWebsiteOffer(slug);
  if (!offer) fail('Only a published, running offer can take new people.', 409);
  const [blocks, clients] = await Promise.all([contactBlocks(), liveClients()]);
  const clientKeys = new Set(clients.map(user => phoneKey(user.phone)).filter(Boolean));
  const result = { added: 0, already: 0, skipped: [] };
  for (const person of chosen) {
    const { lead, name, reason } = await leadForPerson(person, actor, clientKeys);
    if (!lead) { result.skipped.push({ name: name || '', reason }); continue; }
    const block = reasonFor(lead, blocks);
    if (block) { result.skipped.push({ name: lead.name || lead.phone || '', reason: MESSAGES[block] }); continue; }
    try {
      await Target.create({ leadId: lead._id, offerSlug: slug, offerTitle: offer.title, addedBy: actor });
    } catch (error) {
      if (error.code !== 11000) throw error;
      result.already += 1;
      continue;
    }
    await Lead.updateOne({ _id: lead._id }, { $push: { followUps: line(`Added to ${offer.title}.`, CONTACTED, actor, slug) } });
    result.added += 1;
  }
  return result;
}

const stageCounts = rows => {
  const counts = { total: rows.length, clients: 0, leads: 0, stages: {}, categories: {} };
  for (const row of rows) {
    counts[row.type === 'client' ? 'clients' : 'leads'] += 1;
    counts.stages[row.stage] = (counts.stages[row.stage] || 0) + 1;
    counts.categories[row.category] = (counts.categories[row.category] || 0) + 1;
  }
  return counts;
};

/** This offer's people and counts. A lead in Trash or purged doesn't count. */
async function targets(slug) {
  requireSlug(slug);
  const [rows, blocks] = await Promise.all([Target.find({ offerSlug: slug }).sort({ createdAt: -1 }).lean(), contactBlocks()]);
  const leads = await Lead.find({ _id: { $in: rows.map(row => row.leadId) }, deletedAt: null }).select('name phone email status clientBehaviour convertedToUserId requestedByUserId').lean();
  const byId = new Map(leads.map(lead => [String(lead._id), lead]));
  const list = rows.flatMap((row) => {
    const lead = byId.get(String(row.leadId));
    if (!lead) return [];
    const client = Boolean(lead.convertedToUserId);
    return [{
      id: String(row._id), leadId: String(lead._id), type: client ? 'client' : 'lead', name: lead.name || '', phone: lead.phone || '',
      category: client ? lead.clientBehaviour || DEFAULT_CLIENT_BEHAVIOUR : lead.status,
      stage: row.stage, addedAt: row.createdAt, boughtAt: row.boughtAt, ...blockFields(reasonFor(lead, blocks)),
    }];
  });
  return { rows: list, counts: stageCounts(list), options: offerPanelOptions() };
}

const loadTarget = async (id) => {
  const target = validId(id) ? await Target.findById(id) : null;
  if (!target) fail('This person is no longer in the offer.', 404);
  const lead = await Lead.findOne({ _id: target.leadId, deletedAt: null });
  if (!lead) fail('This lead is no longer available.', 404);
  return { target, lead };
};

/** The offer's own stage, with a line on the timeline. Matured comes only from Bought this offer. */
async function setStage(id, stage, actor) {
  if (!SELECTABLE_OFFER_STAGES.includes(stage)) fail('Choose a valid stage for this offer.');
  const { target, lead } = await loadTarget(id);
  if (target.stage === WON) fail('This offer is already Matured for this person.', 409);
  if (target.stage === stage) return target;
  const before = target.stage;
  target.stage = stage;
  await target.save();
  await Lead.updateOne({ _id: lead._id }, { $push: { followUps: line(`${target.offerTitle}: ${leadStatusLabel(before)} to ${leadStatusLabel(stage)}.`, stage, actor, target.offerSlug) } });
  return target;
}

/** Client: only this offer goes Matured, and their Won lead stays as it is. Anyone else must become a client first, through the normal Convert. */
async function markBought(id, actor) {
  const { target, lead } = await loadTarget(id);
  if (target.stage === WON) return target;
  if (!lead.convertedToUserId) fail('Convert this lead to a client first: open the lead and use Convert to Client. It needs a name, phone and valid email.', 409);
  target.stage = WON;
  target.boughtAt = new Date();
  target.boughtBy = actor;
  await target.save();
  await Lead.updateOne({ _id: lead._id }, { $push: { followUps: line(`Bought ${target.offerTitle}.`, WON, actor, target.offerSlug) } });
  return target;
}

/** A client's general behaviour. Their Won status and every offer's stage stay as they are.
 *  From the follow-up form the admin's note (and file) is the timeline line; otherwise one line records the change. */
async function setBehaviour(leadId, value, actor, { note, attachment } = {}) {
  if (!CLIENT_BEHAVIOURS.includes(value)) fail('Choose a valid behaviour.');
  const lead = validId(leadId) ? await Lead.findOne({ _id: leadId, deletedAt: null }) : null;
  if (!lead) fail('This lead is no longer available.', 404);
  if (!lead.convertedToUserId) fail('Behaviour is only for clients. Use the stage for a lead.', 409);
  const before = lead.clientBehaviour || DEFAULT_CLIENT_BEHAVIOUR;
  if (before === value) return { clientBehaviour: value };
  const entry = note
    ? { ...line(note, value, actor), attachment: attachment || null }
    : line(`Client current status: ${leadStatusLabel(before)} to ${leadStatusLabel(value)}.`, value, actor);
  const changed = await Lead.updateOne({ _id: lead._id, clientBehaviourRevision: lead.clientBehaviourRevision ? lead.clientBehaviourRevision : { $in: [null, 0] } }, {
    $set: { clientBehaviour: value },
    $inc: { clientBehaviourRevision: 1 },
    $push: { followUps: entry },
  });
  if (!changed.modifiedCount) fail('This client status changed in another window. Refresh and try again.', 409);
  return { clientBehaviour: value };
}

/** The offers on a lead's page. */
const targetsForLead = leadId => Target.find({ leadId }).select('offerSlug offerTitle stage boughtAt createdAt').sort({ createdAt: -1 }).lean();

module.exports = { people, addPeople, targets, setStage, markBought, setBehaviour, targetsForLead, validSlug };
