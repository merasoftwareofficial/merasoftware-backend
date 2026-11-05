const userModel = require("../models/userModel");
const { clientLeadFor } = require("./wonLead");

// Shared source of truth for a client's admin-sent documents timeline.
// Two real owners, one merged newest-first view (never merged in the DB):
//   1. userModel.documents[]  -> agreements/documents sent after they became a client
//   2. leadModel.proposals[] and leadModel.followUps[].attachment -> files sent while
//      they were a lead
//     (linked by leadModel.convertedToUserId === this user's _id)
// Read-only. Used by both the customer-facing endpoint (getClientDocuments) and
// the admin client-workspace endpoint (getAdminClientDocuments), so the timeline
// shape stays identical on both sides.
const buildClientDocumentsTimeline = async (userId) => {
  const user = await userModel.findById(userId).select("documents").lean();
  if (!user) return null;

  // 1. Client-level documents (agreements etc.).
  const clientDocs = (user.documents || []).map((doc) => ({
    id: String(doc._id),
    kind: "agreement",
    name: doc.name,
    downloadLink: doc.downloadLink,
    type: doc.type,
    size: doc.size,
    source: doc.source,
    nodeId: doc.nodeId || null,
    orderId: doc.orderId ? String(doc.orderId) : null,
    date: doc.uploadedAt,
  }));

  // 2. Lead-stage files from the lead this client was converted from (if any).
  const lead = await clientLeadFor(userId, { includeTrashed: true, select: "proposals followUps" }).lean();

  const proposalDocs = ((lead && lead.proposals) || []).map((p) => ({
    id: `proposal-${p.version}`,
    kind: "proposal",
    name: p.name,
    downloadLink: p.downloadLink,
    type: p.type,
    size: p.size,
    version: p.version,
    date: p.uploadedAt,
  }));

  // A lead follow-up can carry one admin-sent Drive attachment. Follow-up
  // subdocuments have no own _id, so the Drive file id is the stable timeline id.
  // Files without a download link are not customer-downloadable and are excluded.
  const followUpDocs = ((lead && lead.followUps) || [])
    .filter((followUp) => followUp?.attachment?.downloadLink)
    .map((followUp) => ({
      id: `follow-up-${followUp.attachment.driveFileId}`,
      kind: "follow-up",
      name: followUp.attachment.name,
      downloadLink: followUp.attachment.downloadLink,
      type: followUp.attachment.type,
      size: followUp.attachment.size,
      date: followUp.createdAt || followUp.date,
    }));

  // One timeline, newest first.
  return [...clientDocs, ...proposalDocs, ...followUpDocs].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
};

module.exports = buildClientDocumentsTimeline;
