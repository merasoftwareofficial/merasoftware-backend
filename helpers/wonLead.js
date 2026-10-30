const leadModel = require("../models/leadModel");
const { WON } = require("./leadStatuses");
const { normalizePhone } = require("./whatsappQueue");

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
  open.status = WON;
  open.name = open.name || user.name || user.email; // an Inquiry or Negative lead may have none, and Won needs one
  return open.save();
}

module.exports = { SOURCE, isClient, findOpenLeadFor, createWonLead, ensureWonLead };
