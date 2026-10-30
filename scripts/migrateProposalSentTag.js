// One-time: "Proposal Sent" stops being a status and becomes the lead's permanent proposalSentAt.
// Every lead with a proposal, the status or an old Proposal Sent follow-up gets it; a lead with the status
// becomes Contacted. Old follow-up badges stay as history. updatedAt stays. Safe to run again.
//
// Counts only, changes nothing:
//   $env:MONGODB_URI = "<URI>"; node scripts/migrateProposalSentTag.js
// Apply, saving the old values for rollback to a file outside the repo:
//   $env:MONGODB_URI = "<URI>"; node scripts/migrateProposalSentTag.js --apply --backup E:\Allprojects\backup\backend\<file>.json
//   Remove-Item Env:MONGODB_URI
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); // never overrides a URI set in the shell
const mongoose = require("mongoose");
const { CONTACTED, PROPOSAL_SENT } = require("../helpers/leadStatuses");

const AFFECTED = {
  $or: [
    { status: PROPOSAL_SENT },
    { proposalSentAt: null, $or: [{ "proposals.0": { $exists: true } }, { "followUps.badge": PROPOSAL_SENT }] },
  ],
};

/** When the first proposal went: its file, else the first follow-up with the old badge, else the last update. */
function firstProposalDate(lead) {
  const earliest = (values) => values.filter(Boolean).map((value) => new Date(value)).sort((a, b) => a - b)[0];
  const old = (lead.followUps || []).filter((item) => item.badge === PROPOSAL_SENT);
  return earliest((lead.proposals || []).map((item) => item.uploadedAt))
    || earliest(old.map((item) => item.createdAt || item.date))
    || new Date(lead.updatedAt || lead.createdAt || Date.now());
}

/** db: a native database handle. Without `apply` it only counts. */
async function migrateProposalSentTag(db, { apply = false, backupFile = null } = {}) {
  const leads = db.collection("leads");
  const affected = await leads
    .find(AFFECTED, { projection: { status: 1, proposalSentAt: 1, updatedAt: 1, createdAt: 1, "proposals.uploadedAt": 1, "followUps.badge": 1, "followUps.createdAt": 1, "followUps.date": 1 } })
    .toArray();
  const counts = {
    toTag: affected.filter((lead) => !lead.proposalSentAt).length,
    statusToContacted: affected.filter((lead) => lead.status === PROPOSAL_SENT).length,
  };
  if (!apply) return { ...counts, applied: false };
  if (!backupFile) throw new Error("--apply needs --backup <file outside the repo>");

  fs.writeFileSync(backupFile, JSON.stringify(affected.map(({ _id, status, proposalSentAt }) => ({ _id, status, proposalSentAt })), null, 2));
  for (const lead of affected) {
    await leads.updateOne({ _id: lead._id }, {
      $set: {
        proposalSentAt: lead.proposalSentAt || firstProposalDate(lead),
        ...(lead.status === PROPOSAL_SENT ? { status: CONTACTED } : {}),
      },
    });
  }
  return { ...counts, applied: true, remainingStatus: await leads.countDocuments({ status: PROPOSAL_SENT }) };
}

async function main() {
  const args = process.argv.slice(2);
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  const backupAt = args.indexOf("--backup");
  // autoIndex off, no models: this script writes only the two fields above.
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(JSON.stringify(await migrateProposalSentTag(mongoose.connection.db, {
    apply: args.includes("--apply"),
    backupFile: backupAt >= 0 ? args[backupAt + 1] : null,
  })));
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { migrateProposalSentTag };
