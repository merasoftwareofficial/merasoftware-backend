const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Inbox, Queue, Rule, State, STATE_ID } = require('../whatsapp/src/models.js');
const { DEFAULT_AD_MESSAGE, RULE_KEY } = require('../whatsapp/src/autoReplyRules.js');
const { RECOMMENDED } = require('../whatsapp/src/settings.js');
const { processInbox } = require('../helpers/autoReplyJobs');
const Lead = require('../models/leadModel');
const userModel = require('../models/userModel');
const nativeFetch = global.fetch;
let db, server, base, admin, customer, controlBase;
const cookie = user => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function api(url, user = admin, method = 'GET', body) {
  const headers = { ...(user ? { Cookie: cookie(user) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await nativeFetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const row = (fields = {}) => ({ messageId: `m-${Math.random()}`, phone: '919876543210', text: DEFAULT_AD_MESSAGE, status: 'new', ...fields });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-auto-reply-test-secret';
  db = await MongoMemoryServer.create();
  process.env.MONGODB_URI = db.getUri(); // the worker config requires it; nothing here connects with it
  await mongoose.connect(db.getUri(), { dbName: 'auto-reply-isolated-test' });
  await Promise.all([Inbox.init(), Rule.init()]);
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
  ]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/auto-reply', require('../routes/autoReply'));
  app.use('/api/whatsapp-control', require('../routes/whatsappControl'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/auto-reply`;
  controlBase = `http://127.0.0.1:${server.address().port}/api/whatsapp-control`;
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true';
  await Promise.all([Inbox.deleteMany({}), Rule.deleteMany({}), State.deleteMany({}), Queue.deleteMany({}), Lead.deleteMany({})]);
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });

test('only a signed-in admin can open anything', async () => {
  for (const [path, method] of [['/status', 'GET'], ['/switches', 'POST'], ['/message', 'POST']]) {
    assert.equal((await api(base + path, null, method)).status, 401, path);
    assert.equal((await api(base + path, customer, method)).status, 403, path);
  }
  assert.equal(await Rule.countDocuments(), 0);
});

test('starts with every switch Off and the owner\'s ad message', async () => {
  const { data } = await api(`${base}/status`);
  assert.deepEqual(data.switches, { recognise: false, sendReplies: false, addLeads: false });
  assert.equal(data.message, DEFAULT_AD_MESSAGE);
  assert.equal(data.listening, false);
  assert.deepEqual(data.detected, { rows: [], total: 0, needsAttention: 0 });
  await api(`${base}/status`);
  assert.equal(await Rule.countDocuments(), 1, 'opening the box twice keeps one rule');
});

test('the recognise switch turns On and Off; the other two do not exist yet', async () => {
  assert.equal((await api(`${base}/switches`, admin, 'POST', { recognise: true })).status, 200);
  assert.equal((await api(`${base}/status`)).data.switches.recognise, true);
  assert.equal((await api(`${base}/switches`, admin, 'POST', { sendReplies: true })).status, 400);
  assert.equal((await api(`${base}/switches`, admin, 'POST', { recognise: 'yes' })).status, 400);
  const { switches } = (await api(`${base}/status`)).data;
  assert.deepEqual(switches, { recognise: true, sendReplies: false, addLeads: false });
  await api(`${base}/switches`, admin, 'POST', { recognise: false });
  assert.equal((await api(`${base}/status`)).data.switches.recognise, false);
});

test('saving or resetting Sending rules leaves the switches as they were', async () => {
  await api(`${base}/switches`, admin, 'POST', { recognise: true });
  assert.equal((await api(`${controlBase}/settings`, admin, 'POST', RECOMMENDED)).status, 200);
  assert.equal((await api(`${base}/status`)).data.switches.recognise, true);
  assert.equal((await api(`${controlBase}/settings/reset`, admin, 'POST')).status, 200);
  assert.equal((await api(`${base}/status`)).data.switches.recognise, true);
});

test('a short message is refused; the full message is saved', async () => {
  for (const message of ['', 'Hello', '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!', 'Can I get more info', 'x'.repeat(1001)]) {
    assert.equal((await api(`${base}/message`, admin, 'POST', { message })).status, 400, message);
  }
  const saved = 'I saw your website design advert today';
  assert.equal((await api(`${base}/message`, admin, 'POST', { message: `  ${saved}  ` })).status, 200);
  assert.equal((await api(`${base}/status`)).data.message, saved);
  assert.equal(await Rule.countDocuments({ key: RULE_KEY }), 1);
});

test('shows recognised messages, newest first, and says whether it can listen', async () => {
  await Inbox.create([row({ messageId: 'first' }), row({ messageId: 'second', phone: null, status: 'needs-attention' })]);
  await State.updateOne({ _id: STATE_ID }, { $set: { connection: 'connected', heartbeatAt: new Date() } }, { upsert: true });
  const { data } = await api(`${base}/status`);
  assert.equal(data.listening, true);
  assert.equal(data.detected.total, 2);
  assert.equal(data.detected.needsAttention, 1);
  process.env.ENABLE_WHATSAPP = 'false';
  assert.equal((await api(`${base}/status`)).data.listening, false);
});

test('the job closes recognised rows and does nothing else: no reply, no lead', async () => {
  await Inbox.create([row({ messageId: 'a' }), row({ messageId: 'b' }), row({ messageId: 'c', phone: null, status: 'needs-attention' })]);
  assert.deepEqual(await processInbox(), { reason: 'done', closed: 2 });
  assert.equal(await Inbox.countDocuments({ status: 'closed', outcome: 'detected-only' }), 2);
  assert.equal(await Inbox.countDocuments({ status: 'needs-attention' }), 1, 'stays visible for the admin');
  assert.equal(await Queue.countDocuments(), 0);
  assert.equal(await Lead.countDocuments(), 0);
});

test('with WhatsApp off on the server the job does nothing', async () => {
  process.env.ENABLE_WHATSAPP = 'false';
  await Inbox.create(row({ messageId: 'a' }));
  assert.equal((await processInbox()).reason, 'disabled');
  assert.equal(await Inbox.countDocuments({ status: 'new' }), 1);
});
