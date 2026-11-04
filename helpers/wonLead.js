const leadModel = require("../models/leadModel");
const { WON, behaviourFromStatus } = require("./leadStatuses");
const { normalizePhone } = require("./whatsappQueue");
const { hasConfirmedName } = require("./leadName");

// Every client has a Won lead, so a campaign to Won leads reaches all of them.
// A lead conversion makes its own (controller/lead/convertLead.js); this covers the other ways to become a client.
const SOURCE = "Client account";

const isClient = (user) => Boolean(user) && !user.isGuest && !user.deletedAt && (user.roles || []).includes("customer");

/** The open lead that is this person, matched by email or phone. A client's own project requests are not. */
async function findOpenLeadFor(user) {
  const email = String(user.email || "").trim().toLowerCase();
  const phone = normalizePhone(user.phone);
  const leads = await leadModel
    .find({ deletedAt: null, convertedToUserId: null, requestedByUserId: null })
    .sort({ updatedAt: -1 });
  return leads.find((lead) => (email && lead.email === email) || (phone && normalizePhone(lead.phone) === phone)) || null;
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
  const existing = await leadModel.findOne({ convertedToUserId: user._id });
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

/** Business name and alternate number for these clients, from each one's lead (the oldest, as the Client Workspace picks it). */
async function clientLeadExtras(userIds) {
  const leads = await leadModel
    .find({ convertedToUserId: { $in: userIds }, deletedAt: null })
    .sort({ createdAt: 1, _id: 1 })
    .select("convertedToUserId businessName altPhone")
    .lean();
  const extras = new Map();
  for (const lead of leads) {
    const key = String(lead.convertedToUserId);
    if (!extras.has(key)) extras.set(key, { businessName: lead.businessName || "", altPhone: lead.altPhone || "" });
  }
  return extras;
}

module.exports = { SOURCE, isClient, findOpenLeadFor, createWonLead, ensureWonLead, syncClientLeads, clientLeadExtras };
