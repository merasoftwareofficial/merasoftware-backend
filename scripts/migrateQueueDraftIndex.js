// Explicit, preview-first migration for alternate-number WhatsApp copies (merasoftware/src/docs/signup.md Phase 5-6).
// Does not load .env. QUEUE_MIGRATION_URI and QUEUE_MIGRATION_DB must name the target; --apply makes the change.
// The queue keeps one row per recipient's number, so a copy to the alternate number is not taken for "already queued":
//   emailDraftId + email        →  emailDraftId + email + to
//   finalMessageExpiryId        →  finalMessageExpiryId + to   (one closure message per number)
// The new index is created before the old one is dropped. Run it before ALT_PHONE_SENDING_ENABLED=true.
const DRAFT_OLD = { emailDraftId: 1, email: 1 };
const DRAFT_NEW = { emailDraftId: 1, email: 1, to: 1 };
const EXPIRY_OLD = { finalMessageExpiryId: 1 };
const EXPIRY_NEW = { finalMessageExpiryId: 1, to: 1 };
const sameKey = (index, key) => JSON.stringify(index.key) === JSON.stringify(key);

async function migrateQueueDraftIndex({ db, apply = false }) {
  if (['admin', 'config', 'local'].includes(db.databaseName)) throw new Error('Choose the application database explicitly');
  const queue = db.collection('whatsapp_queue');
  const cycles = db.collection('whatsapp_final_messages');
  const existing = await queue.listIndexes().toArray().catch(error => { if (error.code === 26) return []; throw error; });
  const oldDraft = existing.filter(index => index.unique && sameKey(index, DRAFT_OLD));
  const oldExpiry = existing.filter(index => index.unique && sameKey(index, EXPIRY_OLD));
  const report = {
    database: db.databaseName, mode: apply ? 'apply' : 'preview',
    queueRows: await queue.estimatedDocumentCount(),
    oldIndexes: [...oldDraft, ...oldExpiry].map(index => index.name),
    newIndexesPresent: existing.filter(index => sameKey(index, DRAFT_NEW) || sameKey(index, EXPIRY_NEW)).map(index => index.name),
    applied: false,
  };
  if (!apply) return report;
  // Existing rows already satisfy the new keys: each old key is unique, so adding `to` keeps it unique.
  await queue.createIndex(DRAFT_NEW, { unique: true, partialFilterExpression: { emailDraftId: { $exists: true } } });
  await queue.createIndex(EXPIRY_NEW, { unique: true, partialFilterExpression: { finalMessageExpiryId: { $type: 'objectId' } } });
  await cycles.createIndex({ altPhone: 1 });
  for (const index of [...oldDraft, ...oldExpiry]) await queue.dropIndex(index.name);
  return { ...report, applied: true };
}
if (require.main === module) {
  (async () => {
    const uri = process.env.QUEUE_MIGRATION_URI, name = process.env.QUEUE_MIGRATION_DB;
    if (!uri || !name) throw new Error('Set QUEUE_MIGRATION_URI and QUEUE_MIGRATION_DB explicitly; default mode is preview.');
    const { MongoClient } = require('mongodb');
    const client = await MongoClient.connect(uri);
    try {
      console.log(JSON.stringify(await migrateQueueDraftIndex({ db: client.db(name), apply: process.argv.includes('--apply') }), null, 2));
    } finally { await client.close(); }
  })().catch(error => { console.error('Queue index migration failed:', error.code || error.name, error.message); process.exitCode = 1; });
}
module.exports = { migrateQueueDraftIndex };
