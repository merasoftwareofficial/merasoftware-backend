const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.RESEND_API_KEY = 'not-a-real-provider-key';
process.env.FROM_EMAIL = 'sender@example.test';
process.env.TOKEN_SECRET_KEY = 'isolated-final-message-secret';

// Real routes, mail scope, review decision, queue, sender, worker listener and job on an isolated database. Only the phone and the mail provider are fake.
const mongoose = require('mongoose');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Lead = require('../models/leadModel');
const User = require('../models/userModel');
const { EmailDraft, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { FinalMessage, Lock, Queue, State, STATE_ID, OutgoingAttempt } = require('../whatsapp/src/models.js');
const { RECOMMENDED } = require('../whatsapp/src/settings.js');
const { createSender } = require('../whatsapp/src/sender.js');
const { createInbound } = require('../whatsapp/src/inbound.js');
const { Inbox, Rule } = require('../whatsapp/src/models.js');
const { requestMiddleware } = require('../helpers/emailController');
const { followFinalMessages } = require('../helpers/finalMessageJobs');
const { audience, GROUPS } = require('../helpers/broadcastAudience');
const leadFileUpload = require('../middleware/leadFileUpload');
const final = require('../controller/lead/finalMessage');

const nativeFetch = global.fetch;
const PHONE = '919876543210';
const HOUR = 3_600_000;
const silent = { error() {}, warn() {}, info() {} };
let db, server, base, admin;
const lead = (fields = {}) => Lead.create({ name: 'Ravi', phone: '9876543210', status: 'Contacted', ...fields });
const cookie = () => `token=${jwt.sign({ _id: String(admin._id), role: 'admin' }, process.env.TOKEN_SECRET_KEY)}`;
async function call(path, method = 'POST', body) {
  const response = await nativeFetch(`${base}${path}`, { method, headers: { Cookie: cookie(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const markNegative = async id => {
  const form = new FormData(); form.append('action', 'followUp'); form.append('badge', 'Negative'); form.append('note', 'Not interested');
  const response = await nativeFetch(`${base}/admin/leads/${id}`, { method: 'POST', headers: { Cookie: cookie() }, body: form });
  return { status: response.status, ...await response.json() };
};
const markNotNow = async id => {
  const form = new FormData(); form.append('action', 'followUp'); form.append('badge', 'NotNow'); form.append('note', 'Needs it later');
  const response = await nativeFetch(`${base}/admin/leads/${id}`, { method: 'POST', headers: { Cookie: cookie() }, body: form });
  return { status: response.status, ...await response.json() };
};
const decide = async (id, choice, channels) => {
  const draft = (await call(`/email-control/drafts/${id}`, 'GET')).data;
  return { draft, result: await call(`/email-control/drafts/${id}/decision`, 'POST', { choice, ...(channels ? { channels } : {}), subject: draft.subject, subjectDoc: draft.templateSubjectDoc, doc: draft.templateDoc || draft.doc, templateId: draft.selectedTemplateId }) };
};
const listening = () => State.updateOne({ _id: STATE_ID }, { $set: { connection: 'connected', heartbeatAt: new Date(), settings: { ...RECOMMENDED, quietHours: false, jitterSec: 0, typing: false, minGapSec: 0 } } }, { upsert: true });
function phone() {
  const sent = [];
  return { sent, isConnected: () => true, resolve: async to => `${to}@s.whatsapp.net`, send: async (jid, text, typing, options = {}) => {
    if (options.beforeSend && !await options.beforeSend()) throw Object.assign(new Error('Cycle changed'), { code: 'FINAL_MESSAGE_CHANGED' });
    sent.push([jid, text]); return options.messageId || `id-${new mongoose.Types.ObjectId()}`;
  } };
}
const sendQueue = async transport => {
  await State.updateOne({ _id: STATE_ID }, { $set: { nextSendAt: null } }); // the real gap between messages is not under test here
  const sender = createSender({ Queue, State, transport, config: { timeZone: 'Asia/Kolkata' } });
  await sender.step();
};
const inbound = createInbound({ Inbox, Queue, Rule, State, logger: silent });
const incoming = (message, at = new Date(), number = PHONE) => inbound.handle({ type: 'notify', messages: [{ key: { id: `m-${Math.random()}`, remoteJid: `${number}@s.whatsapp.net`, fromMe: false }, message, messageTimestamp: Math.floor(at.getTime() / 1000) }] });
const pastDeadline = id => FinalMessage.updateOne({ leadId: id }, { $set: { deadlineAt: new Date(Date.now() - 1000), sentAt: new Date(Date.now() - 100 * HOUR) } });
const row = id => FinalMessage.findOne({ leadId: id }).lean();
const stage = async id => (await Lead.findById(id).lean()).status;

test('client final message follows a sent WhatsApp without changing Matured', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    assert.equal(marked.finalMessage, 'prepared');
    assert.equal((await row(clientLead._id)).subjectKind, 'client');
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
    assert.equal((await call(`/admin/leads/${clientLead._id}`, 'GET')).data.finalMessage.status, 'queued', 'detail reflects queueing before the minute job');
    await sendQueue(phone());
    const delivered = (await call(`/admin/leads/${clientLead._id}`, 'GET')).data;
    assert.equal(delivered.finalMessage.status, 'waiting');
    assert.equal(Date.parse(delivered.finalMessage.deadlineAt) - Date.parse(delivered.finalMessage.sentAt), 24 * HOUR);
    assert.ok(delivered.serverNow);
    await followFinalMessages();
    assert.equal((await row(clientLead._id)).status, 'waiting');
    assert.equal((await audience('Won')).count, 0);
    await pastDeadline(clientLead._id);
    await followFinalMessages();
    const saved = await Lead.findById(clientLead._id).lean();
    assert.equal(saved.status, 'Won');
    assert.equal(saved.clientBehaviour, 'Dead');
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('client reply stays Negative for a decision and stale behaviour cancels an old wait', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
    await sendQueue(phone()); await followFinalMessages();
    await incoming({ conversation: 'Please call me' }, new Date(Date.now() + 5000));
    await followFinalMessages();
    assert.equal((await row(clientLead._id)).status, 'replied');
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Negative');
    const list = await call('/auto-reply/final-message', 'GET');
    assert.equal(list.data.needsDecision.length, 1);
    await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Positive' });
    const decision = await call('/auto-reply/final-message/decision', 'POST', { id: String((await row(clientLead._id))._id), choice: 'dead' });
    assert.equal(decision.status, 409);
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Positive');
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('client audit reports safe missing records and flags uncertain matches without writing', async () => {
  const { auditClientFinalMessages } = require('../scripts/auditClientFinalMessages');
  const linked = await User.create({ name: 'Linked', email: 'linked@example.test', phone: '9000000011', roles: ['customer'] });
  await lead({ name: 'Linked', phone: '9000000011', status: 'Won', convertedToUserId: linked._id });
  const missing = await User.create({ name: 'Missing', email: 'missing@example.test', phone: '9000000012', roles: ['customer'] });
  await User.create({ name: 'Ambiguous', email: 'ambiguous@example.test', phone: '9000000013', roles: ['customer'] });
  await lead({ phone: '9000000013', email: 'ambiguous@example.test' });
  const before = await Lead.countDocuments();
  const result = await auditClientFinalMessages();
  assert.equal(result.clients, 3); assert.equal(result.linked, 1); assert.equal(result.missing, 1); assert.equal(result.ambiguous, 1);
  assert.deepEqual(result.candidates, [String(missing._id)]);
  assert.equal(await Lead.countDocuments(), before);
});

test('already Negative clients appear in a separate batch and each message stays in review', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id, clientBehaviour: 'Negative' });
    const counts = await call('/admin/final-message/count', 'GET');
    assert.equal(counts.data.clientCount, 1);
    const prepared = await call('/admin/final-message/prepare?scope=client', 'POST');
    assert.equal(prepared.data.prepared, 1);
    assert.equal((await row(clientLead._id)).status, 'review');
    assert.equal(await Queue.countDocuments(), 0);
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('starting a new client episode preserves the previous decision and does not send automatically', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
    await sendQueue(phone()); await followFinalMessages();
    await incoming({ conversation: 'Please call me' }, new Date(Date.now() + 5000));
    await followFinalMessages();
    const previous = await row(clientLead._id);
    assert.equal((await call('/auto-reply/final-message/decision', 'POST', { id: String(previous._id), choice: 'keep' })).status, 200);
    const next = await call(`/admin/leads/${clientLead._id}/final-message?new=1`, 'POST');
    assert.equal(next.status, 200);
    const current = await row(clientLead._id);
    assert.equal(current.status, 'review');
    assert.notEqual(current.episodeId, previous.episodeId);
    assert.equal(current.episodeHistory.at(-1).decision, 'keep');
    assert.equal(current.episodeHistory.at(-1).lastReplyText, 'Please call me');
    assert.equal(await Queue.countDocuments(), 1);
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('concurrent client preparation creates only one tracked draft', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id, clientBehaviour: 'Negative' });
    const results = await Promise.all([call(`/admin/leads/${clientLead._id}/final-message`, 'POST'), call(`/admin/leads/${clientLead._id}/final-message`, 'POST')]);
    assert.ok(results.some(result => result.status === 200));
    assert.equal(await FinalMessage.countDocuments({ leadId: clientLead._id }), 1);
    assert.ok(await EmailDraft.findById((await row(clientLead._id)).draftId));
    assert.equal(await EmailDraft.countDocuments({ event: 'lead.finalMessage' }), 1);
    assert.equal(await Queue.countDocuments(), 0);
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('client timeout aborts completely on a database failure and succeeds on retry', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  const original = Lead.updateOne;
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp'); await sendQueue(phone()); await followFinalMessages();
    await pastDeadline(clientLead._id);
    Lead.updateOne = function (filter, update, options) {
      if (update?.$set?.clientBehaviour === 'Dead') throw new Error('simulated database failure');
      return original.call(this, filter, update, options);
    };
    await followFinalMessages();
    assert.equal((await row(clientLead._id)).status, 'waiting');
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Negative');
    Lead.updateOne = original;
    await followFinalMessages();
    assert.equal((await row(clientLead._id)).status, 'dead');
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Dead');
  } finally { Lead.updateOne = original; delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('a reply arriving just before client timeout claim prevents Dead', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  const original = FinalMessage.updateOne;
  let injected = false;
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp'); await sendQueue(phone()); await followFinalMessages();
    await pastDeadline(clientLead._id);
    FinalMessage.updateOne = function (filter, update, options) {
      if (!injected && update?.$set?.status === 'dead') {
        injected = true;
        return original.call(this, { _id: filter._id }, { $set: { lastReplyAt: new Date(), lastReplyText: 'Please call me' } }).then(() => original.call(this, filter, update, options));
      }
      return original.call(this, filter, update, options);
    };
    await followFinalMessages();
    FinalMessage.updateOne = original;
    await followFinalMessages();
    assert.equal((await row(clientLead._id)).status, 'replied');
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Negative');
  } finally { FinalMessage.updateOne = original; delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('a late final-message reply is retained when the ad inbox also processes it', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp'); await sendQueue(phone()); await followFinalMessages();
    await pastDeadline(clientLead._id); await followFinalMessages();
    await incoming({ conversation: 'Please call me' });
    await require('../helpers/leadPhone').clearClientDead({ convertedToUserId: user._id }, { preserveFinalReply: true });
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Dead');
    await followFinalMessages();
    assert.equal((await row(clientLead._id)).status, 'replied');
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Negative');
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('client reply decision rolls back if the behaviour update fails', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  const original = Lead.updateOne;
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp'); await sendQueue(phone()); await followFinalMessages();
    await incoming({ conversation: 'Please call me' }, new Date(Date.now() + 5000)); await followFinalMessages();
    const reply = await row(clientLead._id);
    Lead.updateOne = function (filter, update, options) {
      if (update?.$set?.clientBehaviour === 'Dead') throw new Error('simulated database failure');
      return original.call(this, filter, update, options);
    };
    assert.equal((await call('/auto-reply/final-message/decision', 'POST', { id: String(reply._id), choice: 'dead' })).success, false);
    assert.equal((await row(clientLead._id)).decision, undefined);
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Negative');
    Lead.updateOne = original;
    assert.equal((await call('/auto-reply/final-message/decision', 'POST', { id: String(reply._id), choice: 'dead' })).status, 200);
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Dead');
  } finally { Lead.updateOne = original; delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('disabling client automation stops a waiting episode without affecting the client', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp'); await sendQueue(phone()); await followFinalMessages();
    delete process.env.CLIENT_FINAL_MESSAGE_ENABLED;
    await followFinalMessages();
    assert.equal((await row(clientLead._id)).status, 'stopped');
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Negative');
    process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
    await pastDeadline(clientLead._id); await followFinalMessages();
    assert.equal((await row(clientLead._id)).status, 'stopped');
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Negative');
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('a client with a conflicting active message is excluded from batch count and preparation', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    await lead({ status: 'Won', convertedToUserId: user._id, clientBehaviour: 'Negative' });
    const other = await lead({ phone: '9876543210', status: 'Negative' });
    await FinalMessage.create({ leadId: other._id, phone: PHONE, hours: 24, status: 'waiting' });
    assert.equal((await call('/admin/final-message/count', 'GET')).data.clientCount, 0);
    assert.equal((await call('/admin/final-message/prepare?scope=client', 'POST')).data.prepared, 0);
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('client migration requires a unique index and a saved plan and is repeatable', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'client-migration-'));
  const filename = path.join(directory, 'plan.json');
  const indexName = 'test_unique_client_migration';
  try {
    const user = await User.create({ name: 'Legacy', email: 'legacy@example.test', phone: '9000000091', roles: ['customer'] });
    const { preparePlan, applyPlan } = require('../scripts/migrateClientFinalMessages');
    const plan = await preparePlan(filename);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].clientId, String(user._id));
    await assert.rejects(applyPlan(filename), /maintenance window/);
    await assert.rejects(applyPlan(filename, { maintenance: true }), /unique partial index/);
    await Lead.collection.createIndex({ convertedToUserId: 1 }, { name: indexName, unique: true, partialFilterExpression: { convertedToUserId: { $type: 'objectId' } } });
    assert.deepEqual(await applyPlan(filename, { maintenance: true }), { created: 1, alreadyCreated: 0, skipped: 0 });
    assert.deepEqual(await applyPlan(filename, { maintenance: true }), { created: 0, alreadyCreated: 1, skipped: 0 });
    assert.equal((await Lead.findById(plan.items[0].leadId).lean()).status, 'Won');
    assert.equal(await Queue.countDocuments(), 0);
  } finally {
    const indexes = await Lead.collection.indexes();
    if (indexes.some(index => index.name === indexName)) await Lead.collection.dropIndex(indexName);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
async function sentAndWaiting(fields) {
  const { _id } = await lead(fields);
  const marked = await markNegative(_id);
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  const transport = phone();
  await sendQueue(transport);
  await followFinalMessages();
  return { id: _id, transport };
}

before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = db.getUri();
  await mongoose.connect(db.getUri(), { dbName: 'final-message-isolated-test' });
  await Promise.all([Queue.init(), Lead.init(), FinalMessage.init()]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const authToken = require('../middleware/authToken');
  app.use('/api', requestMiddleware);
  app.use('/api/email-control', require('../routes/emailControl'));
  app.use('/api/auto-reply', require('../routes/autoReply'));
  app.use('/api/offer-targets', require('../routes/offerTargets'));
  app.post('/api/admin/leads/:leadId', authToken, leadFileUpload, require('../controller/lead/updateLead'));
  app.get('/api/admin/leads/:leadId', authToken, require('../controller/lead/getLeadDetail'));
  app.get('/api/admin/final-message/count', authToken, final.countController);
  app.post('/api/admin/final-message/prepare', authToken, final.prepareAllController);
  app.post('/api/admin/leads/:leadId/final-message', authToken, final.prepareOneController);
  app.post('/api/admin/leads/:leadId/final-message/stop', authToken, final.stopController);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  global.fetch = async () => new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 });
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true';
  await Promise.all([Lead, User, EmailDraft, EmailPolicy, EmailTemplate, Queue, FinalMessage, State, Lock, OutgoingAttempt].map(model => model.deleteMany({})));
  admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
  await listening();
});
after(async () => {
  global.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('Not Now opens the existing final template without starting a countdown, including after sending and replying', async () => {
  const { _id } = await lead();
  const marked = await markNotNow(_id);
  assert.equal(marked.success, true);
  assert.equal((await Lead.findById(_id).lean()).status, 'NotNow');
  assert.equal(marked.emailDraftIds.length, 1);
  assert.equal((await EmailDraft.findById(marked.emailDraftIds[0]).lean()).event, 'lead.finalMessage');
  assert.equal(await FinalMessage.countDocuments(), 0);
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  await sendQueue(phone());
  await incoming({ conversation: 'Please call me' });
  await followFinalMessages();
  assert.equal((await Lead.findById(_id).lean()).status, 'NotNow');
  assert.equal(await FinalMessage.countDocuments(), 0);
});

test('Not Now follow-ups work repeatedly for clients without a countdown', async () => {
  const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
  const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
  for (let attempt = 0; attempt < 2; attempt++) {
    const marked = await markNotNow(clientLead._id);
    assert.equal(marked.success, true);
    assert.equal(marked.emailDraftIds.length, 1);
    assert.equal((await EmailDraft.findById(marked.emailDraftIds[0]).lean()).event, 'lead.finalMessage');
    await decide(marked.emailDraftIds[0], 'skip');
  }
  const saved = await Lead.findById(clientLead._id).lean();
  assert.equal(saved.status, 'Won');
  assert.equal(saved.clientBehaviour, 'NotNow');
  assert.equal(await FinalMessage.countDocuments(), 0);
});

test('Not Now saves even if final-message template is disabled', async () => {
  const { _id } = await lead({ name: '', status: 'Inquiry' });
  await EmailPolicy.create({ event: 'lead.finalMessage', mode: 'off' });
  const marked = await markNotNow(_id);
  assert.equal(marked.success, true);
  assert.equal((await Lead.findById(_id).lean()).status, 'NotNow');
  assert.equal(marked.emailDraftIds?.length || 0, 0);
  assert.match(marked.finalMessageNote, /unavailable/i);
  assert.equal(await FinalMessage.countDocuments(), 0);
});

test('moving a waiting Negative lead to Not Now stops the old cycle before preparing the ordinary review', async () => {
  const { id } = await sentAndWaiting();
  const marked = await markNotNow(id);
  assert.equal(marked.success, true);
  assert.equal(marked.emailDraftIds.length, 1);
  assert.equal((await row(id)).status, 'stopped');
  assert.equal((await Lead.findById(id).lean()).status, 'NotNow');
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  await sendQueue(phone());
  await followFinalMessages();
  assert.equal((await row(id)).status, 'stopped');
  assert.equal((await Lead.findById(id).lean()).status, 'NotNow');
});

test('Not Now review supports email, WhatsApp and both without creating a timer', async () => {
  for (const [channel, number] of [['email', '9000000011'], ['whatsapp', '9000000012'], ['both', '9000000013']]) {
    const { _id } = await lead({ phone: number, email: `${channel}@example.test` });
    const marked = await markNotNow(_id);
    const { result } = await decide(marked.emailDraftIds[0], 'send', channel);
    assert.equal(result.success, true, channel);
    assert.equal((await Lead.findById(_id).lean()).status, 'NotNow');
    assert.equal(await FinalMessage.countDocuments({ leadId: _id }), 0);
  }
});

test('expiry uses the editable template, quotes the original and queues once across repeated jobs and queue retention', async () => {
  const { id } = await sentAndWaiting();
  const original = await Queue.findOne({ event: 'lead.finalMessage' }).lean();
  const template = await require('../helpers/emailTemplates').systemTemplate('lead.finalMessageExpired');
  assert.match(template.text, /^Your offer period has ended/);
  assert.doesNotMatch(template.text, /24|hours|timeLimit/);
  await EmailTemplate.updateOne({ _id: template._id }, { $set: { text: 'Your offer period has ended. Visit www.merasoftware.com.' } });
  await pastDeadline(id);
  await followFinalMessages();
  await followFinalMessages();
  const item = await Queue.findOne({ event: 'lead.finalMessageExpired' }).lean();
  assert.equal(item.text, 'Your offer period has ended. Visit www.merasoftware.com.');
  assert.equal(item.quotedMessage.id, original.messageId);
  assert.equal(item.quotedMessage.chat, original.messageChat);
  assert.equal(item.quotedMessage.text, original.text);
  assert.equal(String(item.finalMessageExpiryId), String((await row(id)).draftId));
  assert.equal(await Queue.countDocuments({ event: 'lead.finalMessageExpired' }), 1);
  let options;
  const transport = phone();
  const send = transport.send;
  transport.send = async (...args) => { options = args[3]; return send(...args); };
  await sendQueue(transport);
  assert.deepEqual(options.quoted.key, { remoteJid: original.messageChat, id: original.messageId, fromMe: true });
  assert.equal(options.quoted.message.conversation, original.text);
  assert.equal((await Queue.findById(item._id)).status, 'sent');
  await Queue.deleteOne({ _id: item._id });
  await followFinalMessages();
  assert.equal(await Queue.countDocuments({ event: 'lead.finalMessageExpired' }), 0, 'permanent marker survives TTL');
});

test('pending expiry is cancelled for a real reply, a changed stage or changed phone; historical cycles send nothing', async () => {
  for (const change of ['reply', 'stage', 'phone', 'historical']) {
    await Promise.all([Queue.deleteMany({}), FinalMessage.deleteMany({}), Lead.deleteMany({})]);
    const { id } = await sentAndWaiting();
    if (change === 'historical') await FinalMessage.updateOne({ leadId: id }, { $unset: { expiryEnabled: 1 } });
    await pastDeadline(id);
    await followFinalMessages();
    if (change === 'historical') {
      assert.equal(await Queue.countDocuments({ event: 'lead.finalMessageExpired' }), 0);
      continue;
    }
    if (change === 'reply') await incoming({ conversation: 'Please tell me more' });
    if (change === 'stage') await Lead.updateOne({ _id: id }, { $set: { status: 'Contacted' } });
    if (change === 'phone') await Lead.updateOne({ _id: id }, { $set: { phone: '9876543211' } });
    const transport = phone();
    await sendQueue(transport);
    assert.equal(transport.sent.length, 0, change);
    assert.equal((await Queue.findOne({ event: 'lead.finalMessageExpired' })).status, 'cancelled', change);
  }
});

test('expiry transaction rolls back insertion failure and retries without duplicates; policy off postpones queueing', async () => {
  const { id } = await sentAndWaiting();
  await pastDeadline(id);
  await EmailPolicy.create({ event: 'lead.finalMessageExpired', mode: 'off' });
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
  assert.equal(await Queue.countDocuments({ event: 'lead.finalMessageExpired' }), 0);
  await EmailPolicy.updateOne({ event: 'lead.finalMessageExpired' }, { $set: { mode: 'auto' } });
  const create = Queue.create;
  Queue.create = async () => { throw new Error('expiry insert failed'); };
  try { await assert.rejects(followFinalMessages(), /expiry insert failed/); }
  finally { Queue.create = create; }
  assert.equal((await row(id)).expiryQueuedAt, undefined);
  await followFinalMessages();
  assert.equal(await Queue.countDocuments({ event: 'lead.finalMessageExpired' }), 1);
  assert.ok((await row(id)).expiryQueuedAt);
});

test('a client is checked before Negative is saved: disabled automation and phone mismatch refuse it; Review reopens the same draft', async () => {
  const account = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543211', roles: ['customer'] });
  const item = await lead({ status: 'Won', convertedToUserId: account._id });
  delete process.env.CLIENT_FINAL_MESSAGE_ENABLED;
  let result = await call(`/admin/leads/${item._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
  assert.equal(result.status, 409);
  assert.equal(result.finalMessageReadiness.code, 'automation-disabled');
  assert.match(result.message, /disabled on the server/);
  assert.equal(result.emailDraftIds, undefined);
  assert.equal((await Lead.findById(item._id).lean()).clientBehaviour, undefined, 'nothing is saved');
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    result = await call(`/admin/leads/${item._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    assert.equal(result.finalMessageReadiness.code, 'phone-mismatch');
    assert.equal((await Lead.findById(item._id).lean()).clientBehaviour, undefined);
    await User.updateOne({ _id: account._id }, { $set: { phone: item.phone } });
    result = await call(`/admin/leads/${item._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    assert.equal(result.finalMessage, 'prepared');
    const repeated = await call(`/admin/leads/${item._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    assert.equal(repeated.emailDraftIds, undefined, 'saving the same status prepares nothing');
    const again = await call(`/admin/leads/${item._id}/final-message`);
    assert.deepEqual(again.emailDraftIds, result.emailDraftIds);
    assert.equal(await EmailDraft.countDocuments({ event: 'lead.finalMessage' }), 1);
    assert.equal(await Queue.countDocuments(), 0);
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('both behaviour APIs share one transition and Review resumes the same tracked client review', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const account = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const item = await lead({ status: 'Won', convertedToUserId: account._id });
    const offer = await call(`/offer-targets/leads/${item._id}/behaviour`, 'PATCH', { behaviour: 'Negative' });
    assert.equal(offer.data.finalMessage, 'prepared');
    assert.equal(offer.emailStatus, 'awaiting-review');
    const portal = await call(`/admin/leads/${item._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    assert.equal(portal.emailDraftIds, undefined, 'already Negative: nothing new');
    const review = await call(`/admin/leads/${item._id}/final-message`);
    assert.deepEqual(review.emailDraftIds, offer.emailDraftIds);
    assert.equal((await row(item._id)).subjectKind, 'client');
    assert.equal(await Queue.countDocuments(), 0);
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('client draft-link failure hides the orphan review, blocks Send and recovers one draft with its promised hours', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  const update = FinalMessage.updateOne;
  try {
    const account = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const item = await lead({ status: 'Won', convertedToUserId: account._id });
    FinalMessage.updateOne = async (...args) => { if (args[1]?.$set?.status === 'review') throw new Error('link interrupted'); return update.apply(FinalMessage, args); };
    const result = await call(`/admin/leads/${item._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    FinalMessage.updateOne = update;
    assert.equal(result.finalMessage, 'unavailable');
    assert.equal(result.emailDraftIds, undefined);
    const orphan = await EmailDraft.findOne({ event: 'lead.finalMessage' }).lean();
    await assert.rejects(require('../helpers/emailController').decide(String(orphan._id), String(admin._id), { choice: 'send' }, { application: 'portal', portalAdmin: true }), /not tracked yet/);
    await call('/auto-reply/final-message/time', 'POST', { hours: 72 });
    const recovered = await call(`/admin/leads/${item._id}/final-message`);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.emailDraftIds[0], String(orphan._id));
    assert.equal(await EmailDraft.countDocuments({ event: 'lead.finalMessage' }), 1);
    assert.equal((await row(item._id)).hours, 24);
    assert.equal(await Queue.countDocuments(), 0);
  } finally { FinalMessage.updateOne = update; delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('expired client review can be recovered without changing the saved Negative status', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const account = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const item = await lead({ status: 'Won', convertedToUserId: account._id });
    const first = await call(`/admin/leads/${item._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await EmailDraft.updateOne({ _id: first.emailDraftIds[0] }, { $set: { expiresAt: new Date(0) } });
    const second = await call(`/admin/leads/${item._id}/final-message`);
    assert.equal(second.status, 200);
    assert.notEqual(second.emailDraftIds[0], first.emailDraftIds[0]);
    assert.equal((await Lead.findById(item._id)).clientBehaviour, 'Negative');
    assert.equal(await Queue.countDocuments(), 0);
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('explicit legacy replacement refuses mid-send and preserves history while cancelling only unsent work', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const account = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const item = await lead({ status: 'Won', convertedToUserId: account._id, clientBehaviour: 'Negative' });
    const oldDraft = new mongoose.Types.ObjectId();
    const queued = await Queue.create({ emailDraftId: oldDraft, to: PHONE, text: 'Old lead message', status: 'sending' });
    await FinalMessage.create({ leadId: item._id, draftId: oldDraft, subjectKind: 'lead', phone: PHONE, hours: 24, status: 'queued' });
    assert.equal((await call(`/admin/leads/${item._id}/final-message?new=1`)).status, 409);
    await Queue.updateOne({ _id: queued._id }, { $set: { status: 'pending' } });
    const result = await call(`/admin/leads/${item._id}/final-message?new=1`);
    assert.equal(result.status, 200);
    assert.equal((await Queue.findById(queued._id)).status, 'cancelled');
    const cycle = await row(item._id);
    assert.equal(cycle.subjectKind, 'client');
    assert.equal(cycle.episodeHistory.length, 1);
    assert.equal(String(cycle.episodeHistory[0].draftId), String(oldDraft));
    assert.equal((await Lead.findById(item._id)).status, 'Won');
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('a queued client message cannot send after its current status or phone changes', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const account = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const item = await lead({ status: 'Won', convertedToUserId: account._id });
    const response = await call(`/admin/leads/${item._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(response.emailDraftIds[0], 'send', 'whatsapp');
    await call(`/admin/leads/${item._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Active' });
    const transport = phone();
    await sendQueue(transport);
    assert.equal(transport.sent.length, 0);
    assert.equal((await Queue.findOne({ emailDraftId: response.emailDraftIds[0] })).status, 'cancelled');
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('client readiness differentiates account, identity and phone blockers without mutating records', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const { clientReadiness } = require('../helpers/clientFinalMessageReadiness');
    const account = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const item = await lead({ status: 'Won', convertedToUserId: account._id, clientBehaviour: 'Negative' });
    const current = await Lead.findById(item._id).lean();
    assert.equal((await clientReadiness({ ...current, convertedToUserId: null })).code, 'client-link-missing');
    assert.equal((await clientReadiness({ ...current, deletedAt: new Date() })).code, 'lead-unavailable');
    assert.equal((await clientReadiness({ ...current, clientBehaviour: 'Active' })).code, 'client-state');
    assert.equal((await clientReadiness({ ...current, phone: '123' })).code, 'invalid-phone');
    await EmailPolicy.create({ event: 'lead.finalMessage', mode: 'off' });
    assert.equal((await require('../helpers/clientFinalMessageReadiness').clientStartReadiness(current)).code, 'template-disabled');
    assert.equal((await clientReadiness(current)).ready, true, 'template Off blocks new preparation, not an existing timer');
    await EmailPolicy.deleteMany({});
    const duplicate = await lead({ phone: '9876543211', status: 'Won', convertedToUserId: account._id });
    assert.equal((await clientReadiness(current)).code, 'duplicate-links');
    await Lead.deleteOne({ _id: duplicate._id });
    await User.create({ name: 'Shared', email: 'shared@example.test', phone: '+91 98765 43210', roles: ['customer'] });
    assert.equal((await clientReadiness(current)).code, 'shared-phone');
    await User.updateOne({ _id: account._id }, { $set: { deletedAt: new Date() } });
    assert.equal((await clientReadiness(current)).code, 'account-unavailable');
    assert.equal((await Lead.findById(item._id)).clientBehaviour, 'Negative');
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('manual stop preserves current status and deadline, is idempotent, rejects a stale cycle, and Start begins a new cycle', async () => {
  const { id } = await sentAndWaiting();
  const before = await row(id);
  const path = `/admin/leads/${id}/final-message/stop`;
  const customer = await User.create({ name: 'Member', email: 'member-stop@example.test', roles: ['customer'] });
  const denied = await nativeFetch(`${base}${path}`, { method: 'POST', headers: { Cookie: `token=${jwt.sign({ _id: String(customer._id), role: 'customer' }, process.env.TOKEN_SECRET_KEY)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ draftId: String(before.draftId), reason: 'Phone call' }) });
  assert.equal(denied.status, 403);
  assert.equal((await call(path, 'POST', { draftId: String(new mongoose.Types.ObjectId()), reason: 'Phone call' })).status, 409);
  assert.equal((await call(path, 'POST', { draftId: String(before.draftId), reason: '' })).status, 400);
  const stopped = await call(path, 'POST', { draftId: String(before.draftId), reason: 'Client asked by phone' });
  assert.equal(stopped.status, 200);
  assert.equal((await row(id)).status, 'stopped');
  assert.equal(await stage(id), 'Negative');
  assert.equal(+new Date((await row(id)).deadlineAt), +before.deadlineAt);
  assert.equal((await call(path, 'POST', { draftId: String(before.draftId), reason: 'Again' })).data.alreadyStopped, true);
  await pastDeadline(id); await followFinalMessages();
  assert.equal(await stage(id), 'Negative');
  assert.equal(await Queue.countDocuments({ event: 'lead.finalMessageExpired' }), 0);
  assert.equal((await Lead.findById(id)).followUps.filter(x => x.note.includes('countdown stopped:')).length, 1);
  assert.equal((await call(`/admin/leads/${id}/final-message`)).status, 200, 'a stopped cycle has ended, so Start final message begins a new one');
  assert.equal((await row(id)).stopSource, undefined);
  assert.equal((await row(id)).episodeHistory.length, 1);
});

test('stop cancels a queued closure but does not pretend an in-flight or sent closure can be recalled', async () => {
  const { id } = await sentAndWaiting();
  await pastDeadline(id); await followFinalMessages();
  const cycle = await row(id);
  const expiry = await Queue.findOne({ finalMessageExpiryId: cycle.draftId });
  await Queue.updateOne({ _id: expiry._id }, { $set: { status: 'sending' } });
  const path = `/admin/leads/${id}/final-message/stop`;
  assert.equal((await call(path, 'POST', { draftId: String(cycle.draftId), reason: 'Phone call' })).status, 409);
  await Queue.updateOne({ _id: expiry._id }, { $set: { status: 'sent' } });
  assert.match((await call(path, 'POST', { draftId: String(cycle.draftId), reason: 'Phone call' })).message, /already been sent/);
  await Queue.updateOne({ _id: expiry._id }, { $set: { status: 'pending' } });
  assert.equal((await call(path, 'POST', { draftId: String(cycle.draftId), reason: 'Phone call' })).status, 200);
  assert.equal((await Queue.findById(expiry._id)).status, 'cancelled');
  assert.equal(await stage(id), 'Dead', 'stopping does not alter the saved status');
});

test('our normal chat and system manual message stop the countdown independently of Auto Reply switches; automated sends do not', async () => {
  for (const kind of ['automated', 'phone', 'system-manual']) {
    await Promise.all([FinalMessage.deleteMany({}), Queue.deleteMany({}), Lead.deleteMany({})]);
    const { id } = await sentAndWaiting();
    await FinalMessage.updateOne({ leadId: id }, { $set: { sentAt: new Date(Date.now() - 5000) } });
    const messageId = `our-${kind}`;
    if (kind !== 'phone') await Queue.create({ to: PHONE, text: 'A message', status: 'sent', messageId, event: kind === 'automated' ? 'sendProjectCreatedEmail' : 'lead.message' });
    await State.updateOne({ _id: STATE_ID }, { $set: { 'autoReply.recognise': false } });
    await inbound.handle({ type: 'notify', messages: [{ key: { id: messageId, remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true }, message: { conversation: 'We discussed this by phone' }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
    assert.equal((await row(id)).status, kind === 'automated' ? 'waiting' : 'stopped', kind);
    assert.equal(await stage(id), 'Negative');
  }
});

test('outgoing echo arriving before its queue result defers timeout and is classified after the sender settles', async () => {
  const { id } = await sentAndWaiting();
  await pastDeadline(id);
  const pending = await Queue.create({ to: PHONE, text: 'Service notification', event: 'sendProjectCreatedEmail', status: 'sending' });
  const message = { key: { id: 'early-echo', remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true }, message: { conversation: 'Service notification' }, messageTimestamp: Math.floor(Date.now() / 1000) };
  await inbound.handle({ type: 'notify', messages: [message] });
  await followFinalMessages();
  assert.equal((await row(id)).status, 'waiting');
  await Queue.updateOne({ _id: pending._id }, { $set: { status: 'sent', messageId: 'early-echo' } });
  await followFinalMessages();
  assert.equal((await row(id)).status, 'dead', 'an automated echo must not stop its own flow');
});

test('system manual sends stop the cycle without requiring a WhatsApp echo, whereas service sends do not', async () => {
  const { id } = await sentAndWaiting();
  await Queue.create({ to: PHONE, text: 'Service notification', event: 'sendProjectCreatedEmail' });
  await sendQueue(phone());
  assert.equal((await row(id)).status, 'waiting');
  await Queue.create({ to: PHONE, text: 'We spoke by phone', event: 'lead.message' });
  await sendQueue(phone());
  assert.equal((await row(id)).status, 'stopped');
  assert.equal((await row(id)).stopSource, 'outgoing');
});

test('a stop committed just before timeout prevents Dead and closure atomically', async () => {
  const { id } = await sentAndWaiting();
  await pastDeadline(id);
  const current = await row(id);
  const update = FinalMessage.updateOne;
  let intervened = false;
  FinalMessage.updateOne = async function(filter, change, options) {
    if (!intervened && filter.status === 'waiting' && change?.$set?.status === 'dead') {
      intervened = true;
      await require('../helpers/stopFinalMessage').stopCycle(current, { reason: 'Stop before timeout', actor: admin._id });
    }
    return update.call(this, filter, change, options);
  };
  try { await followFinalMessages(); }
  finally { FinalMessage.updateOne = update; }
  assert.equal(intervened, true);
  assert.equal((await row(id)).status, 'stopped');
  assert.equal(await stage(id), 'Negative');
  assert.equal(await Queue.countDocuments({ event: 'lead.finalMessageExpired' }), 0);
});

test('an automated echo with a lost acknowledgement never becomes a manual Stop', async () => {
  const { id } = await sentAndWaiting();
  const pending = await Queue.create({ to: PHONE, text: 'Notification', event: 'sendProjectCreatedEmail', status: 'sending' });
  await require('../helpers/stopFinalMessage').noteOutgoing(PHONE, 'lost-ack', new Date());
  await Queue.updateOne({ _id: pending._id }, { $set: { status: 'failed' } });
  const result = await require('../helpers/stopFinalMessage').processOutbound(await row(id));
  assert.equal(result, 'pending', 'unknown legacy delivery requires reconciliation');
  assert.equal((await row(id)).status, 'waiting');
});

test('a background queue cancellation cannot overwrite a committed manual Stop', async () => {
  const item = await lead();
  const marked = await markNegative(item._id);
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  await followFinalMessages();
  await Lead.updateOne({ _id: item._id }, { $set: { status: 'Contacted' } });
  const current = await row(item._id);
  const cycle = require('../helpers/finalMessageCycle');
  const reconcile = cycle.reconcileCycle;
  cycle.reconcileCycle = async () => null; // as if a send had been in flight when the stage moved
  const update = Queue.updateOne;
  let stopped = false;
  Queue.updateOne = async function(filter, change, options) {
    const result = await update.call(this, filter, change, options);
    if (!stopped && change?.$set?.status === 'cancelled') {
      stopped = true;
      await require('../helpers/stopFinalMessage').stopCycle(current, { reason: 'Called by phone', actor: admin._id });
    }
    return result;
  };
  try { await followFinalMessages(); } finally { Queue.updateOne = update; cycle.reconcileCycle = reconcile; }
  assert.equal(stopped, true);
  assert.equal((await row(item._id)).status, 'stopped');
});

test('manual template provenance survives removal of its temporary draft', async () => {
  const { id } = await sentAndWaiting();
  const draft = await EmailDraft.create({ event: 'lead.proposal', leadId: id, application: 'portal', to: ['ravi@example.test'], subject: 'Proposal', plain: 'Following our call', status: 'sent', expiresAt: new Date(Date.now() + HOUR) });
  await require('../helpers/whatsappQueue').enqueueWhatsAppForEmail(draft, { recipients: [{ email: 'ravi@example.test', phone: PHONE }], strict: true });
  await EmailDraft.deleteOne({ _id: draft._id });
  const queued = await Queue.findOne({ emailDraftId: draft._id });
  await Queue.updateOne({ _id: queued._id }, { $set: { status: 'sent', messageId: 'manual-template' } });
  await require('../helpers/stopFinalMessage').noteOutgoing(PHONE, 'manual-template', new Date());
  assert.equal((await row(id)).status, 'stopped');
});

test('Stop during typing cancels the closure before the transport handoff', async () => {
  const { id } = await sentAndWaiting();
  await pastDeadline(id); await followFinalMessages();
  const cycle = await row(id);
  let delivered = false;
  const transport = { ...phone(), async send(jid, text, typingMs, options) {
    const result = await call(`/admin/leads/${id}/final-message/stop`, 'POST', { draftId: String(cycle.draftId), reason: 'Stop during typing' });
    assert.equal(result.status, 200);
    if (!await options.beforeSend()) throw Object.assign(new Error('Stopped'), { code: 'FINAL_MESSAGE_CHANGED' });
    delivered = true;
    return options.messageId;
  } };
  await sendQueue(transport);
  assert.equal(delivered, false);
  assert.equal((await row(id)).status, 'stopped');
  assert.equal((await Queue.findOne({ finalMessageExpiryId: cycle.draftId })).status, 'cancelled');
});

test('an acknowledged-lost automated attempt retains its identity across queue retention and duplicate delayed echoes', async () => {
  const { id } = await sentAndWaiting();
  const notification = await require('../helpers/whatsappQueue').enqueueWhatsApp({ to: PHONE, text: 'Notification', event: 'sendProjectCreatedEmail' });
  let identity;
  const transport = { ...phone(), async send(jid, text, typing, options) {
    identity = options.messageId;
    const saved = await OutgoingAttempt.findById(identity).lean();
    assert.equal(saved.source, 'automated');
    assert.equal(saved.phase, 'preparing');
    assert.equal(await options.beforeSend(), true);
    await require('../helpers/stopFinalMessage').noteOutgoing(PHONE, identity, new Date());
    assert.equal((await row(id)).status, 'waiting');
    throw new Error('Acknowledgement lost after handoff');
  } };
  await sendQueue(transport);
  assert.equal((await Queue.findById(notification._id)).status, 'failed', 'ambiguous handoff must not retry automatically');
  await Queue.deleteOne({ _id: notification._id });
  for (let i = 0; i < 2; i++) await require('../helpers/stopFinalMessage').noteOutgoing(PHONE, identity, new Date());
  assert.equal((await row(id)).status, 'waiting');
  await pastDeadline(id); await followFinalMessages();
  assert.equal((await row(id)).status, 'dead');
});

test('a manual system attempt stops the cycle even after its queue and draft are removed', async () => {
  const { id } = await sentAndWaiting();
  const manual = await require('../helpers/whatsappQueue').enqueueWhatsApp({ to: PHONE, text: 'Following our call', event: 'lead.message' });
  // Simulate a crash after transport acceptance but before the queue-result/noteOutgoing write.
  const identity = 'manual-before-crash';
  await OutgoingAttempt.create({ _id: identity, queueId: manual._id, to: PHONE, source: 'manual', phase: 'handoff' });
  await Queue.deleteOne({ _id: manual._id });
  await require('../helpers/stopFinalMessage').noteOutgoing(PHONE, identity, new Date());
  assert.equal((await row(id)).status, 'stopped');
});

test('manual delivery without an echo is recovered from sender evidence, and uncertain delivery postpones closure', async () => {
  for (const phase of ['sent', 'handoff', 'failed']) {
    await Promise.all([FinalMessage.deleteMany({}), Queue.deleteMany({}), Lead.deleteMany({}), OutgoingAttempt.deleteMany({})]);
    const { id } = await sentAndWaiting();
    await OutgoingAttempt.create({ _id: `manual-no-echo-${phase}`, to: PHONE, source: 'manual', phase, handedOffAt: new Date() });
    await pastDeadline(id); await followFinalMessages();
    assert.equal((await row(id)).status, phase === 'sent' ? 'stopped' : 'waiting');
    assert.equal(await stage(id), 'Negative');
    assert.equal(await Queue.countDocuments({ finalMessageExpiryId: (await row(id)).draftId }), 0);
  }
});

test('a crash between the successful queue result and attempt settlement recovers a manual send', async () => {
  const { id } = await sentAndWaiting();
  const manual = await Queue.create({ to: PHONE, text: 'We spoke', source: 'manual', event: 'lead.message', status: 'sent', messageId: 'accepted-before-crash' });
  await OutgoingAttempt.create({ _id: 'accepted-before-crash', queueId: manual._id, to: PHONE, source: 'manual', phase: 'handoff', handedOffAt: new Date() });
  await followFinalMessages();
  assert.equal((await row(id)).status, 'stopped');
});

test('Stop loses safely after handoff, while a Stop winning the claim race prevents delivery', async () => {
  for (const stopFirst of [false, true]) {
    await Promise.all([FinalMessage.deleteMany({}), Queue.deleteMany({}), Lead.deleteMany({})]);
    const { id } = await sentAndWaiting();
    await pastDeadline(id); await followFinalMessages();
    const cycle = await row(id);
    let delivered = false;
    let stopStatus;
    const stop = async () => { stopStatus = (await call(`/admin/leads/${id}/final-message/stop`, 'POST', { draftId: String(cycle.draftId), reason: 'Called by phone' })).status; };
    const transport = { ...phone(), async send(jid, text, typing, options) {
      if (stopFirst) await stop();
      const allowed = await options.beforeSend();
      if (!stopFirst) await stop();
      if (!allowed) throw Object.assign(new Error('Stopped'), { code: 'FINAL_MESSAGE_CHANGED' });
      delivered = true;
      return options.messageId;
    } };
    await sendQueue(transport);
    assert.equal(stopStatus, stopFirst ? 200 : 409);
    assert.equal(delivered, !stopFirst);
    assert.equal((await row(id)).status, stopFirst ? 'stopped' : 'dead');
  }
});

test('unknown legacy echo remains unresolved when the old queue row is deleted', async () => {
  const { id } = await sentAndWaiting();
  const legacy = await Queue.create({ to: PHONE, text: 'Unknown acknowledgement', event: 'sendProjectCreatedEmail', status: 'failed' });
  await require('../helpers/stopFinalMessage').noteOutgoing(PHONE, 'legacy-no-id', new Date());
  await Queue.deleteOne({ _id: legacy._id });
  assert.equal(await require('../helpers/stopFinalMessage').processOutbound(await row(id)), 'pending');
  assert.equal((await row(id)).status, 'waiting');
});

test('an outgoing echo committed just before timeout prevents Dead until it is classified', async () => {
  const { id } = await sentAndWaiting();
  await pastDeadline(id);
  const update = FinalMessage.updateOne;
  let inserted = false;
  FinalMessage.updateOne = async function(filter, change, options) {
    if (!inserted && change?.$set?.status === 'dead') {
      inserted = true;
      await update.call(this, { leadId: id }, { $addToSet: { outboundChecks: { id: 'arrived-before-timeout', at: new Date() } } });
    }
    return update.call(this, filter, change, options);
  };
  try { await followFinalMessages(); } finally { FinalMessage.updateOne = update; }
  assert.equal((await row(id)).status, 'waiting');
  assert.equal(await stage(id), 'Negative');
  await followFinalMessages();
  assert.equal((await row(id)).status, 'stopped');
});

test('a new explicit cycle ignores retained manual sends from its previous cycle', async () => {
  const { id } = await sentAndWaiting();
  const current = await row(id);
  await OutgoingAttempt.create({ _id: 'previous-cycle-manual', to: PHONE, source: 'manual', phase: 'sent' });
  await require('../helpers/stopFinalMessage').processOutbound(current);
  assert.equal((await row(id)).status, 'stopped');
  assert.equal((await call(`/admin/leads/${id}/final-message?new=1`)).status, 200);
  assert.equal(await require('../helpers/stopFinalMessage').processOutbound(await row(id)), 'clear');
  assert.equal((await row(id)).status, 'review');
});

test('Stop during a client first-message preparation prevents the initial send without changing Won', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
    const cycle = await row(clientLead._id);
    let delivered = false;
    const transport = { ...phone(), async send(jid, text, typing, options) {
      assert.equal((await call(`/admin/leads/${clientLead._id}/final-message/stop`, 'POST', { draftId: String(cycle.draftId), reason: 'Client called' })).status, 200);
      if (!await options.beforeSend()) throw Object.assign(new Error('Stopped'), { code: 'FINAL_MESSAGE_CHANGED' });
      delivered = true;
      return options.messageId;
    } };
    await sendQueue(transport); await followFinalMessages();
    assert.equal(delivered, false);
    assert.equal((await row(clientLead._id)).status, 'stopped');
    assert.equal(await stage(clientLead._id), 'Won');
    assert.equal((await Lead.findById(clientLead._id)).clientBehaviour, 'Negative');
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('marking Negative saves the stage and opens a review; nothing enters the queue until Send', async () => {
  const { _id } = await lead();
  const marked = await markNegative(_id);
  assert.equal(marked.success, true);
  assert.equal(marked.emailStatus, 'awaiting-review');
  assert.equal(marked.emailDraftIds.length, 1);
  assert.equal(String(marked.emailReviewDraft._id), String(marked.emailDraftIds[0]));
  assert.equal(marked.emailReviewDraft.event, 'lead.finalMessage');
  assert.equal(await stage(_id), 'Negative');
  assert.equal(await Queue.countDocuments(), 0);
  assert.equal((await row(_id)).status, 'review');
});

test('a lead with no email offers only WhatsApp and shows the number; the setting fills the message and the timer', async () => {
  await call('/auto-reply/final-message/time', 'POST', { hours: 72 });
  const { _id } = await lead();
  const marked = await markNegative(_id);
  const { draft } = await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  assert.equal(draft.defaultChannel, 'whatsapp');
  assert.equal(draft.channelOptions.find(option => option.id === 'email').enabled, false);
  assert.equal(draft.whatsappTo, PHONE);
  assert.ok(draft.editorFields.variables.some(row => row.key === 'timeLimit' && row.label === 'Time limit'), 'the chip can be inserted again');
  assert.ok(JSON.stringify(draft.templateDoc).includes('timeLimit'), 'the time is a chip, not typed text');
  const transport = phone();
  await sendQueue(transport);
  assert.match(transport.sent[0][1], /ਅਗਲੇ 72 hours ਵਿੱਚ/);
  await followFinalMessages();
  const waiting = await row(_id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.deadlineAt - waiting.sentAt, 72 * HOUR);
});

test('a lead with an email and a number offers all channels, default the action\'s Send via (WhatsApp)', async () => {
  const { _id } = await lead({ email: 'ravi@example.test' });
  const marked = await markNegative(_id);
  const draft = (await call(`/email-control/drafts/${marked.emailDraftIds[0]}`, 'GET')).data;
  assert.equal(draft.defaultChannel, 'whatsapp');
  assert.ok(draft.channelOptions.every(row => row.enabled));
  await decide(marked.emailDraftIds[0], 'send', 'both');
  await sendQueue(phone());
  await followFinalMessages();
  assert.equal((await row(_id)).status, 'waiting');
});

test('email only and Don\'t Send start no timer and the lead never goes Dead by itself', async () => {
  const emailLead = await lead({ email: 'a@example.test', phone: '9876543211' });
  const skipped = await lead({ phone: '9876543212' });
  await decide((await markNegative(emailLead._id)).emailDraftIds[0], 'send', 'email');
  await decide((await markNegative(skipped._id)).emailDraftIds[0], 'skip');
  await followFinalMessages();
  await followFinalMessages();
  assert.equal((await row(emailLead._id)).status, 'email-only');
  assert.equal((await row(skipped._id)).status, 'not-sent');
  assert.equal(await stage(emailLead._id), 'Negative');
  assert.equal(await stage(skipped._id), 'Negative');
  assert.equal(await Queue.countDocuments(), 0);
});

test('Don\'t Send can be sent later; moving away ends a sent cycle, and Negative again starts a new review', async () => {
  const skipped = await lead({ phone: '9876543212' });
  await decide((await markNegative(skipped._id)).emailDraftIds[0], 'skip');
  await followFinalMessages();
  const again = await call(`/admin/leads/${skipped._id}/final-message`);
  assert.equal(again.emailDraftIds.length, 1, 'Send later reopens the popup');

  const { id } = await sentAndWaiting();
  const form = new FormData(); form.append('action', 'followUp'); form.append('badge', 'Contacted'); form.append('note', 'Talked');
  await nativeFetch(`${base}/admin/leads/${id}`, { method: 'POST', headers: { Cookie: cookie() }, body: form });
  assert.equal((await row(id)).status, 'stopped', 'the move ends the countdown at once');
  assert.equal((await row(id)).stopSource, 'status-change');
  const remarked = await markNegative(id);
  assert.equal(remarked.finalMessage, 'prepared');
  assert.equal(remarked.emailDraftIds.length, 1);
  assert.equal((await row(id)).status, 'review');
  assert.equal((await row(id)).episodeHistory.length, 1, 'the earlier cycle is kept');
  const repeat = await call(`/admin/leads/${id}/final-message`);
  assert.deepEqual(repeat.emailDraftIds, remarked.emailDraftIds, 'while it runs, the same review reopens');
});

test('no reply by the deadline: Dead, and out of every Broadcast group', async () => {
  const { id } = await sentAndWaiting();
  await followFinalMessages();
  assert.equal(await stage(id), 'Negative', 'not before the deadline');
  await pastDeadline(id);
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
  assert.equal((await row(id)).status, 'dead');
  assert.ok(!GROUPS.some(group => group.id === 'Dead'));
  assert.equal((await audience('Negative')).count, 0);
  const notes = (await Lead.findById(id).lean()).followUps.map(item => item.note);
  assert.ok(notes.some(note => note.includes('Moved to Dead')));
});

test('listed words, emojis and reactions are not replies: the wait goes on to Dead, and the timeline shows them', async () => {
  const messages = [
    ...['ok', 'OK.', 'Ok!!', ' thik  a ', 'thik hai', 'Thik Hai Ji 🙏', 'kardo ji', 'krdo.', 'karde', 'KARDO', 'ok 👍', '👍', '🙏🙏', '👍🏻', '❤️', '...'].map(conversation => ({ conversation })),
    { extendedTextMessage: { text: 'thik hai' } }, { reactionMessage: { text: '👍', key: { id: 'x' } } },
  ];
  for (const [index, message] of messages.entries()) {
    const number = `9198765${String(index).padStart(5, '0')}`;
    const { id } = await sentAndWaiting({ phone: `+${number}` });
    const queued = await Queue.countDocuments();
    await incoming(message, new Date(Date.now() + 2000), number);
    await followFinalMessages();
    assert.equal((await row(id)).status, 'waiting', JSON.stringify(message));
    assert.equal((await row(id)).lastReplyAt, undefined, JSON.stringify(message));
    await pastDeadline(id);
    await FinalMessage.updateOne({ leadId: id }, { $set: { sentAt: new Date(Date.now() - 1000) } });
    await followFinalMessages();
    assert.equal(await stage(id), 'Dead', JSON.stringify(message));
    assert.equal(await Queue.countDocuments(), queued + 1, 'only the deadline queues the expiry reply');
    await sendQueue(phone()); // drain the expiry before starting the next person's original message
    assert.ok((await Lead.findById(id).lean()).followUps.some(item => item.note.includes('not counted as a reply')), JSON.stringify(message));
  }
});

test('WhatsApp housekeeping messages are nothing at all', async () => {
  const { id } = await sentAndWaiting();
  for (const message of [{ messageContextInfo: { deviceListMetadata: {} } }, { senderKeyDistributionMessage: { groupId: 'x' }, messageContextInfo: {} }, { keepInChatMessage: {} }, { pollUpdateMessage: {} }, { protocolMessage: { type: 0 } }]) {
    await incoming(message, new Date(Date.now() + 2000));
  }
  const saved = await row(id);
  assert.equal(saved.lastReplyAt, undefined);
  assert.equal(saved.lastIgnoredAt, undefined);
});

test('an "ok" after a real reply can\'t hide it; a listed word never brings a Dead lead back, a real reply does', async () => {
  const first = await sentAndWaiting();
  await incoming({ conversation: 'details bhejo' }, new Date(Date.now() + 2000));
  await incoming({ conversation: 'ok' }, new Date(Date.now() + 4000));
  await followFinalMessages();
  assert.equal((await row(first.id)).status, 'replied');
  assert.equal((await row(first.id)).lastReplyText, 'details bhejo');

  const second = await sentAndWaiting({ phone: '9876543299' });
  await pastDeadline(second.id);
  await followFinalMessages();
  assert.equal(await stage(second.id), 'Dead');
  await incoming({ conversation: 'ok' }, new Date(Date.now() + 2000), '919876543299');
  await followFinalMessages();
  assert.equal(await stage(second.id), 'Dead');
  await incoming({ conversation: 'ok details bhejo' }, new Date(Date.now() + 4000), '919876543299');
  await followFinalMessages();
  assert.equal(await stage(second.id), 'Negative');
  assert.equal((await row(second.id)).status, 'replied');
});

test('the list can be changed, and the change applies to the next message', async () => {
  const saved = await call('/auto-reply/final-message/ignored', 'POST', { ignoredReplies: ['okay', ' OKAY. ', '', 'theek hai'] });
  assert.deepEqual(saved.data.ignoredReplies, ['okay', 'theek hai'], 'blank lines and repeats go');
  assert.deepEqual((await call('/auto-reply/final-message', 'GET')).data.ignoredReplies, ['okay', 'theek hai']);
  assert.equal((await call('/auto-reply/final-message/ignored', 'POST', { ignoredReplies: 'ok' })).status, 400);
  const { id } = await sentAndWaiting();
  await incoming({ conversation: 'Okay' }, new Date(Date.now() + 2000));
  await followFinalMessages();
  assert.equal((await row(id)).status, 'waiting');
  await incoming({ conversation: 'ok' }, new Date(Date.now() + 4000));
  await followFinalMessages();
  assert.equal((await row(id)).status, 'replied', 'ok was taken off the list');
});

test('the three buttons change only the stage and timeline, and nothing enters the queue', async () => {
  const replied = async (number, fields = {}) => {
    const { id } = await sentAndWaiting({ phone: `+${number}`, ...fields });
    await incoming({ conversation: 'offer kya hai' }, new Date(Date.now() + 2000), number);
    await followFinalMessages();
    return id;
  };
  const interested = await replied('919000000011');
  const dead = await replied('919000000012');
  const keep = await replied('919000000013');
  const nameless = await replied('919000000014', { name: undefined, status: 'Inquiry' });
  const twin = await Lead.create({ name: 'Same person', phone: '9000000012', status: 'Negative' });
  const queued = await Queue.countDocuments();
  const list = (await call('/auto-reply/final-message', 'GET')).data.needsDecision;
  assert.equal(list.length, 4);
  const idOf = async id => String((await row(id))._id);
  const decide = async (id, choice) => call('/auto-reply/final-message/decision', 'POST', { id: await idOf(id), choice });

  assert.equal((await decide(nameless, 'interested')).status, 400, 'Contacted needs a name');
  assert.equal(await stage(nameless), 'Negative');
  assert.equal((await row(nameless)).decision, undefined);
  assert.equal((await decide(interested, 'other')).status, 400);
  assert.equal((await decide(interested, 'interested')).status, 200);
  assert.equal(await stage(interested), 'Contacted');
  assert.equal((await decide(interested, 'dead')).status, 409, 'decided once');
  assert.equal(await stage(interested), 'Contacted');
  await decide(dead, 'dead');
  assert.equal(await stage(dead), 'Dead');
  assert.equal(await stage(twin._id), 'Dead', 'the same number is one person');
  await decide(keep, 'keep');
  assert.equal(await stage(keep), 'Negative');
  await decide(nameless, 'dead');
  assert.equal(await stage(nameless), 'Dead');

  assert.equal(await Queue.countDocuments(), queued);
  assert.equal((await call('/auto-reply/final-message', 'GET')).data.needsDecision.length, 0);
  const note = (await Lead.findById(keep).lean()).followUps.at(-1);
  assert.equal(note.note, 'Reply reviewed: kept in Negative.');
  assert.equal(String(note.createdBy), String(admin._id));
});

test('a lead moved by hand leaves the list and can no longer be decided here', async () => {
  const { id } = await sentAndWaiting();
  await incoming({ conversation: 'offer kya hai' }, new Date(Date.now() + 2000));
  await followFinalMessages();
  await Lead.updateOne({ _id: id }, { status: 'Positive' });
  assert.equal((await call('/auto-reply/final-message', 'GET')).data.needsDecision.length, 0);
  assert.equal((await call('/auto-reply/final-message/decision', 'POST', { id: String((await row(id))._id), choice: 'dead' })).status, 409);
  assert.equal(await stage(id), 'Positive');
});

test('real replies stay Negative and wait for the admin: text, voice and photo, a caption too', async () => {
  const kinds = [
    [{ conversation: 'nahi chahiye' }, 'nahi chahiye'], [{ audioMessage: { seconds: 4 } }, 'Voice message'],
    [{ imageMessage: { mimetype: 'image/jpeg' } }, 'Photo'], [{ imageMessage: { caption: 'ok' } }, 'Photo'],
  ];
  for (const [index, [message, label]] of kinds.entries()) {
    const number = `91987654320${index}`;
    const { id } = await sentAndWaiting({ phone: `+${number}` });
    await incoming(message, new Date(Date.now() + 60_000), number);
    await pastDeadline(id);
    await FinalMessage.updateOne({ leadId: id }, { $set: { sentAt: new Date(Date.now() - 1000) } });
    await followFinalMessages();
    assert.equal(await stage(id), 'Negative', label);
    assert.equal((await row(id)).status, 'replied', label);
    assert.equal((await row(id)).lastReplyText, label);
  }
  const { data } = await call('/auto-reply/final-message', 'GET');
  assert.equal(data.counts.replied, 4);
  assert.equal(data.needsDecision.length, 4);
});

test('only the review decision and the dedicated expiry dispatcher can enqueue; reply handlers cannot send', async () => {
  const fs = require('node:fs'), path = require('node:path');
  for (const file of ['helpers/finalMessage.js', 'helpers/finalMessageJobs.js', 'whatsapp/src/finalMessageReplies.js', 'whatsapp/src/inbound.js', 'routes/autoReply.js', 'controller/lead/finalMessage.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const forbidden of ['enqueueWhatsApp', 'Queue.create', 'Queue.insert', 'sendMessage', 'transport.send']) assert.ok(!source.includes(forbidden), `${file} must not use ${forbidden}`);
  }
  const jobs = fs.readFileSync(path.join(__dirname, '../helpers/finalMessageJobs.js'), 'utf8');
  assert.ok(jobs.includes("require('./finalMessageExpiry').dispatch()"));
});

test('replies count with Auto Reply off, an older message is not a reply, and other chats save nothing', async () => {
  await State.updateOne({ _id: STATE_ID }, { $set: { 'autoReply.recognise': false } });
  const { id } = await sentAndWaiting();
  const sentAt = (await row(id)).sentAt;
  await incoming({ conversation: 'an old message' }, new Date(sentAt.getTime() - HOUR)); // arrives after a restart
  await followFinalMessages();
  assert.equal((await row(id)).status, 'waiting');
  await incoming({ conversation: 'someone else' }, new Date(), '919111111111');
  assert.equal(await FinalMessage.countDocuments({ phone: '919111111111' }), 0);
  assert.equal(await Inbox.countDocuments(), 0);
  await incoming({ conversation: 'yes tell me' }, new Date(Date.now() + 5000));
  await followFinalMessages();
  assert.equal((await row(id)).status, 'replied');
  await incoming({ conversation: 'a later private chat' }, new Date(Date.now() + 9000));
  assert.equal((await row(id)).lastReplyText, 'yes tell me', 'nothing more is saved once the reply came');
});

test('a reply after going Dead brings the lead back to Negative', async () => {
  const { id } = await sentAndWaiting();
  await pastDeadline(id);
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
  await incoming({ conversation: 'sorry, interested' });
  await followFinalMessages();
  assert.equal(await stage(id), 'Negative');
  assert.equal((await row(id)).status, 'replied');
});

test('the admin moving the lead cancels a waiting message and stops the timer', async () => {
  const waitingInQueue = await lead({ phone: '9876543213' });
  const marked = await markNegative(waitingInQueue._id);
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  await Lead.updateOne({ _id: waitingInQueue._id }, { status: 'Positive' });
  await followFinalMessages();
  assert.equal((await Queue.findOne({ emailDraftId: marked.emailDraftIds[0] }).lean()).status, 'cancelled');
  assert.equal((await row(waitingInQueue._id)).status, 'stopped');
  assert.equal((await row(waitingInQueue._id)).stopReason, 'Status changed to Positive');

  const { id } = await sentAndWaiting();
  await Lead.updateOne({ _id: id }, { status: 'Contacted' });
  await pastDeadline(id);
  await followFinalMessages();
  assert.equal(await stage(id), 'Contacted');
  assert.equal((await row(id)).status, 'stopped');
});

test('a failed send starts no timer; nothing goes Dead while WhatsApp is not listening', async () => {
  const failed = await lead({ phone: '9876543214' });
  const marked = await markNegative(failed._id);
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  await sendQueue({ ...phone(), resolve: async () => null });
  await followFinalMessages();
  assert.equal((await row(failed._id)).status, 'not-sent');
  assert.equal(await stage(failed._id), 'Negative');

  const { id } = await sentAndWaiting();
  await pastDeadline(id);
  await State.updateOne({ _id: STATE_ID }, { $set: { connection: 'disconnected' } });
  await followFinalMessages();
  assert.equal(await stage(id), 'Negative');
  await listening();
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
});

test('the Leads button prepares one review per eligible Negative lead, and not clients or those already sent', async () => {
  await User.create({ name: 'Client', email: 'client@example.test', phone: '9000000002', roles: ['customer'] });
  const eligible = await lead({ status: 'Negative', phone: '9000000001' });
  const nameless = await lead({ status: 'Negative', phone: '9000000005', name: undefined });
  await lead({ status: 'Negative', phone: '9000000002' }); // a client's number
  await lead({ status: 'Negative', phone: '9000000003', requestedByUserId: admin._id });
  await lead({ status: 'Negative', phone: 'bad' });
  await lead({ status: 'Positive', phone: '9000000004' });
  assert.equal((await call('/admin/final-message/count', 'GET')).data.count, 2);
  const prepared = await call('/admin/final-message/prepare');
  assert.equal(prepared.data.prepared, 2);
  assert.equal(prepared.emailDraftIds.length, 2);
  assert.equal(await Queue.countDocuments(), 0);
  assert.equal((await row(eligible._id)).status, 'review');
  assert.equal((await row(nameless._id)).status, 'review');
  // Pressed again before deciding: the same drafts open again, no second message.
  const again = await call('/admin/final-message/prepare');
  assert.deepEqual([...again.emailDraftIds].sort(), [...prepared.emailDraftIds].sort());
  assert.equal(await EmailDraft.countDocuments(), 2);
  for (const id of prepared.emailDraftIds) await decide(id, 'send', 'whatsapp');
  await followFinalMessages(); // the next minute's job
  assert.equal((await call('/admin/final-message/count', 'GET')).data.count, 0);
});

test('a nameless lead goes Dead without an error; a Matured lead without a valid client account can\'t be marked Negative; the action Off prepares nothing', async () => {
  const { id } = await sentAndWaiting({ name: undefined, status: 'Inquiry' });
  await pastDeadline(id);
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
  const doc = await Lead.findById(id);
  await assert.doesNotReject(doc.save());

  const won = await lead({ status: 'Won', phone: '9000000006', convertedToUserId: admin._id });
  assert.equal((await markNegative(won._id)).status, 409, 'not a customer account: refused before saving');
  assert.equal((await Lead.findById(won._id).lean()).clientBehaviour, undefined);

  await EmailPolicy.create({ event: 'lead.finalMessage', mode: 'off' });
  const off = await lead({ phone: '9000000007' });
  const marked = await markNegative(off._id);
  assert.equal(marked.success, true);
  assert.equal(marked.finalMessage, 'unavailable');
  assert.equal(await stage(off._id), 'Negative');
});

test('the time setting refuses bad values and a saved value leaves sent messages alone', async () => {
  assert.equal((await call('/auto-reply/final-message/time', 'POST', { hours: 0 })).status, 400);
  assert.equal((await call('/auto-reply/final-message/time', 'POST', { hours: 'abc' })).status, 400);
  const { id } = await sentAndWaiting();
  const before = (await row(id)).deadlineAt;
  await call('/auto-reply/final-message/time', 'POST', { hours: 5 });
  await followFinalMessages();
  assert.deepEqual((await row(id)).deadlineAt, before);
  assert.equal((await call('/auto-reply/final-message', 'GET')).data.hours, 5);
});

test('the lead page reads the message state', async () => {
  const { id } = await sentAndWaiting();
  const { data } = await call(`/admin/leads/${id}`, 'GET');
  assert.equal(data.finalMessage.status, 'waiting');
  assert.ok(data.finalMessage.deadlineAt);
});

// One cycle rule for leads and clients (helpers/finalMessageCycle.js): a change ends a running cycle at once,
// a finished cycle starts again on Negative, and the page is told what it may offer.
const followUpTo = async (id, badge, note = 'Follow-up') => {
  const form = new FormData(); form.append('action', 'followUp'); form.append('badge', badge); form.append('note', note);
  const response = await nativeFetch(`${base}/admin/leads/${id}`, { method: 'POST', headers: { Cookie: cookie() }, body: form });
  return { status: response.status, ...await response.json() };
};
const detail = async id => (await call(`/admin/leads/${id}`, 'GET')).data;
async function clientSentAndWaiting() {
  const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
  const item = await lead({ status: 'Won', convertedToUserId: user._id });
  const marked = await followUpTo(item._id, 'Negative', 'Stopped paying');
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  const transport = phone();
  await sendQueue(transport); await followFinalMessages();
  return { id: item._id, transport, marked };
}
const withClients = async work => { process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true'; try { await work(); } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; } };

test('a client is marked Negative on a follow-up, as a lead is: one line with the note and badge, Won kept, review opens', () => withClients(async () => {
  const { id, marked } = await clientSentAndWaiting();
  assert.equal(marked.finalMessage, 'prepared');
  const saved = await Lead.findById(id).lean();
  assert.equal(saved.status, 'Won');
  assert.equal(saved.clientBehaviour, 'Negative');
  const lines = saved.followUps.filter(item => item.note === 'Stopped paying');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].badge, 'Negative');
  assert.ok(!saved.followUps.some(item => item.note.startsWith('Client current status')), 'the note is the only line');
  const page = await detail(id);
  assert.equal(page.finalMessage.status, 'waiting');
  assert.equal(page.finalMessage.stopLabel, 'Stop countdown');
  assert.equal(page.finalMessage.listening, true);
  assert.equal(page.finalMessageCanStart, false);
  const note = await followUpTo(id, 'Negative', 'Still no answer');
  assert.equal(note.emailDraftIds, undefined, 'a note in the same status sends nothing');
  assert.equal((await Lead.findById(id).lean()).followUps.find(item => item.note === 'Still no answer').badge, 'Negative');
}));

test('a client follow-up to Negative is refused before saving when the final message cannot start', async () => {
  const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
  const item = await lead({ status: 'Won', convertedToUserId: user._id });
  const refused = await followUpTo(item._id, 'Negative');
  assert.equal(refused.status, 409);
  assert.equal(refused.finalMessageReadiness.code, 'automation-disabled');
  const saved = await Lead.findById(item._id).lean();
  assert.equal(saved.clientBehaviour, undefined);
  assert.equal(saved.followUps.length, 0);
  assert.equal((await followUpTo(item._id, 'Wrong')).status, 400, 'Wrong is not a client status');
  assert.equal((await followUpTo(item._id, 'Positive')).status, 200, 'other statuses need no final message');
});

test('moving a client or a lead out of Negative ends the countdown at once: no Dead, no closure, no Stop', () => withClients(async () => {
  for (const start of [clientSentAndWaiting, sentAndWaiting]) {
    await Promise.all([Lead, User, EmailDraft, Queue, FinalMessage].map(model => model.deleteMany({})));
    await User.create({ _id: admin._id, name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
    const { id, transport } = await start();
    await followUpTo(id, 'Positive', 'Called, wants to continue');
    const cycle = await row(id);
    assert.equal(cycle.status, 'stopped');
    assert.equal(cycle.stopSource, 'status-change');
    assert.equal(cycle.stopReason, 'Status changed to Positive');
    const page = await detail(id);
    assert.equal(page.finalMessage.stopLabel, null);
    assert.equal(page.finalMessageCanStart, false, 'not Negative: nothing to start');
    await pastDeadline(id); await followFinalMessages(); await followFinalMessages(); await sendQueue(transport);
    const saved = await Lead.findById(id).lean();
    assert.equal(saved.convertedToUserId ? saved.clientBehaviour : saved.status, 'Positive');
    assert.equal(await Queue.countDocuments({ finalMessageExpiryId: { $exists: true } }), 0);
    assert.equal(transport.sent.length, 1);
  }
}));

test('Negative again after a finished cycle starts a new review for a client and for a lead; the old cycle is kept', () => withClients(async () => {
  const client = await clientSentAndWaiting();
  await followUpTo(client.id, 'Positive');
  const again = await followUpTo(client.id, 'Negative');
  assert.equal(again.finalMessage, 'prepared');
  assert.equal((await row(client.id)).status, 'review');
  assert.equal((await row(client.id)).episodeHistory.length, 1);
  await pastDeadline(client.id); await followFinalMessages();
  assert.equal((await Lead.findById(client.id).lean()).clientBehaviour, 'Negative', 'the old timer cannot end the new cycle');

  const dead = await lead({ phone: '9876543221' });
  const marked = await markNegative(dead._id);
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  await sendQueue(phone()); await followFinalMessages();
  await pastDeadline(dead._id); await followFinalMessages();
  assert.equal(await stage(dead._id), 'Dead');
  await followUpTo(dead._id, 'Contacted', 'Came back');
  const remarked = await followUpTo(dead._id, 'Negative', 'No answer again');
  assert.equal(remarked.finalMessage, 'prepared');
}));

test('a reply decided as Interested ends the cycle; Negative later starts a new one', async () => {
  const { id } = await sentAndWaiting();
  await incoming({ conversation: 'Please call me' }, new Date(Date.now() + 5000)); await followFinalMessages();
  await call('/auto-reply/final-message/decision', 'POST', { id: String((await row(id))._id), choice: 'interested' });
  assert.equal(await stage(id), 'Contacted');
  assert.equal((await markNegative(id)).finalMessage, 'prepared');
});

test('an undecided reply leaves Needs decision when the admin moves the person instead', async () => {
  const { id } = await sentAndWaiting();
  await incoming({ conversation: 'Who is this?' }, new Date(Date.now() + 5000)); await followFinalMessages();
  assert.equal((await row(id)).status, 'replied');
  await followUpTo(id, 'Positive');
  assert.equal((await row(id)).status, 'stopped');
  assert.equal((await row(id)).lastReplyText, 'Who is this?', 'the reply stays on record');
  assert.equal((await call('/auto-reply/final-message', 'GET')).data.needsDecision.length, 0);
  assert.equal((await markNegative(id)).finalMessage, 'prepared');
});

test('conversion, Trash and a new phone number end a running cycle with their reason', () => withClients(async () => {
  const converted = await sentAndWaiting({ email: 'ravi@example.com' });
  await User.updateOne({ _id: admin._id }, { $set: { role: 'ADMIN' } });
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await require('../controller/lead/convertLead')({ params: { leadId: String(converted.id) }, body: {}, userId: String(admin._id), userRole: 'admin' }, response);
  assert.equal(response.body.success, true);
  assert.equal((await row(converted.id)).stopReason, 'Converted to client');
  const startable = await detail(converted.id);
  assert.equal(startable.clientBehaviour, 'Negative');
  assert.equal(startable.finalMessageCanStart, true, 'the new client can start their own cycle');

  await Promise.all([Lead, FinalMessage, Queue, EmailDraft].map(model => model.deleteMany({})));
  await User.deleteMany({ _id: { $ne: admin._id } });
  const trashed = await sentAndWaiting();
  await require('../controller/lead/deleteLead')({ params: { leadId: String(trashed.id) }, body: {}, query: {}, userId: String(admin._id), userRole: 'admin' }, response);
  assert.equal((await row(trashed.id)).stopReason, 'Moved to Trash');

  await Promise.all([Lead, FinalMessage, Queue, EmailDraft].map(model => model.deleteMany({})));
  const moved = await sentAndWaiting();
  await call(`/admin/leads/${moved.id}`, 'POST', { action: 'editDetails', name: 'Ravi', phone: '9123456780' });
  assert.equal((await row(moved.id)).stopReason, 'Phone number changed');
}));

test('Stop shows only while something can be stopped; after the closure has gone it disappears', async () => {
  const { id, transport } = await sentAndWaiting();
  assert.equal((await detail(id)).finalMessage.stopLabel, 'Stop countdown');
  await pastDeadline(id); await followFinalMessages();
  const dead = await detail(id);
  assert.equal(dead.finalMessage.status, 'dead');
  assert.equal(dead.finalMessage.stopLabel, 'Cancel closure message', 'the closure is queued but not sent');
  await sendQueue(transport);
  assert.equal((await detail(id)).finalMessage.stopLabel, null);
  const review = await lead({ phone: '9876543231' });
  await markNegative(review._id);
  const page = await detail(review._id);
  assert.equal(page.finalMessage.status, 'review');
  assert.equal(page.finalMessage.stopLabel, null, 'a review has no countdown to stop');
  assert.equal(page.finalMessageCanStart, false);
});

test('a countdown past its time while WhatsApp is offline says so and goes Dead only after reconnecting', async () => {
  const { id } = await sentAndWaiting();
  await State.updateOne({ _id: STATE_ID }, { $set: { connection: 'disconnected' } });
  await pastDeadline(id); await followFinalMessages();
  const page = await detail(id);
  assert.equal(page.finalMessage.status, 'waiting');
  assert.equal(page.finalMessage.listening, false);
  await listening(); await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
});

test('the minute job ends a cycle whose person moved without the change-time check', () => withClients(async () => {
  const { id } = await clientSentAndWaiting();
  await Lead.updateOne({ _id: id }, { $set: { clientBehaviour: 'Active' }, $inc: { clientBehaviourRevision: 1 } });
  await followFinalMessages();
  assert.equal((await row(id)).status, 'stopped');
  assert.equal((await row(id)).stopReason, 'Status changed to Active');
}));
const ALT = '919811111111';
async function dualWaiting() {
  process.env.ALT_PHONE_SENDING_ENABLED = 'true';
  return sentAndWaiting({ altPhone: ALT });
}
test('dual final copies share one countdown and closure quotes each original chat', async () => {
  try {
    const { id, transport } = await dualWaiting();
    let saved = await row(id); const deadline = +saved.deadlineAt;
    assert.equal(saved.phone, PHONE); assert.equal(saved.altPhone, ALT); assert.equal(saved.sends.length, 1);
    assert.equal(await Queue.countDocuments({emailDraftId:saved.draftId}),2);
    await sendQueue(transport); await followFinalMessages(); saved=await row(id);
    assert.equal(saved.sends.length,2); assert.equal(+saved.deadlineAt,deadline); assert.equal(saved.phone,PHONE);
    await pastDeadline(id);await followFinalMessages();
    const closures=await Queue.find({finalMessageExpiryId:saved.draftId}).lean();assert.equal(closures.length,2);
    for(const closure of closures){const original=saved.sends.find(s=>s.phone===closure.to);assert.equal(closure.quotedMessage.id,original.id);assert.equal(closure.quotedMessage.chat,original.chat);}
  } finally {delete process.env.ALT_PHONE_SENDING_ENABLED;}
});
for(const altSent of [false,true]) test(`reply from alt counts ${altSent?'after':'before'} its final copy sends`,async()=>{
  try{const {id,transport}=await dualWaiting();if(altSent){await sendQueue(transport);await followFinalMessages();}
    await incoming({conversation:'Please call me'},new Date(Date.now()+5000),ALT);await followFinalMessages();
    assert.equal((await row(id)).status,'replied');await pastDeadline(id);await followFinalMessages();assert.equal(await stage(id),'Negative');
  }finally{delete process.env.ALT_PHONE_SENDING_ENABLED;}
});
test('manual message on alt stops the cycle; automatic broadcast on alt does not',async()=>{
  try{const {id}=await dualWaiting();const {noteOutgoing}=require('../helpers/stopFinalMessage');
    const automatic=await Queue.create({to:ALT,status:'sent',source:'automated',event:'broadcast.manual',text:'News',messageId:'auto-alt',sentAt:new Date()});
    await noteOutgoing(ALT,automatic.messageId,new Date());assert.equal((await row(id)).status,'waiting');
    await noteOutgoing(ALT,'manual-alt',new Date());assert.equal((await row(id)).status,'stopped');
  }finally{delete process.env.ALT_PHONE_SENDING_ENABLED;}
});
test('Stop is refused while the alternate copy is in handoff',async()=>{
  try{const {id}=await dualWaiting();const saved=await row(id);await Queue.updateOne({emailDraftId:saved.draftId,to:ALT},{$set:{status:'sending',sendPhase:'handoff'}});
    await assert.rejects(require('../helpers/stopFinalMessage').stopCycle(saved,{reason:'Stop'}),/already being sent/);assert.equal((await row(id)).status,'waiting');
  }finally{delete process.env.ALT_PHONE_SENDING_ENABLED;}
});
for(const failAlt of [false,true]) test(`one delivered copy starts the timer when ${failAlt?'alt':'main'} fails`,async()=>{
  process.env.ALT_PHONE_SENDING_ENABLED='true';
  try{const item=await lead({status:'Negative',altPhone:ALT});const prepared=await call(`/admin/leads/${item._id}/final-message`);await decide(prepared.emailDraftIds[0],'send','whatsapp');
    const saved=await row(item._id);await Queue.updateOne({emailDraftId:saved.draftId,to:failAlt?ALT:PHONE},{$set:{status:'failed'}});await sendQueue(phone());await followFinalMessages();
    const waiting=await row(item._id);assert.equal(waiting.status,'waiting');assert.equal(waiting.phone,PHONE);assert.equal(waiting.sends[0].phone,failAlt?PHONE:ALT);
  }finally{delete process.env.ALT_PHONE_SENDING_ENABLED;}
});
test('changing alt replaces an unsent copy without resetting countdown; old sent alt remains a reply contact',async()=>{
  try{const {id,transport}=await dualWaiting();const original=await row(id);const newAlt='919822222222';
    await Lead.updateOne({_id:id},{$set:{altPhone:newAlt}});await require('../helpers/finalMessageCycle').reconcileCycle(id);
    const copies=await Queue.find({emailDraftId:original.draftId,status:'pending'}).lean();assert.deepEqual(copies.map(c=>c.to),[newAlt]);
    await sendQueue(transport);await followFinalMessages();const changed=await row(id);assert.equal(+changed.deadlineAt,+original.deadlineAt);assert.ok(changed.sends.some(s=>s.phone===newAlt));
    await Lead.updateOne({_id:id},{$set:{altPhone:'919833333333'}});await require('../helpers/finalMessageCycle').reconcileCycle(id);
    await incoming({conversation:'Call please'},new Date(Date.now()+5000),newAlt);await followFinalMessages();assert.equal((await row(id)).status,'replied');
  }finally{delete process.env.ALT_PHONE_SENDING_ENABLED;}
});

test('alt change during typing cancels the old claim before enqueuing its replacement',async()=>{
  try{const {id}=await dualWaiting();const saved=await row(id);const old=await Queue.findOneAndUpdate({emailDraftId:saved.draftId,to:ALT},{$set:{status:'sending',sendPhase:'preparing',attemptMessageId:'typing-alt'}},{new:true}).lean();
    await Lead.updateOne({_id:id},{$set:{altPhone:'919822222222'}});await require('../helpers/finalMessageCycle').reconcileCycle(id);
    assert.equal((await Queue.findById(old._id)).status,'cancelled');assert.equal(await require('../helpers/stopFinalMessage').claimHandoff(old),false);
    assert.ok(await Queue.exists({emailDraftId:saved.draftId,to:'919822222222',status:'pending'}));
  }finally{delete process.env.ALT_PHONE_SENDING_ENABLED;}
});

test('client dual copies keep Won and one timer; alt reply waits for the admin decision',async()=>{
  process.env.ALT_PHONE_SENDING_ENABLED='true';process.env.CLIENT_FINAL_MESSAGE_ENABLED='true';
  try{const user=await User.create({name:'Client',email:'client@example.test',phone:'9876543210',roles:['customer']});const item=await lead({status:'Won',convertedToUserId:user._id,altPhone:ALT});
    const marked=await call(`/admin/leads/${item._id}`,'POST',{action:'setBehaviour',behaviour:'Negative'});await decide(marked.emailDraftIds[0],'send','whatsapp');const transport=phone();
    await sendQueue(transport);await followFinalMessages();const first=await row(item._id);await sendQueue(transport);await followFinalMessages();const second=await row(item._id);
    assert.equal(second.sends.length,2);assert.equal(+first.deadlineAt,+second.deadlineAt);assert.equal(await stage(item._id),'Won');
    await incoming({conversation:'Please call'},new Date(Date.now()+5000),ALT);await followFinalMessages();assert.equal((await row(item._id)).status,'replied');assert.equal((await Lead.findById(item._id)).clientBehaviour,'Negative');
  }finally{delete process.env.ALT_PHONE_SENDING_ENABLED;delete process.env.CLIENT_FINAL_MESSAGE_ENABLED;}
});

// Dead for good after the closure message: any message from then on brings the person back as an Inquiry (helpers/finalMessageComeback.js).
const later = seconds => new Date(Date.now() + seconds * 1000);
async function closedAndSent(fields) {
  const { id } = await sentAndWaiting(fields);
  await pastDeadline(id);
  await followFinalMessages(); // Dead, closure queued
  await sendQueue(phone()); // closure sent
  await followFinalMessages(); // closure's time kept on the cycle
  return id;
}

test('after the closure message any message, even an emoji, brings a Dead lead back as an Inquiry', async () => {
  for (const message of [{ conversation: 'Please call me' }, { conversation: 'ok' }, { conversation: '👍🙏' }, { reactionMessage: { text: '👍', key: { id: 'x' } } }, { imageMessage: {} }]) {
    await Promise.all([Queue.deleteMany({}), FinalMessage.deleteMany({}), Lead.deleteMany({})]);
    const id = await closedAndSent();
    assert.equal(await stage(id), 'Dead');
    assert.ok((await row(id)).expirySentAt, 'closure time kept');
    await incoming(message, later(5));
    await followFinalMessages();
    assert.equal(await stage(id), 'Inquiry', JSON.stringify(message));
    const cycle = await row(id);
    assert.equal(cycle.status, 'stopped');
    assert.equal(cycle.stopSource, 'came-back');
    assert.ok(cycle.cameBackAt);
    const saved = await Lead.findById(id).lean();
    assert.match(saved.followUps.at(-1).note, /after the closure message[\s\S]*Came back from Dead to Inquiry/);
    assert.equal(saved.followUps.at(-1).badge, 'Inquiry');
    assert.equal((await audience('Inquiry')).count, 1, 'no longer blocked as Dead');
  }
  const box = await call('/auto-reply/final-message', 'GET');
  assert.equal(box.data.counts['came-back'], 1);
});

test('before the closure message goes, the old rules stay: a real reply is Negative, a listed word keeps it Dead', async () => {
  const id = await sentAndWaiting().then(result => result.id);
  await pastDeadline(id);
  await followFinalMessages();
  assert.equal(await Queue.countDocuments({ event: 'lead.finalMessageExpired', status: 'pending' }), 1, 'closure waiting, not sent');
  await incoming({ conversation: 'ok' }, later(2));
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
  await incoming({ conversation: 'Please tell me more' }, later(4));
  await followFinalMessages();
  assert.equal(await stage(id), 'Negative');
  assert.equal((await row(id)).status, 'replied');
});

test('a message from before the closure, arriving late, does not bring the lead back', async () => {
  const id = await closedAndSent();
  await incoming({ conversation: 'old message' }, new Date(Date.now() - 50 * HOUR));
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
  assert.equal((await row(id)).status, 'dead');
});

test('a month later, after the queue forgot the closure, our own message stops nothing and their message still counts', async () => {
  const id = await closedAndSent();
  await Queue.deleteMany({ event: 'lead.finalMessageExpired' }); // queue retention
  const own = { key: { id: 'own-later', remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true }, message: { conversation: 'Hello again from our phone' }, messageTimestamp: Math.floor(later(2).getTime() / 1000) };
  await inbound.handle({ type: 'notify', messages: [own] });
  await followFinalMessages();
  assert.equal((await row(id)).status, 'dead', 'our own message after the closure must not stop the cycle');
  assert.equal((await call(`/admin/leads/${id}/final-message/stop`, 'POST', { reason: 'check', draftId: String((await row(id)).draftId) })).status, 409, 'nothing to stop after the closure');
  await incoming({ conversation: 'hi' }, later(30 * 24 * 3600));
  await followFinalMessages();
  assert.equal(await stage(id), 'Inquiry');
});

test('a Dead client who writes after the closure gets current status Inquiry and stays Matured', async () => {
  process.env.CLIENT_FINAL_MESSAGE_ENABLED = 'true';
  try {
    const user = await User.create({ name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] });
    const clientLead = await lead({ status: 'Won', convertedToUserId: user._id });
    const marked = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Negative' });
    await decide(marked.emailDraftIds[0], 'send', 'whatsapp'); await sendQueue(phone()); await followFinalMessages();
    await pastDeadline(clientLead._id); await followFinalMessages();
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Dead');
    await sendQueue(phone()); await followFinalMessages();
    assert.ok((await row(clientLead._id)).expirySentAt);
    await incoming({ reactionMessage: { text: '❤️', key: { id: 'y' } } }, later(5));
    await followFinalMessages();
    const saved = await Lead.findById(clientLead._id).lean();
    assert.equal(saved.status, 'Won');
    assert.equal(saved.clientBehaviour, 'Inquiry');
    assert.equal((await row(clientLead._id)).stopSource, 'came-back');
    // A note keeps Inquiry; the admin can't choose it.
    const form = new FormData(); form.append('action', 'followUp'); form.append('badge', 'Inquiry'); form.append('note', 'Called back');
    const noted = await nativeFetch(`${base}/admin/leads/${clientLead._id}`, { method: 'POST', headers: { Cookie: cookie() }, body: form });
    assert.equal(noted.status, 200);
    assert.equal((await Lead.findById(clientLead._id).lean()).clientBehaviour, 'Inquiry');
    const chosen = await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Inquiry' });
    assert.notEqual(chosen.status, 200);
    assert.equal((await call(`/admin/leads/${clientLead._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Positive' })).status, 200, 'the admin moves it on as usual');
  } finally { delete process.env.CLIENT_FINAL_MESSAGE_ENABLED; }
});

test('a lead the admin moved after the closure stays where the admin put it', async () => {
  const id = await closedAndSent();
  await Lead.updateOne({ _id: id }, { $set: { status: 'Positive' } });
  await incoming({ conversation: 'hello' }, later(5));
  await followFinalMessages();
  assert.equal(await stage(id), 'Positive');
  assert.equal((await row(id)).stopSource, 'status-change');
});

test('Negative again after coming back starts a fresh cycle; the came-back count keeps the earlier one', async () => {
  const id = await closedAndSent();
  await incoming({ conversation: 'hi' }, later(5));
  await followFinalMessages();
  assert.equal(await stage(id), 'Inquiry');
  await Lead.updateOne({ _id: id }, { $set: { status: 'Contacted' } });
  await markNegative(id);
  const fresh = await row(id);
  assert.equal(fresh.status, 'review');
  assert.equal(fresh.expirySentAt, undefined);
  assert.equal(fresh.cameBackAt, undefined);
  assert.equal((await call('/auto-reply/final-message', 'GET')).data.counts['came-back'], 1);
});

test('an ad reply after the closure brings even a named lead back as an Inquiry, whichever job runs first', async () => {
  const { DEFAULT_AD_MESSAGE } = require('../whatsapp/src/autoReplyRules.js');
  const { processInbox } = require('../helpers/autoReplyJobs');
  for (const first of ['auto-reply', 'final-message']) {
    await Promise.all([Queue.deleteMany({}), FinalMessage.deleteMany({}), Lead.deleteMany({}), Inbox.deleteMany({})]);
    const id = await closedAndSent();
    const at = later(5);
    await incoming({ conversation: DEFAULT_AD_MESSAGE }, at);
    await State.updateOne({ _id: STATE_ID }, { $set: { autoReply: { recognise: true, sendReplies: false, addLeads: true } } });
    await Inbox.create({ messageId: `ad-${first}`, phone: PHONE, text: DEFAULT_AD_MESSAGE, status: 'new', profileName: 'Ravi', sentAt: at });
    if (first === 'auto-reply') { await processInbox(); await followFinalMessages(); } else { await followFinalMessages(); await processInbox(); }
    assert.equal(await stage(id), 'Inquiry', first);
    assert.equal((await row(id)).stopSource, 'came-back', first);
    const saved = await Lead.findById(id).lean();
    assert.ok(saved.followUps.some(entry => /New WhatsApp ad message/.test(entry.note)), 'the ad remark is still recorded');
  }
});
