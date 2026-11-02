const leadModel = require("../models/leadModel");
const userModel = require("../models/userModel");
const { FinalMessage } = require("../whatsapp/src/models.js");
const { CONTACTED, DEAD, INQUIRY, NEGATIVE, WON, WRONG } = require("./leadStatuses");
const { normalizePhone } = require("./whatsappQueue");

// Saved numbers come in many forms (98765…, +91 98765…), so they are compared normalised, never as text.
// A number normalizePhone can't read still has its digits, so it stays the same person every time.
const phoneKey = (phone) => normalizePhone(phone) || String(phone || "").replace(/\D/g, "");

/** The leads holding this number, newest first. Trashed ones too unless the filter says otherwise. */
async function findLeadsByPhone(phone, filter = {}, { session } = {}) {
  const wanted = phoneKey(phone);
  if (!wanted) return [];
  const leads = await leadModel.find({ phone: { $nin: ["", null] }, ...filter }).sort({ updatedAt: -1 }).session(session || null);
  return leads.filter((lead) => phoneKey(lead.phone) === wanted);
}

/** A number the business already knows: any lead, even one in Trash, or any account. */
async function isKnownPerson(phone) {
  const wanted = phoneKey(phone);
  if (!wanted) return false;
  if ((await findLeadsByPhone(phone)).length) return true;
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
  lead.set({ ...fields, name, email: email || lead.email, status: CONTACTED });
  return lead.save({ session });
}

/** A lead that came back ends its final message: no Dead later, and no decision waiting on the old reply. A message still in the queue is cancelled by finalMessageJobs.js. */
async function endFinalMessage(leadId) {
  await FinalMessage.updateMany({ leadId, status: { $in: ["waiting", "dead"] } }, { $set: { status: "stopped" } });
  await FinalMessage.updateMany({ leadId, status: "replied", decision: null }, { $set: { decision: "interested", decidedAt: new Date() } });
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
    await endFinalMessage(lead._id);
    lead.set({ status: CONTACTED, name: lead.name || name, email: lead.email || email || "" });
    await lead.save();
  }
  return returning[0] || leads.find((lead) => lead.status === WRONG) || null;
}

/** The client wrote to us: a Dead behaviour ends. Nothing else about them changes. */
async function clearClientDead(filter) {
  const now = new Date();
  const clients = await leadModel.find({ ...filter, clientBehaviour: DEAD }).select('_id').lean();
  await leadModel.updateMany({ ...filter, clientBehaviour: DEAD }, {
    $unset: { clientBehaviour: 1 },
    $inc: { clientBehaviourRevision: 1 },
    $push: { followUps: { note: "Client wrote to us. Behaviour: Dead to Neutral.", badge: WON, date: now, createdAt: now } },
  });
  await FinalMessage.updateMany({ leadId: { $in: clients.map(client => client._id) }, subjectKind: 'client', status: { $in: ['waiting', 'dead'] } }, { $set: { status: 'stopped' } });
}

module.exports = { phoneKey, findLeadsByPhone, findAccountsByPhone, isKnownPerson, claimInquiryLead, endFinalMessage, leadForNewRequest, clearClientDead };
