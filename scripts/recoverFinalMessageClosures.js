// Explicit, manifest-bound recovery of elapsed tracked cycles. No app startup or direct delivery.
const fs = require('node:fs');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const { FinalMessage, Queue, OutgoingAttempt } = require('../whatsapp/src/models.js');
const Lead = require('../models/leadModel');
const { normalizePhone, queueSource } = require('../helpers/whatsappQueue');
const read = (query, session) => query.session(session || null).lean();

async function evaluate(row, cutoff, session) {
  if (!row.sentAt || !row.deadlineAt || row.deadlineAt > cutoff) return { reason: 'not-elapsed' };
  if (row.status !== 'dead' || row.stopSource || row.stoppedAt) return { reason: row.status };
  if (row.lastReplyAt >= row.sentAt || row.outboundChecks?.length) return { reason: 'reply-or-outgoing-review' };
  if (row.expiryQueuedAt || await read(Queue.findOne({ finalMessageExpiryId: row.draftId }), session)) return { reason: 'already-dispatched' };
  const lead = await read(Lead.findById(row.leadId), session);
  if (!lead || lead.deletedAt || normalizePhone(lead.phone) !== row.phone) return { reason: 'recipient-changed' };
  if (row.subjectKind === 'client') {
    const ready = await require('../helpers/clientFinalMessageReadiness').clientReadiness({ ...lead, clientBehaviour: lead.clientBehaviour === 'Dead' ? 'Negative' : lead.clientBehaviour }, row);
    if (lead.clientBehaviour !== 'Dead' || !ready.ready) return { reason: ready.code || 'client-state' };
  } else if (lead.status !== 'Dead' || lead.convertedToUserId || lead.requestedByUserId) return { reason: 'lead-state' };
  const original = await read(Queue.findOne({ emailDraftId: row.draftId, status: 'sent' }), session);
  if (!original?.messageId || original.to !== row.phone || !original.sentAt || +original.sentAt !== +row.sentAt || (row.originalMessage?.id && row.originalMessage.id !== original.messageId)) return { reason: 'original-send-unproven' };
  const quote = { id: original.messageId, chat: original.messageChat || `${row.phone}@s.whatsapp.net`, text: original.text };
  const attempts = await read(OutgoingAttempt.find({ to: row.phone, createdAt: { $gte: row.sentAt }, source: { $in: ['manual', 'unknown'] },
    $or: [{ phase: 'sent' }, { handedOffAt: { $ne: null }, phase: { $in: ['handoff', 'failed'] } }] }), session);
  if (attempts.length) return { reason: 'manual-or-uncertain-attempt' };
  const later = await read(Queue.find({ to: row.phone, _id: { $ne: original._id }, $or: [{ sentAt: { $gte: row.sentAt } }, { status: 'sending' }, { status: 'failed', updatedAt: { $gte: row.sentAt } }] }), session);
  for (const item of later) if (await queueSource(item) !== 'automated') return { reason: 'manual-or-uncertain-conversation' };
  return { reason: 'eligible', quote, lead, original };
}

async function preview(cutoff = new Date()) {
  const rows = await FinalMessage.find({ deadlineAt: { $lte: cutoff } }).sort({ _id: 1 }).lean();
  const entries = [];
  const phones = new Map();
  for (const row of rows) {
    const result = await evaluate(row, cutoff);
    entries.push({ id: row._id, draftId: row.draftId, reason: result.reason, before: row, ...(result.reason === 'eligible' ? { quote: result.quote, leadBefore: result.lead, originalBefore: result.original } : {}) });
    if (result.reason === 'eligible') phones.set(row.phone, (phones.get(row.phone) || 0) + 1);
  }
  for (const entry of entries) if (entry.reason === 'eligible' && phones.get(entry.before.phone) > 1) entry.reason = 'shared-phone-review';
  return { version: 1, database: mongoose.connection.name, host: mongoose.connection.host, cutoff, entries };
}

async function enroll(plan) {
  if (plan.version !== 1 || plan.database !== mongoose.connection.name || plan.host !== mongoose.connection.host) throw new Error('Manifest database mismatch');
  const indexes = await Queue.collection.indexes();
  if (!indexes.some(i => i.unique && i.key.finalMessageExpiryId === 1 && Object.keys(i.key).length === 1 && i.partialFilterExpression?.finalMessageExpiryId?.$type === 'objectId')) throw new Error('Required unique closure-cycle index is missing');
  const results = [];
  for (const entry of plan.entries.filter(e => e.reason === 'eligible')) {
    const outcome = await mongoose.connection.transaction(async session => {
      const row = await read(FinalMessage.findById(entry.id), session);
      if (!row || String(row.draftId) !== String(entry.draftId)) return 'cycle-changed';
      const result = await evaluate(row, plan.cutoff, session);
      if (result.reason !== 'eligible') return result.reason;
      const changed = await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId, status: 'dead', updatedAt: row.updatedAt, expiryQueuedAt: null },
        { $set: { expiryEnabled: true, originalMessage: result.quote } }, { session });
      return changed.modifiedCount ? 'enrolled' : 'changed';
    });
    results.push({ id: entry.id, outcome });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
  if (!args.includes('--env-file') || !args.includes('--db-name') || !args.includes('--manifest')) throw new Error('Use --env-file PATH --db-name NAME --manifest PATH [--apply]');
  const env = require('dotenv').parse(fs.readFileSync(value('--env-file')));
  await mongoose.connect(env.MONGODB_URI || env.MONGO_URI || env.MONGODB_URL, { dbName: value('--db-name'), autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  const path = value('--manifest');
  if (!args.includes('--apply')) {
    const plan = await preview();
    fs.writeFileSync(path, EJSON.stringify(plan, null, 2, { relaxed: false }), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ elapsed: plan.entries.length, counts: plan.entries.reduce((counts, e) => ({ ...counts, [e.reason]: (counts[e.reason] || 0) + 1 }), {}) }));
  } else {
    const plan = EJSON.parse(fs.readFileSync(path, 'utf8'));
    process.env.ENABLE_WHATSAPP = 'true'; // this command may enqueue only; it starts no worker
    if (env.CLIENT_FINAL_MESSAGE_ENABLED === 'true') process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
    const mail = await require('../helpers/emailController').applyDefault('lead.finalMessageExpired', {}, {});
    if (!mail?.plain?.trim()) throw new Error('Closure template is off or empty; nothing enrolled');
    const outcomes = await enroll(plan);
    // The normal dispatcher remains the only owner of closure queue insertion and its marker.
    await require('../helpers/finalMessageExpiry').dispatch();
    const rows = await Queue.find({ finalMessageExpiryId: { $in: plan.entries.filter(e => e.reason === 'eligible').map(e => e.draftId) } }).select('status finalMessageExpiryId sentAt lastError').lean();
    fs.writeFileSync(`${path}.result.json`, EJSON.stringify({ at: new Date(), outcomes, rows }, null, 2, { relaxed: false }), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ outcomes: outcomes.reduce((counts, e) => ({ ...counts, [e.outcome]: (counts[e.outcome] || 0) + 1 }), {}), queue: rows.reduce((counts, r) => ({ ...counts, [r.status]: (counts[r.status] || 0) + 1 }), {}) }));
  }
}
if (require.main === module) main().catch(error => { console.error(error.message.includes('Manifest') || error.message.includes('Required') || error.message.includes('Closure template') ? error.message : 'Closure recovery failed; inspect saved manifest and database before retrying'); process.exitCode = 1; }).finally(() => mongoose.disconnect());
module.exports = { evaluate, preview, enroll };
