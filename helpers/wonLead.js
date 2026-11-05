const leadModel = require("../models/leadModel");
const { WON, behaviourFromStatus } = require("./leadStatuses");
const { findLeadsByPhone } = require("./leadPhone");
const { hasConfirmedName } = require("./leadName");

// Every client has a Won lead, so a campaign to Won leads reaches all of them.
// A lead conversion makes its own (controller/lead/convertLead.js); this covers the other ways to become a client.
const SOURCE = "Client account";

const isClient = (user) => Boolean(user) && !user.isGuest && !user.deletedAt && (user.roles || []).includes("customer");

/**
 * The open lead that is this person: the lead their website account already owns, else by phone first (the phone
 * is the person), else by email. A client's own project requests are not, nor a lead another account owns.
 */
async function findOpenLeadFor(user) {
  const open = { deletedAt: null, convertedToUserId: null, requestedByUserId: null };
  if (user._id) {
    const linked = await leadModel.findOne({ ...open, reservationUserId: user._id });
    if (linked) return linked;
    open.reservationUserId = { $in: [null, user._id] };
  }
  const [byPhone] = await findLeadsByPhone(user.phone, open);
  if (byPhone) return byPhone;
  const email = String(user.email || "").trim().toLowerCase();
  return email ? leadModel.findOne({ ...open, email }).sort({ updatedAt: -1 }) : null;
}

// A client's lead is the oldest one converted to them, a live one before a trashed one.
// Every reader picks it this way, so the page, the messages and the offers all use the same lead.
const CLIENT_LEAD_ORDER = { deletedAt: 1, createdAt: 1, _id: 1 };

/** This client's lead (a query: add .lean() where a plain object is enough). Trashed ones only when asked. */
function clientLeadFor(userId, { includeTrashed = false, select } = {}) {
  const query = leadModel.findOne({ convertedToUserId: userId, ...(includeTrashed ? {} : { deletedAt: null }) }).sort(CLIENT_LEAD_ORDER);
  return select ? query.select(select) : query;
}

const createWonLead = (user, createdBy) => leadModel.create({
  name: user.name || user.email,
  email: String(user.email || "").trim().toLowerCase(),
  phone: user.phone || "",
  source: SOURCE,
  status: WON,
  convertedToUserId: user._id,
  createdBy: createdBy || undefined,
});

/** Makes sure this client has a Won lead: the existing one, their open lead, or a new one. */
async function ensureWonLead(user, createdBy) {
  if (!isClient(user)) return null;
  // A trashed one counts too: the client already has a lead, it only needs restoring.
  const existing = await clientLeadFor(user._id, { includeTrashed: true });
  if (existing) return existing;
  const open = await findOpenLeadFor(user);
  if (!open) return createWonLead(user, createdBy);
  open.convertedToUserId = user._id;
  open.clientBehaviour = behaviourFromStatus(open.status);
  open.status = WON;
  // An Inquiry or Negative lead may have none (or only a WhatsApp guess), and Won needs one.
  if (!hasConfirmedName(open)) { open.name = user.name || user.email || open.name; open.nameFromWhatsapp = false; }
  return open.save();
}

/**
 * A client's account and their Won lead hold the same name, phone and email: the lead's copy drives
 * WhatsApp, final messages and the lead page. Call after the account changed anywhere (portal
 * Settings, a partner's edit), in the same transaction. An empty value leaves the lead's copy as it is.
 */
async function syncClientLeads(user, { session } = {}) {
  if (!user?._id) return;
  const name = String(user.name || "").trim();
  const phone = String(user.phone || "").trim();
  const email = String(user.email || "").trim().toLowerCase();
  const changes = { ...(name ? { name, nameFromWhatsapp: false } : {}), ...(phone ? { phone } : {}), ...(email ? { email } : {}) };
  if (!Object.keys(changes).length) return;
  await leadModel.updateMany({ convertedToUserId: user._id }, { $set: changes }, { session });
}

/** Business name and alternate number for these clients, from each one's lead (picked as clientLeadFor picks it). */
async function clientLeadExtras(userIds) {
  const leads = await leadModel
    .find({ convertedToUserId: { $in: userIds }, deletedAt: null })
    .sort(CLIENT_LEAD_ORDER)
    .select("convertedToUserId businessName altPhone")
    .lean();
  const extras = new Map();
  for (const lead of leads) {
    const key = String(lead.convertedToUserId);
    if (!extras.has(key)) extras.set(key, { businessName: lead.businessName || "", altPhone: lead.altPhone || "" });
  }
  return extras;
}

module.exports = { SOURCE, CLIENT_LEAD_ORDER, isClient, findOpenLeadFor, clientLeadFor, createWonLead, ensureWonLead, syncClientLeads, clientLeadExtras };
