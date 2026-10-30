// One-time merge of the removed "New" lead status into "Contacted": each lead's status and its follow-up badges.
// Only those two values change; updatedAt stays, so the Leads list keeps its order. Safe to run again.
//
// Counts only, changes nothing:
//   $env:MONGODB_URI = "<URI>"; node scripts/mergeNewLeadStatus.js
// Apply, saving the old values for rollback to a file outside the repo:
//   $env:MONGODB_URI = "<URI>"; node scripts/mergeNewLeadStatus.js --apply --backup E:\Allprojects\backup\backend\<file>.json
//   Remove-Item Env:MONGODB_URI
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); // never overrides a URI set in the shell
const mongoose = require("mongoose");
const { CONTACTED } = require("../helpers/leadStatuses");

const OLD_STATUS = "New";
const AFFECTED = { $or: [{ status: OLD_STATUS }, { "followUps.badge": OLD_STATUS }] };

async function countOld(leads) {
  const [statuses, badges] = await Promise.all([
    leads.countDocuments({ status: OLD_STATUS }),
    leads.aggregate([{ $unwind: "$followUps" }, { $match: { "followUps.badge": OLD_STATUS } }, { $count: "count" }]).toArray(),
  ]);
  return { statuses, badges: badges[0]?.count || 0 };
}

/** db: a native database handle. Without `apply` it only counts. */
async function mergeNewLeadStatus(db, { apply = false, backupFile = null } = {}) {
  const leads = db.collection("leads");
  const before = await countOld(leads);
  if (!apply) return { before, after: before, applied: false };
  if (!backupFile) throw new Error("--apply needs --backup <file outside the repo>");

  const affected = await leads.find(AFFECTED, { projection: { status: 1, "followUps._id": 1, "followUps.badge": 1 } }).toArray();
  fs.writeFileSync(backupFile, JSON.stringify(affected, null, 2));
  await leads.updateMany({ status: OLD_STATUS }, { $set: { status: CONTACTED } });
  await leads.updateMany(
    { "followUps.badge": OLD_STATUS },
    { $set: { "followUps.$[old].badge": CONTACTED } },
    { arrayFilters: [{ "old.badge": OLD_STATUS }] },
  );
  return { before, after: await countOld(leads), applied: true };
}

async function main() {
  const args = process.argv.slice(2);
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  const backupAt = args.indexOf("--backup");
  // autoIndex off, no models: this script writes only the two fields above.
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  console.log(`Database: ${mongoose.connection.name}`);
  const result = await mergeNewLeadStatus(mongoose.connection.db, {
    apply: args.includes("--apply"),
    backupFile: backupAt >= 0 ? args[backupAt + 1] : null,
  });
  console.log(result.applied ? "Applied." : "Counts only; nothing changed.", JSON.stringify(result));
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { mergeNewLeadStatus };
