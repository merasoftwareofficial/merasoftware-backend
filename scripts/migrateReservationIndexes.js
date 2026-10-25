// Explicit, preview-first migration. Does not load .env or change projects/prices.
// RESERVATION_MIGRATION_URI and RESERVATION_MIGRATION_DB must name the target.
async function migrateReservationIndexes({ db, apply = false }) {
  if (['admin', 'config', 'local'].includes(db.databaseName)) throw new Error('Choose the application database explicitly');
  const reservations = db.collection('offerreservations');
  const leads = db.collection('leads');
  const existing = await reservations.listIndexes().toArray().catch(error => { if (error.code === 26) return []; throw error; });
  const rows = await reservations.find({}, { projection: { userId: 1, offerSlug: 1, periodEndsAt: 1, 'offerSnapshot.endsAt': 1 } }).toArray();
  const invalid = [], seen = new Set(), duplicates = [], backfill = [];
  for (const row of rows) {
    const date = new Date(row.periodEndsAt || row.offerSnapshot?.endsAt);
    if (!row.userId || !row.offerSlug || !Number.isFinite(date.getTime()) || (row.periodEndsAt && !(row.periodEndsAt instanceof Date))) { invalid.push(String(row._id)); continue; }
    const key = `${row.userId}:${row.offerSlug}:${date.toISOString()}`;
    if (seen.has(key)) duplicates.push(String(row._id)); seen.add(key);
    if (!row.periodEndsAt) backfill.push({ _id: row._id, date, source: row.offerSnapshot.endsAt });
  }
  const duplicateLeads = await leads.aggregate([
    { $match: { reservationUserId: { $type: 'objectId' } } },
    { $group: { _id: '$reservationUserId', count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } },
  ]).toArray();
  const old = existing.filter(index => index.unique && JSON.stringify(index.key) === JSON.stringify({ userId: 1, offerSlug: 1 }));
  const report = { database: db.databaseName, mode: apply ? 'apply' : 'preview', reservations: rows.length,
    periodBackfills: backfill.length, invalid, duplicates, duplicateLeadAccounts: duplicateLeads.map(row => String(row._id)),
    oldReservationIndexes: old.map(index => index.name), applied: false };
  if (invalid.length || duplicates.length || duplicateLeads.length) return { ...report, blocked: true };
  if (!apply) return report;
  if (backfill.length) await reservations.bulkWrite(backfill.map(row => ({ updateOne: {
    filter: { _id: row._id, $or: [{ periodEndsAt: { $exists: false } }, { periodEndsAt: null }], 'offerSnapshot.endsAt': row.source },
    update: { $set: { periodEndsAt: row.date } },
  } })), { ordered: true });
  // Create the replacement constraint before removing the obsolete constraint.
  await reservations.createIndex({ userId: 1, offerSlug: 1, periodEndsAt: 1 }, { unique: true });
  await reservations.createIndex({ pricingNextCheckAt: 1, expiresAt: 1, _id: 1 });
  await leads.createIndex({ reservationUserId: 1 }, { unique: true, partialFilterExpression: { reservationUserId: { $type: 'objectId' } } });
  await db.collection('reservationactionpreviews').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('reservationnotices').createIndex({ reservationId: 1, version: 1 }, { unique: true });
  await db.collection('reservationnotices').createIndex({ status: 1, nextAttemptAt: 1 });
  for (const index of old) await reservations.dropIndex(index.name);
  return { ...report, applied: true };
}
if (require.main === module) {
  (async () => {
    const uri = process.env.RESERVATION_MIGRATION_URI, name = process.env.RESERVATION_MIGRATION_DB;
    if (!uri || !name) throw new Error('Set RESERVATION_MIGRATION_URI and RESERVATION_MIGRATION_DB explicitly; default mode is preview.');
    const { MongoClient } = require('mongodb');
    const client = await MongoClient.connect(uri);
    try {
      const report = await migrateReservationIndexes({ db: client.db(name), apply: process.argv.includes('--apply') });
      console.log(JSON.stringify(report, null, 2));
      if (report.blocked) process.exitCode = 1;
    } finally { await client.close(); }
  })().catch(error => { console.error('Reservation migration failed:', error.code || error.name); process.exitCode = 1; });
}
module.exports = { migrateReservationIndexes };
