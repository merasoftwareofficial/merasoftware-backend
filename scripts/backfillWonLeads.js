// One-time: gives each existing client with no lead a Won lead. Never links an existing lead to a client,
// because that shows the lead's files in the client's Documents; those are only counted, for a person to decide.
//
// Counts only, changes nothing:
//   $env:MONGODB_URI = "<URI>"; node scripts/backfillWonLeads.js
// Create the missing leads:
//   $env:MONGODB_URI = "<URI>"; node scripts/backfillWonLeads.js --apply
//   Remove-Item Env:MONGODB_URI
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); // never overrides a URI set in the shell
const mongoose = require("mongoose");
const userModel = require("../models/userModel");
const leadModel = require("../models/leadModel");
const { findOpenLeadFor, createWonLead } = require("../helpers/wonLead");

async function backfillWonLeads({ apply = false } = {}) {
  const clients = await userModel.find({ roles: "customer", deletedAt: null, isGuest: { $ne: true } });
  const result = { clients: clients.length, linked: 0, matchesAnOpenLead: 0, wonNotLinked: 0, created: 0, toCreate: 0 };
  for (const client of clients) {
    if (await leadModel.exists({ convertedToUserId: client._id })) { result.linked++; continue; }
    const email = String(client.email || "").trim().toLowerCase();
    const unlinkedWon = email && await leadModel.exists({ status: "Won", convertedToUserId: null, email });
    if (unlinkedWon) { result.wonNotLinked++; continue; }
    if (await findOpenLeadFor(client)) { result.matchesAnOpenLead++; continue; }
    result.toCreate++;
    if (apply) { await createWonLead(client); result.created++; }
  }
  return result;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(JSON.stringify(await backfillWonLeads({ apply: process.argv.includes("--apply") })));
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { backfillWonLeads };
