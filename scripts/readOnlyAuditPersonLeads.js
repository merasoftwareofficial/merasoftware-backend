// READ-ONLY audit for "one person = one lead" (signup ↔ lead linking, alternate phone).
// Does not write/update/delete anything, and does not call Google Drive, email or WhatsApp.
//
// Answers, from live data instead of code theory:
//   1. Website members: how many have a linked lead (reservationUserId), and how many have none
//      but match an unlinked lead by phone, alternate phone or email.
//   2. Members whose phone and email point at different leads, or at a lead with another email.
//   3. Leads that are the same person (same phone / alternate phone) more than once.
//   4. Clients whose number still sits on a separate open lead, and clients with no / more than one Won lead.
//   5. Alternate numbers: how many, how many are valid WhatsApp numbers, how many equal someone's main number.
// A client's own project request (requestedByUserId) and a guest demo lead (guestUserId) are separate
// by design and are left out of the duplicate counts.
//
// Safety: every MongoDB write command is blocked before it reaches the server, no models are
// loaded (so no index is ever created), and only raw collections are read.
//
// Run against production (PowerShell, from E:\Allprojects\backend):
//   $env:MONGODB_URI = "<production URI>"; node scripts/readOnlyAuditPersonLeads.js
//   Remove-Item Env:MONGODB_URI
// Share the block between "SUMMARY START" and "SUMMARY END". Add --detail to also list each case
// (lead ids and masked numbers only).
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") }); // never overrides a URI set in the shell

const mongoose = require("mongoose");

const WRITE_METHODS = [
  "insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany",
  "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "bulkWrite",
  "createIndex", "createIndexes", "dropIndex", "dropIndexes", "drop", "rename",
];
function installWriteGuard() {
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  const proto = mongoose.mongo.Collection.prototype;
  for (const method of WRITE_METHODS) {
    proto[method] = function blocked() { throw new Error(`READ-ONLY: blocked ${method} on ${this.collectionName}`); };
  }
}

// Same rules as helpers/whatsappQueue.js normalizePhone + helpers/leadPhone.js phoneKey, copied so no model loads.
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[\s\-().]/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^(\+|00)?91[6-9]\d{9}$/.test(digits)) return digits.replace(/^(\+|00)/, "");
  if (/^(\+|00)(?!91)[1-9]\d{9,14}$/.test(digits)) return digits.replace(/^(\+|00)/, "");
  return null;
}
const phoneKey = (phone) => normalizePhone(phone) || String(phone || "").replace(/\D/g, "");
const emailKey = (email) => String(email || "").trim().toLowerCase();
const mask = (phone) => { const key = phoneKey(phone); return key ? `…${key.slice(-4)}` : "(none)"; };
const id = (value) => (value ? String(value) : null);
const tally = (rows, pick) => rows.reduce((acc, row) => { const key = String(pick(row) ?? "(none)"); acc[key] = (acc[key] || 0) + 1; return acc; }, {});

/** Everything the audit reports, as plain data. No side effects. */
async function collectAudit(db) {
  const [users, leads] = await Promise.all([
    db.collection("users").find({}, { projection: { email: 1, phone: 1, roles: 1, isGuest: 1, deletedAt: 1, isActive: 1 } }).toArray(),
    db.collection("leads").find({}, { projection: { phone: 1, altPhone: 1, email: 1, status: 1, source: 1, deletedAt: 1, reservationUserId: 1, convertedToUserId: 1, requestedByUserId: 1, guestUserId: 1 } }).toArray(),
  ]);

  const live = leads.filter((lead) => !lead.deletedAt);
  // A "person" lead: not a client's own project request, not a guest demo lead.
  const personLeads = live.filter((lead) => !lead.requestedByUserId && !lead.guestUserId);
  const unlinked = personLeads.filter((lead) => !lead.reservationUserId && !lead.convertedToUserId);

  const byMain = new Map(); const byAlt = new Map(); const byEmail = new Map();
  const push = (map, key, lead) => { if (key) map.set(key, [...(map.get(key) || []), lead]); };
  for (const lead of unlinked) {
    push(byMain, phoneKey(lead.phone), lead);
    push(byAlt, phoneKey(lead.altPhone), lead);
    push(byEmail, emailKey(lead.email), lead);
  }

  // 1 + 2. Members.
  const members = users.filter((u) => !u.deletedAt && !u.isGuest && (u.roles || []).includes("member") && !(u.roles || []).includes("customer"));
  const linkedIds = new Set(live.filter((l) => l.reservationUserId).map((l) => id(l.reservationUserId)));
  const memberRows = members.map((member) => {
    const key = phoneKey(member.phone);
    const email = emailKey(member.email);
    const main = key ? byMain.get(key) || [] : [];
    const alt = key ? byAlt.get(key) || [] : [];
    const mail = email ? byEmail.get(email) || [] : [];
    const candidates = new Map([...main, ...alt, ...mail].map((lead) => [id(lead._id), lead]));
    const phoneIds = new Set([...main, ...alt].map((l) => id(l._id)));
    const mailIds = new Set(mail.map((l) => id(l._id)));
    const split = phoneIds.size > 0 && mailIds.size > 0 && ![...phoneIds].some((x) => mailIds.has(x));
    const otherEmail = [...main, ...alt].filter((lead) => emailKey(lead.email) && emailKey(lead.email) !== email);
    return {
      memberId: id(member._id), phone: mask(member.phone), hasPhone: Boolean(key),
      linked: linkedIds.has(id(member._id)),
      matchMain: main.length, matchAlt: alt.length, matchEmail: mail.length, candidates: candidates.size,
      statuses: [...candidates.values()].map((l) => l.status),
      split, otherEmail: otherEmail.length,
      leadIds: [...candidates.keys()],
    };
  });
  const unlinkedMembers = memberRows.filter((r) => !r.linked);

  // 3. Same person, more than one person lead (main↔main or alt↔main).
  const groups = new Map();
  for (const lead of personLeads) {
    for (const key of [phoneKey(lead.phone), phoneKey(lead.altPhone)].filter(Boolean)) {
      groups.set(key, new Map([...(groups.get(key) || new Map()), [id(lead._id), lead]]));
    }
  }
  const duplicateGroups = [...groups.entries()].filter(([, set]) => set.size > 1).map(([key, set]) => ({
    phone: `…${key.slice(-4)}`,
    count: set.size,
    viaAlt: [...set.values()].some((l) => phoneKey(l.altPhone) === key),
    statuses: [...set.values()].map((l) => l.status).sort().join(" + "),
    leadIds: [...set.keys()],
  }));

  // 4. Clients whose number is also on a separate, unlinked open lead.
  const clients = users.filter((u) => !u.deletedAt && !u.isGuest && (u.roles || []).includes("customer"));
  const clientOverlap = clients.map((client) => {
    const key = phoneKey(client.phone);
    const hits = key ? [...(byMain.get(key) || []), ...(byAlt.get(key) || [])] : [];
    return { clientId: id(client._id), phone: mask(client.phone), leadIds: [...new Set(hits.map((l) => id(l._id)))], statuses: hits.map((l) => l.status) };
  }).filter((row) => row.leadIds.length);

  // 4b. Each client should have exactly one Won lead (convertedToUserId). Readers pick differently when there are more.
  const wonByClient = new Map();
  for (const lead of live.filter((l) => l.convertedToUserId)) push(wonByClient, id(lead.convertedToUserId), lead);
  const clientWonLeads = {
    clientsWithNoWonLead: clients.filter((c) => !wonByClient.has(id(c._id))).length,
    clientsWithMoreThanOneWonLead: clients.filter((c) => (wonByClient.get(id(c._id)) || []).length > 1).length,
    clientsWithAltPhoneOnAnyWonLead: clients.filter((c) => (wonByClient.get(id(c._id)) || []).some((l) => String(l.altPhone || "").trim())).length,
  };
  // 4c. Accounts sharing a main number: the new "one number = one account" signup rule assumes none.
  const accountsByPhone = new Map();
  for (const user of users.filter((u) => !u.deletedAt && !u.isGuest)) push(accountsByPhone, phoneKey(user.phone), user);
  const sharedPhones = [...accountsByPhone.values()].filter((list) => list.length > 1);
  clientWonLeads.phonesSharedByLiveAccounts = sharedPhones.length;
  clientWonLeads.accountsOnSharedPhones = sharedPhones.reduce((sum, list) => sum + list.length, 0);
  const multiWon = clients.filter((c) => (wonByClient.get(id(c._id)) || []).length > 1)
    .map((c) => ({ clientId: id(c._id), leadIds: wonByClient.get(id(c._id)).map((l) => id(l._id)), altOn: wonByClient.get(id(c._id)).filter((l) => l.altPhone).map((l) => id(l._id)) }));

  // 5. Alternate numbers.
  const withAlt = live.filter((l) => String(l.altPhone || "").trim());
  const mainKeys = new Set([...live.map((l) => phoneKey(l.phone)), ...users.map((u) => phoneKey(u.phone))].filter(Boolean));
  const altSummary = {
    leadsWithAltPhone: withAlt.length,
    altValidWhatsappFormat: withAlt.filter((l) => normalizePhone(l.altPhone)).length,
    altIsSomeonesMainNumber: withAlt.filter((l) => mainKeys.has(phoneKey(l.altPhone))).length,
  };

  return {
    totals: {
      users: users.length, leads: leads.length, liveLeads: live.length, personLeads: personLeads.length,
      leadsByStatus: tally(live, (l) => l.status), leadsBySource: tally(live, (l) => l.source || "(empty)"),
    },
    members: {
      total: members.length,
      withoutPhone: memberRows.filter((r) => !r.hasPhone).length,
      linkedToALead: memberRows.filter((r) => r.linked).length,
      notLinked: unlinkedMembers.length,
      notLinkedNoMatchingLead: unlinkedMembers.filter((r) => !r.candidates).length,
      notLinkedMatchByMainPhone: unlinkedMembers.filter((r) => r.matchMain).length,
      notLinkedMatchByAltPhoneOnly: unlinkedMembers.filter((r) => r.matchAlt && !r.matchMain).length,
      notLinkedMatchByEmailOnly: unlinkedMembers.filter((r) => r.matchEmail && !r.matchMain && !r.matchAlt).length,
      notLinkedMoreThanOneCandidate: unlinkedMembers.filter((r) => r.candidates > 1).length,
      phoneAndEmailPointAtDifferentLeads: unlinkedMembers.filter((r) => r.split).length,
      phoneMatchesLeadWithAnotherEmail: unlinkedMembers.filter((r) => r.otherEmail).length,
      candidateLeadStatuses: tally(unlinkedMembers.flatMap((r) => r.statuses), (s) => s),
    },
    duplicates: {
      phoneGroupsWithMoreThanOneLead: duplicateGroups.length,
      groupsJoinedOnlyByAltPhone: duplicateGroups.filter((g) => g.viaAlt).length,
      extraLeads: duplicateGroups.reduce((sum, g) => sum + g.count - 1, 0),
      statusCombos: tally(duplicateGroups, (g) => g.statuses),
    },
    clientsWithSeparateOpenLead: clientOverlap.length,
    clientWonLeads,
    altPhone: altSummary,
    detail: { unlinkedMembers: unlinkedMembers.filter((r) => r.candidates), duplicateGroups, clientOverlap, multiWon },
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  installWriteGuard();
  await mongoose.connect(uri);
  try {
    const audit = await collectAudit(mongoose.connection.db);
    const { detail, ...summary } = audit;
    console.log(`Database: ${mongoose.connection.db.databaseName}`);
    console.log("SUMMARY START");
    console.log(JSON.stringify(summary, null, 2));
    console.log("SUMMARY END");
    if (process.argv.includes("--detail")) console.log(JSON.stringify(detail, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { collectAudit, phoneKey };
