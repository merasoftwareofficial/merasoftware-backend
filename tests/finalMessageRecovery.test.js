const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Lead = require('../models/leadModel');
const { FinalMessage, Queue, OutgoingAttempt } = require('../whatsapp/src/models.js');
const { EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { preview, enroll } = require('../scripts/recoverFinalMessageClosures');
const expiry = require('../helpers/finalMessageExpiry');
let db;
before(async () => { db = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(db.getUri()); await Promise.all([Queue.init(), FinalMessage.init()]); process.env.ENABLE_WHATSAPP = 'true'; });
after(async () => { await mongoose.disconnect(); await db.stop(); });
beforeEach(async () => { await Promise.all([Lead, FinalMessage, Queue, OutgoingAttempt, EmailPolicy, EmailTemplate].map(m => m.deleteMany({}))); });
async function candidate() {
  const lead = await Lead.create({ name: 'Recovery fixture', phone: '9876543210', status: 'Dead' });
  const sentAt = new Date(Date.now() - 48 * 3600000), draftId = new mongoose.Types.ObjectId();
  const row = await FinalMessage.create({ leadId: lead._id, draftId, phone: '919876543210', status: 'dead', hours: 24, sentAt, deadlineAt: new Date(+sentAt + 24 * 3600000) });
  const original = await Queue.create({ emailDraftId: draftId, to: row.phone, event: 'lead.finalMessage', text: 'Original final offer', status: 'sent', sentAt, messageId: `original-${draftId}` });
  return { row, original, lead };
}
test('preview is read-only; enrollment preserves deadline/status and dispatches once through existing queue', async () => {
  const { row, original, lead } = await candidate();
  const plan = await preview();
  assert.equal(plan.entries[0].reason, 'eligible');
  assert.equal((await FinalMessage.findById(row._id)).expiryEnabled, undefined);
  assert.equal((await enroll(plan))[0].outcome, 'enrolled');
  const saved = await FinalMessage.findById(row._id);
  assert.equal(+saved.deadlineAt, +row.deadlineAt); assert.equal(+saved.sentAt, +row.sentAt);
  assert.equal(saved.hours, row.hours); assert.equal(saved.status, 'dead');
  assert.equal((await Lead.findById(lead._id)).status, 'Dead');
  assert.equal(saved.originalMessage.id, original.messageId);
  assert.equal(await Queue.countDocuments({ finalMessageExpiryId: row.draftId }), 0);
  await expiry.dispatch(); await expiry.dispatch();
  const closure = await Queue.findOne({ finalMessageExpiryId: row.draftId });
  assert.equal(closure.status, 'pending'); assert.equal(closure.source, 'automated');
  assert.equal(closure.quotedMessage.id, original.messageId);
  assert.equal(await Queue.countDocuments({ finalMessageExpiryId: row.draftId }), 1);
  await Queue.deleteOne({ _id: closure._id }); await expiry.dispatch();
  assert.equal(await Queue.countDocuments({ finalMessageExpiryId: row.draftId }), 0);
});
test('reply, Stop and changed phone after preview are rechecked before enrollment', async () => {
  for (const change of ['reply', 'stop', 'phone']) {
    await Promise.all([Lead, FinalMessage, Queue].map(m => m.deleteMany({})));
    const { row, lead } = await candidate(); const plan = await preview();
    if (change === 'reply') await FinalMessage.updateOne({ _id: row._id }, { $set: { lastReplyAt: new Date() } });
    if (change === 'stop') await FinalMessage.updateOne({ _id: row._id }, { $set: { status: 'stopped', stopSource: 'admin' } });
    if (change === 'phone') await Lead.updateOne({ _id: lead._id }, { $set: { phone: '9876543211' } });
    assert.notEqual((await enroll(plan))[0].outcome, 'enrolled');
    assert.equal((await FinalMessage.findById(row._id)).expiryEnabled, undefined);
  }
});
test('missing original proof, manual conversation and shared-phone cycles are excluded', async () => {
  const { row, original } = await candidate();
  await Queue.deleteOne({ _id: original._id });
  assert.equal((await preview()).entries[0].reason, 'original-send-unproven');
  await Queue.create(original.toObject());
  await Queue.create({ to: row.phone, event: 'lead.message', source: 'manual', text: 'Called', status: 'sent', sentAt: new Date() });
  assert.equal((await preview()).entries[0].reason, 'manual-or-uncertain-conversation');
  await Queue.deleteMany({ event: 'lead.message' }); await candidate();
  assert.ok((await preview()).entries.every(e => e.reason === 'shared-phone-review'));
});
test('failed enrollment transaction rolls back and permits a safe retry', async () => {
  const { row } = await candidate(); const plan = await preview(); const update = FinalMessage.updateOne;
  FinalMessage.updateOne = async function(filter, change, options) { await update.call(this, filter, change, options); throw new Error('Injected interruption'); };
  try { await assert.rejects(enroll(plan), /Injected interruption/); } finally { FinalMessage.updateOne = update; }
  assert.equal((await FinalMessage.findById(row._id)).expiryEnabled, undefined);
  assert.equal((await enroll(plan))[0].outcome, 'enrolled');
});
