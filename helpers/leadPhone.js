const leadModel = require("../models/leadModel");
const userModel = require("../models/userModel");
const { FinalMessage } = require("../whatsapp/src/models.js");
const { CONTACTED, DEAD, INQUIRY, NEGATIVE, WON, WRONG } = require("./leadStatuses");
const { normalizePhone } = require("./whatsappQueue");
const { hasConfirmedName } = require("./leadName");

// Saved numbers come in many forms (98765…, +91 98765…), so they are compared normalised, never as text.
// A number normalizePhone can't read still has its digits, so it stays the same person every time.
const phoneKey = (phone) => normalizePhone(phone) || String(phone || "").replace(/\D/g, "");

/** Live leads before trashed ones, each keeping its order. */
const liveFirst = (leads) => [...leads.filter((lead) => !lead.deletedAt), ...leads.filter((lead) => lead.deletedAt)];

/** The leads holding this number, newest first. Trashed ones too unless the filter says otherwise. */
async function findLeadsByPhone(phone, filter = {}, { session } = {}) {
  const wanted = phoneKey(phone);
  if (!wanted) return [];
  const leads = await leadModel.find({ phone: { $nin: ["", null] }, ...filter }).sort({ updatedAt: -1 }).session(session || null);
  return leads.filter((lead) => phoneKey(lead.phone) === wanted);
}

/** Every number this lead can be reached on, as keys: the main phone first, then the alternate. Contact only, never identity. */
const leadPhoneKeys = (lead) => [...new Set([lead?.phone, lead?.altPhone].map((value) => (value ? phoneKey(value) : "")).filter(Boolean))];

/**
 * The leads reachable on this number: main-phone matches first, then alternate-number matches, each newest first.
 * For contact (recognising a message, do-not-disturb). Identity (signup, linking, duplicates) uses findLeadsByPhone.
 */
async function findLeadsByContactNumber(phone, filter = {}, { session } = {}) {
  const wanted = phoneKey(phone);
  if (!wanted) return [];
  const withNumber = { $or: [{ phone: { $nin: ["", null] } }, { altPhone: { $nin: ["", null] } }] };
  const leads = await leadModel.find({ $and: [withNumber, filter] }).sort({ updatedAt: -1 }).session(session || null);
  const main = leads.filter((lead) => lead.phone && phoneKey(lead.phone) === wanted);
  return [...main, ...leads.filter((lead) => !main.includes(lead) && lead.altPhone && phoneKey(lead.altPhone) === wanted)];
}

/** A number the business already knows: any lead (main or alternate number), even one in Trash, or any account. */
async function isKnownPerson(phone) {
  const wanted = phoneKey(phone);
  if (!wanted) return false;
  if ((await findLeadsByContactNumber(phone)).length) return true;
  const users = await userModel.find({ phone: { $nin: ["", null] } }).select("phone").lean();
  return users.some((user) => phoneKey(user.phone) === wanted);
}

/** The accounts holding this number, including trashed ones. */
async function findAccountsByPhone(phone) {
  const wanted = phoneKey(phone);
  if (!wanted) return [];
  const users = await userModel.find({ phone: { $nin: ["", null] } }).select("name email phone roles isGuest deletedAt").lean();
  return users.filter((user) => phoneKey(user.phone) === wanted);
}

/**
 * A person who wrote on WhatsApp now gives their details elsewhere: their Inquiry lead becomes the real one
 * instead of a second lead. Returns that lead, or null when they have none.
 */
async function claimInquiryLead(phone, { name, email, ...fields }, { session } = {}) {
  const [lead] = await findLeadsByPhone(phone, { status: INQUIRY, deletedAt: null, convertedToUserId: null }, { session });
  if (!lead) return null;
  lead.set({ ...fields, name, nameFromWhatsapp: false, email: email || lead.email, status: CONTACTED });
  return lead.save({ session });
}

/** A lead that came back ends its final message: no Dead later, and no decision waiting on the old reply. A message still in the queue is cancelled by finalMessageJobs.js. */
async function endFinalMessage(leadId, { session } = {}) {
  await FinalMessage.updateMany({ leadId, status: { $in: ["waiting", "dead"] } }, { $set: { status: "stopped" } }, { session });
  await FinalMessage.updateMany({ leadId, status: "replied", decision: null }, { $set: { decision: "interested", decidedAt: new Date() } }, { session });
}

/** True when this lead is Dead, or Negative with its final message running or its reply waiting: a new request brings it back. */
async function isReturning(lead, { session } = {}) {
  if (lead.status === DEAD) return true;
  if (lead.status !== NEGATIVE) return false;
  return Boolean(await FinalMessage.exists({ leadId: lead._id, $or: [{ status: { $in: ["review", "queued", "waiting"] } }, { status: "replied", decision: null }] }).session(session || null));
}

/** Brings one returning lead back to Contacted (see leadForNewRequest). The caller saves it. */
async function revive(lead, { name, email }, { session } = {}) {
  await endFinalMessage(lead._id, { session });
  // A name the person gives replaces one guessed from their WhatsApp profile.
  const keepName = hasConfirmedName(lead) || !name;
  lead.set({ status: CONTACTED, name: keepName ? lead.name : name, nameFromWhatsapp: keepName ? lead.nameFromWhatsapp : false, email: lead.email || email || "" });
}

/**
 * A person sends a new request from the website or portal. Their Dead lead, or a Negative one waiting on the
 * final message, returns to Neutral and takes the request. A Wrong lead takes it as a note and stays Wrong: only
 * the admin changes that. Returns that lead, or null when they have neither.
 */
async function leadForNewRequest(phone, { name, email }) {
  const leads = await findLeadsByPhone(phone, { status: { $in: [DEAD, NEGATIVE, WRONG] }, deletedAt: null, convertedToUserId: null, requestedByUserId: null });
  if (!leads.length) return null;
  const waiting = new Set((await FinalMessage.find({ leadId: { $in: leads.map((lead) => lead._id) }, $or: [{ status: { $in: ["review", "queued", "waiting"] } }, { status: "replied", decision: null }] }).select("leadId").lean()).map((row) => String(row.leadId)));
  const returning = leads.filter((lead) => lead.status === DEAD || waiting.has(String(lead._id)));
  for (const lead of returning) {
    await revive(lead, { name, email });
    await lead.save();
  }
  return returning[0] || leads.find((lead) => lead.status === WRONG) || null;
}

/**
 * The lead that already is this person, whatever its status, Trash and clients included: by main phone, else by
 * email, else a lead with this number as its alternate. A client's own project requests are not (they stay apart,
 * customerProjectRequest.js). Returns { lead, matchedBy } or null when the person is new: only then may a lead be made.
 */
async function findPersonLead({ phone, email }) {
  const notRequest = { requestedByUserId: null };
  const [byPhone] = liveFirst(await findLeadsByPhone(phone, notRequest));
  if (byPhone) return { lead: byPhone, matchedBy: "phone" };
  const mail = String(email || "").trim().toLowerCase();
  const [byEmail] = mail ? liveFirst(await leadModel.find({ email: mail, ...notRequest }).sort({ updatedAt: -1 })) : [];
  if (byEmail) return { lead: byEmail, matchedBy: "email" };
  const [byAlternate] = liveFirst(await findLeadsByContactNumber(phone, notRequest));
  return byAlternate ? { lead: byAlternate, matchedBy: "alternate" } : null;
}

/**
 * A new request goes on the person's existing lead (findPersonLead): back from Trash, Inquiry/Negative/Dead → Neutral,
 * Wrong stays Wrong, a client's lead stays Won. A missing name or email is filled; a new number found by email becomes
 * the alternate. Returns notes for what could not be kept on the lead. The caller adds its remark and saves.
 */
async function takeRequest(lead, { name, email, phone }, matchedBy) {
  const notes = [];
  if (lead.deletedAt) lead.set({ deletedAt: null, deletedBy: null });
  if (!lead.convertedToUserId) {
    if (lead.status === INQUIRY) lead.set({ status: CONTACTED });
    else if ([NEGATIVE, DEAD].includes(lead.status)) await revive(lead, { name, email });
  }
  if (!hasConfirmedName(lead) && name) lead.set({ name, nameFromWhatsapp: false });
  const mail = String(email || "").trim().toLowerCase();
  if (mail && !lead.email) lead.set({ email: mail });
  else if (mail && lead.email !== mail) notes.push(`A request came with another email: ${mail}`);
  if (phone && matchedBy === "email" && !leadPhoneKeys(lead).includes(phoneKey(phone))) {
    if (!String(lead.altPhone || "").trim()) lead.set({ altPhone: phone });
    else notes.push(`A request came from another number: ${phone}`);
  }
  return notes;
}

/** The client wrote to us: a Dead behaviour ends. Nothing else about them changes. */
async function clearClientDead(filter, { preserveFinalReply = false } = {}) {
  const now = new Date();
  const clients = await leadModel.find({ ...filter, clientBehaviour: DEAD }).select('_id').lean();
  const pending = preserveFinalReply ? await FinalMessage.find({ leadId: { $in: clients.map(client => client._id) }, subjectKind: 'client', $or: [{ status: 'replied', decision: null }, { status: 'dead', lastReplyAt: { $ne: null }, $expr: { $gte: ['$lastReplyAt', '$sentAt'] } }] }).select('leadId').lean() : [];
  const protectedIds = new Set(pending.map(row => String(row.leadId)));
  const eligibleIds = clients.filter(client => !protectedIds.has(String(client._id))).map(client => client._id);
  if (!eligibleIds.length) return;
  await leadModel.updateMany({ ...filter, _id: { $in: eligibleIds }, clientBehaviour: DEAD }, {
    $unset: { clientBehaviour: 1 },
    $inc: { clientBehaviourRevision: 1 },
    $push: { followUps: { note: "Client wrote to us. Behaviour: Dead to Neutral.", badge: WON, date: now, createdAt: now } },
  });
  await FinalMessage.updateMany({ leadId: { $in: eligibleIds }, subjectKind: 'client', status: { $in: ['waiting', 'dead'] } }, { $set: { status: 'stopped' } });
}

module.exports = { phoneKey, leadPhoneKeys, liveFirst, findLeadsByPhone, findLeadsByContactNumber, findAccountsByPhone, isKnownPerson, claimInquiryLead, endFinalMessage, isReturning, revive, leadForNewRequest, findPersonLead, takeRequest, clearClientDead };
