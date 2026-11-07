// Dry run by default. Apply requires an explicit, new backup file. No mail or hooks run.
const fs = require('node:fs');
const mongoose = require('mongoose');
const { FinalMessage } = require('../whatsapp/src/models');
const { normalizePhone } = require('../helpers/whatsappQueue');
const OLD = ['Lazy', 'Tough'];
const SELECT = { $or: [{ status: { $in: OLD } }, { clientBehaviour: { $in: OLD } }] };

async function migrateNotNow(db, { apply = false, backupFile, maintenance = false } = {}) {
  const leads = db.collection('leads');
  const cycles = db.collection(FinalMessage.collection.name);
  const candidates = await leads.find(SELECT, { projection: { status: 1, clientBehaviour: 1, clientBehaviourRevision: 1, convertedToUserId: 1, deletedAt: 1, updatedAt: 1, phone: 1, altPhone: 1 } }).toArray();
  const activeCycles = await cycles.find({ $or: [{ status: { $in: ['review', 'queued', 'waiting'] } }, { status: 'replied', decision: null }, { status: 'dead', expiryEnabled: true, expirySentAt: null }] }).toArray();
  const items = [];
  for (const lead of candidates) {
    const numbers = new Set([lead.phone, lead.altPhone].map(normalizePhone).filter(Boolean));
    const active = activeCycles.some(row => String(row.leadId) === String(lead._id) || [row.phone, row.altPhone, ...(row.sends || []).map(send => send.phone)].map(normalizePhone).some(number => number && numbers.has(number)));
    items.push({ ...lead, blocked: Boolean(active) });
  }
  if (!apply) return { applied: false, candidates: items.length, blocked: items.filter(x => x.blocked).length };
  // Cycle creation can race an uncoordinated scan. The operator must stop all writers.
  if (!maintenance) throw new Error('Apply requires confirmed maintenance with all lead and messaging writers stopped.');
  if (!backupFile) throw new Error('Apply requires a new backup file.');
  fs.writeFileSync(backupFile, JSON.stringify(items), { flag: 'wx' });
  let changed = 0, skipped = 0;
  for (const item of items) {
    if (item.blocked) { skipped++; continue; }
    // Refuse stale snapshots and detect a newly active cycle before each write.
    if (await cycles.findOne({ leadId: item._id, $or: [{ status: { $in: ['review', 'queued', 'waiting'] } }, { status: 'replied', decision: null }, { status: 'dead', expiryEnabled: true, expirySentAt: null }] })) { skipped++; continue; }
    const set = {};
    if (OLD.includes(item.status)) set.status = 'NotNow';
    if (OLD.includes(item.clientBehaviour)) { set.clientBehaviour = 'NotNow'; set.clientBehaviourRevision = (item.clientBehaviourRevision || 0) + 1; }
    const guard = { _id: item._id, status: item.status, clientBehaviour: item.clientBehaviour ?? null, clientBehaviourRevision: item.clientBehaviourRevision ?? null, updatedAt: item.updatedAt ?? null };
    const result = await leads.updateOne(guard, { $set: set });
    if (result.modifiedCount) changed++; else skipped++;
  }
  return { applied: true, candidates: items.length, changed, skipped, backupFile };
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI explicitly.');
  const args = process.argv.slice(2), backup = args.indexOf('--backup');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  try { console.log(JSON.stringify(await migrateNotNow(mongoose.connection.db, { apply: args.includes('--apply'), maintenance: args.includes('--maintenance'), backupFile: backup < 0 ? null : args[backup + 1] }))); }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { migrateNotNow };
