const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Broadcast, BroadcastRecipient } = require('../models/broadcastModel');
const { broadcastReminderCandidates, eligibleBroadcastReminder } = require('../helpers/broadcastReminderCandidates');
const Lead = require('../models/leadModel');
const Rule = require('../models/communicationReminderRuleModel');
const Run = require('../models/communicationReminderRunModel');
const { planBroadcastReminders } = require('../helpers/broadcastReminderSchedule');

test('broadcast reminder candidates require every original destination and part to succeed', async () => {
  const db = await MongoMemoryServer.create();
  try {
    await mongoose.connect(db.getUri());
    const start = new Date('2026-11-12T00:00:00Z');
    const broadcast = await Broadcast.create({ createdBy: new mongoose.Types.ObjectId(), requestKey: 'test', fingerprint: 'x', audience: 'Inquiry', message: 'test', origin: 'new', state: 'ready', acceptanceCompletedAt: new Date(+start + 1000) });
    const leadId = new mongoose.Types.ObjectId(), other = new mongoose.Types.ObjectId();
    await BroadcastRecipient.insertMany([
      { broadcastId: broadcast._id, leadId, channel: 'whatsapp', phone: '919876543210', part: 0, parts: 2, state: 'sent', sentAt: new Date(+start + 2000) },
      { broadcastId: broadcast._id, leadId, channel: 'whatsapp', phone: '919876543210', part: 1, parts: 2, state: 'sent', sentAt: new Date(+start + 3000) },
      { broadcastId: broadcast._id, leadId, channel: 'email', email: 'a@example.test', part: 0, parts: 1, state: 'pending' },
      { broadcastId: broadcast._id, leadId: other, channel: 'whatsapp', phone: '2', part: 0, parts: 2, state: 'sent', sentAt: new Date(+start + 1000) },
    ]);
    assert.equal((await broadcastReminderCandidates(broadcast._id, start)).length, 0, 'pending or missing original parts do not qualify');
    await BroadcastRecipient.updateOne({ broadcastId: broadcast._id, leadId, channel: 'email' }, { $set: { state: 'sent', sentAt: new Date(+start + 4000) } });
    const candidates = await broadcastReminderCandidates(broadcast._id, start);
    assert.equal(candidates.length, 1); assert.equal(+candidates[0].anchorAt, +start + 4000);
    await Lead.collection.insertOne({ _id: leadId, name: 'Person', status: 'Inquiry', phone: '9876543210', email: 'a@example.test', deletedAt: null });
    assert.ok(await eligibleBroadcastReminder(broadcast._id, leadId, start, candidates[0].anchorAt));
    await Run.init();
    const rule = await Rule.create({ name: 'Follow up', source: 'broadcast', enabled: true, activatedAt: start, revision: 1, createdBy: new mongoose.Types.ObjectId(), steps: [{ offsetDays: 1, subject: 'Hello {{name}}', text: 'Follow up', channel: 'both' }] });
    await Promise.all([planBroadcastReminders(rule, broadcast._id), planBroadcastReminders(rule, broadcast._id)]);
    assert.equal(await Run.countDocuments(), 1, 'replanning never duplicates a lead and step');
    assert.equal((await Run.findOne()).status, 'scheduled');
    const run = await Run.findOne();
    assert.equal((await require('../helpers/communicationReminderEligibility').maySendReminder(run._id, { phone: '919999999999' })).allowed, false, 'an unrecorded destination cannot be used');
    assert.equal((await require('../helpers/communicationReminderEligibility').maySendReminder(run._id, { emails: ['other@example.test'] })).allowed, false, 'an unrecorded email cannot be used');
    await Lead.updateOne({ _id: leadId }, { $set: { status: 'Dead' } });
    assert.equal(await eligibleBroadcastReminder(broadcast._id, leadId, start, candidates[0].anchorAt), null, 'a lead leaving the audience is blocked');
    await Lead.updateOne({ _id: leadId }, { $set: { status: 'Inquiry', phone: '9876543211' } });
    assert.equal(await eligibleBroadcastReminder(broadcast._id, leadId, start, candidates[0].anchorAt), null, 'a changed original number is blocked');
    await Broadcast.updateOne({ _id: broadcast._id }, { $set: { state: 'preparing' } });
    assert.equal((await broadcastReminderCandidates(broadcast._id, start)).length, 0, 'recipient snapshot must be fully prepared');
    await Broadcast.updateOne({ _id: broadcast._id }, { $set: { state: 'ready' } });
    assert.equal((await broadcastReminderCandidates(broadcast._id, new Date(+start + 2000))).length, 0, 'pre-activation broadcasts do not qualify');
  } finally { await mongoose.disconnect(); await db.stop(); }
});

test('broadcast reminder uses only original channels and rechecks the lead before WhatsApp handoff', async () => {
  const db = await MongoMemoryServer.create();
  const old = { fetch: global.fetch, key: process.env.RESEND_API_KEY, from: process.env.FROM_EMAIL, wa: process.env.ENABLE_WHATSAPP };
  try {
    await mongoose.connect(db.getUri());
    const now = Date.now(), leadId = new mongoose.Types.ObjectId(), start = new Date(now - 7200000);
    await Lead.collection.insertOne({ _id: leadId, name: 'Person', status: 'Inquiry', phone: '9876543210', email: 'a@example.test', deletedAt: null });
    const broadcast = await Broadcast.create({ createdBy: new mongoose.Types.ObjectId(), requestKey: 'test', fingerprint: 'x', audience: 'Inquiry', message: 'test', origin: 'new', state: 'ready', acceptanceCompletedAt: new Date(now - 7000000) });
    await BroadcastRecipient.insertMany([
      { broadcastId: broadcast._id, leadId, channel: 'whatsapp', phone: '919876543210', state: 'sent', sentAt: new Date(now - 6000000) },
      { broadcastId: broadcast._id, leadId, channel: 'email', email: 'a@example.test', state: 'sent', sentAt: new Date(now - 6000000) },
    ]);
    const rule = await Rule.create({ name: 'Follow up', source: 'broadcast', enabled: true, activatedAt: start, revision: 1, createdBy: new mongoose.Types.ObjectId(), steps: [{ offsetDays: 0, subject: 'Hello {{name}}', text: 'Follow up', channel: 'both' }] });
    await Run.init();
    let mails = 0; global.fetch = async () => { mails++; return new Response(JSON.stringify({ id: 'isolated' }), { status: 200 }); };
    process.env.RESEND_API_KEY = 'isolated'; process.env.FROM_EMAIL = 'sender@example.test'; process.env.ENABLE_WHATSAPP = 'true';
    const { processBroadcastRule } = require('../helpers/broadcastReminderWorker');
    const jobs = await Promise.all([processBroadcastRule(rule._id), processBroadcastRule(rule._id)]);
    assert.equal(jobs.filter(job => job.claimed).length, 1);
    const run = await Run.findOne();
    assert.equal(run.status, 'queued');
    await processBroadcastRule(rule._id);
    assert.equal(mails, 1);
    const { Queue, State, STATE_ID } = require('../whatsapp/src/models');
    assert.equal(await Queue.countDocuments({ reminderRunId: run._id }), 1);
    const second = await Run.create({ ruleId: rule._id, ruleRevision: rule.revision, source: 'broadcast', occurrenceKey: `${broadcast._id}:${leadId}`, step: 1,
      entityId: broadcast._id, clientId: leadId, anchorAt: run.anchorAt, dueAt: new Date(now - 1000), subject: 'Follow up', text: 'Hello', channel: 'both' });
    const originalCreate = Queue.create;
    try {
      Queue.create = async () => { throw new Error('isolated queue failure'); };
      assert.equal(await require('../helpers/communicationReminderDispatch').dispatchReminder(second._id), 'partial');
    } finally { Queue.create = originalCreate; }
    assert.equal(mails, 2);
    assert.equal((await require('../helpers/communicationReminderRetry').retryQueueFailure(second._id)).status, 'queued');
    assert.equal(mails, 2, 'retry does not repeat accepted broadcast email');
    assert.equal(await Queue.countDocuments({ reminderRunId: second._id }), 1);
    await Lead.updateOne({ _id: leadId }, { $set: { status: 'Dead' } });
    await State.updateOne({ _id: STATE_ID }, { $set: { settings: { quietHours: false, typing: false } } }, { upsert: true });
    let sent = 0;
    const transport = { isConnected: () => true, resolve: async () => 'test@s.whatsapp.net', send: async () => { sent++; return 'test'; } };
    await require('../whatsapp/src/sender').createSender({ Queue, State, transport, config: { timeZone: 'Asia/Kolkata' } }).step();
    assert.equal(sent, 0); assert.equal((await Queue.findOne({ reminderRunId: run._id })).status, 'cancelled');
  } finally {
    global.fetch = old.fetch;
    for (const [key, value] of [['RESEND_API_KEY', old.key], ['FROM_EMAIL', old.from], ['ENABLE_WHATSAPP', old.wa]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await mongoose.disconnect(); await db.stop();
  }
});

test('broadcast worker rotates its bounded scan and resets for late completions', async () => {
  const db = await MongoMemoryServer.create();
  try {
    await mongoose.connect(db.getUri());
    const start = new Date(Date.now() - 60000), actor = new mongoose.Types.ObjectId();
    const rule = await Rule.create({ name: 'Follow up', source: 'broadcast', enabled: true, activatedAt: start, revision: 1, createdBy: actor,
      steps: [{ offsetDays: 1, subject: 'Follow up', text: 'Hello', channel: 'email' }] });
    await Broadcast.insertMany(Array.from({ length: 21 }, (_, i) => ({ createdBy: actor, requestKey: `batch-${i}`, fingerprint: 'x', audience: 'Inquiry', message: 'test', origin: 'new', state: 'ready', acceptanceCompletedAt: new Date() })));
    const { processBroadcastRule } = require('../helpers/broadcastReminderWorker');
    await processBroadcastRule(rule._id);
    const first = await Rule.findById(rule._id).lean(); assert.ok(first.broadcastScanCursor);
    await processBroadcastRule(rule._id);
    const second = await Rule.findById(rule._id).lean(); assert.notEqual(String(first.broadcastScanCursor), String(second.broadcastScanCursor));
    await processBroadcastRule(rule._id);
    assert.equal((await Rule.findById(rule._id).lean()).broadcastScanCursor, undefined);
  } finally { await mongoose.disconnect(); await db.stop(); }
});

test('planning reads the blocked numbers once and still skips a blocked lead', async () => {
  const db = await MongoMemoryServer.create();
  try {
    await mongoose.connect(db.getUri());
    const now = Date.now(), actor = new mongoose.Types.ObjectId(), start = new Date(now - 7200000);
    const [free, blocked, dead] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await Lead.collection.insertMany([
      { _id: free, name: 'Free', status: 'Inquiry', phone: '9876543210', email: 'free@example.test', deletedAt: null },
      { _id: blocked, name: 'Blocked', status: 'Inquiry', phone: '9876543211', email: 'blocked@example.test', deletedAt: null },
      { _id: dead, name: 'Dead person', status: 'Dead', phone: '9876543211', email: 'dead@example.test', deletedAt: null },
    ]);
    const broadcast = await Broadcast.create({ createdBy: actor, requestKey: 'blocks', fingerprint: 'x', audience: 'Inquiry', message: 'test', origin: 'new', state: 'ready', acceptanceCompletedAt: new Date(now - 7000000) });
    const sentAt = new Date(now - 6000000);
    await BroadcastRecipient.insertMany([
      { broadcastId: broadcast._id, leadId: free, channel: 'whatsapp', phone: '919876543210', part: 0, parts: 1, state: 'sent', sentAt },
      { broadcastId: broadcast._id, leadId: free, channel: 'email', email: 'free@example.test', part: 0, parts: 1, state: 'sent', sentAt },
      { broadcastId: broadcast._id, leadId: blocked, channel: 'whatsapp', phone: '919876543211', part: 0, parts: 1, state: 'sent', sentAt },
      { broadcastId: broadcast._id, leadId: blocked, channel: 'email', email: 'blocked@example.test', part: 0, parts: 1, state: 'sent', sentAt },
    ]);
    await Run.init();
    const rule = await Rule.create({ name: 'Follow up', source: 'broadcast', enabled: true, activatedAt: start, revision: 1, createdBy: actor, steps: [{ offsetDays: 1, subject: 'Hello', text: 'Follow up', channel: 'both' }] });
    assert.equal(await planBroadcastReminders(rule, broadcast._id), 1);
    const runs = await Run.find().lean();
    assert.equal(runs.length, 1);
    assert.equal(String(runs[0].clientId), String(free), 'a number blocked through another lead is not scheduled');
    assert.equal(await eligibleBroadcastReminder(broadcast._id, blocked, start, sentAt), null, 'the delivery check still reads the current blocks itself');
  } finally { await mongoose.disconnect(); await db.stop(); }
});
