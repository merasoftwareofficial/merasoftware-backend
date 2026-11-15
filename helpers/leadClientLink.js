const leadModel = require("../models/leadModel");
const userModel = require("../models/userModel");

/**
 * Unlinks any leads pointing to permanently deleted client accounts so they
 * can be deleted or converted again instead of staying orphaned.
 */
async function unlinkDeletedClients(userIds) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (!ids.length) return { modifiedCount: 0 };
  return leadModel.updateMany(
    { convertedToUserId: { $in: ids } },
    { $set: { convertedToUserId: null } }
  );
}

/**
 * Resolves the client linked to a lead. If the referenced user no longer exists
 * in userModel (permanently deleted), clears convertedToUserId on the lead
 * (auto-heal) and returns { status: "none", user: null }.
 */
async function inspectLeadClient(lead) {
  if (!lead?.convertedToUserId) return { status: "none", user: null };

  const user = await userModel
    .findById(lead.convertedToUserId)
    .select("_id deletedAt isGuest roles name email phone")
    .lean();

  if (!user) {
    await leadModel.updateOne(
      { _id: lead._id, convertedToUserId: lead.convertedToUserId },
      { $set: { convertedToUserId: null } }
    );
    lead.convertedToUserId = null;
    return { status: "none", user: null };
  }

  if (user.deletedAt) {
    return { status: "trashed", user };
  }

  return { status: "active", user };
}

/**
 * Batch-checks a list of lean leads: auto-heals leads whose linked client was
 * permanently deleted (sets convertedToUserId = null in DB and on the objects)
 * and marks leads whose client is currently in Trash with clientInTrash = true.
 */
async function healOrphanedLeads(leads) {
  if (!Array.isArray(leads) || !leads.length) return leads;

  const userIds = [
    ...new Set(
      leads
        .map((lead) => (lead.convertedToUserId ? String(lead.convertedToUserId) : null))
        .filter(Boolean)
    ),
  ];
  if (!userIds.length) return leads;

  const users = await userModel
    .find({ _id: { $in: userIds } })
    .select("_id deletedAt")
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const orphanLeadIds = [];
  for (const lead of leads) {
    if (!lead.convertedToUserId) continue;
    const user = byId.get(String(lead.convertedToUserId));
    if (!user) {
      orphanLeadIds.push(lead._id);
      lead.convertedToUserId = null;
    } else if (user.deletedAt) {
      lead.clientInTrash = true;
    }
  }

  if (orphanLeadIds.length) {
    await leadModel.updateMany(
      { _id: { $in: orphanLeadIds } },
      { $set: { convertedToUserId: null } }
    );
  }

  return leads;
}

module.exports = {
  unlinkDeletedClients,
  inspectLeadClient,
  healOrphanedLeads,
};
