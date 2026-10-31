const leadModel = require("../models/leadModel");
const userModel = require("../models/userModel");
const { CONTACTED, INQUIRY } = require("./leadStatuses");
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

module.exports = { findLeadsByPhone, findAccountsByPhone, isKnownPerson, claimInquiryLead };
