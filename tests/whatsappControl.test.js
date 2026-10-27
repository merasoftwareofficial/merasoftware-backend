const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Queue, State, STATE_ID } = require('../whatsapp/src/models.js');
const { RECOMMENDED } = require('../whatsapp/src/settings.js');
const userModel = require('../models/userModel');
const nativeFetch = global.fetch;
let db, server, base, admin, customer;
const cookie = user => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function api(path, user = admin, method = 'GET', body) {
  const headers = { ...(user ? { Cookie: cookie(user) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await nativeFetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const hoursAgo = hours => new Date(Date.now() - hours * 60 * 60_000);

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-whatsapp-test-secret';
  db = await MongoMemoryServer.create();
  process.env.MONGODB_URI = db.getUri(); // the worker config requires it; nothing here connects with it
  await mongoose.connect(db.getUri(), { dbName: 'whatsapp-control-isolated-test' });
  await Queue.init();
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
  ]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/whatsapp-control', require('../routes/whatsappControl'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/whatsapp-control`;
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true';
  await Promise.all([Queue.deleteMany({}), State.deleteMany({})]);
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });

test('only a signed-in admin can open anything', async () => {
  for (const [path, method] of [['/status', 'GET'], ['/queue', 'GET'], ['/queue/upcoming', 'GET'], ['/pause', 'POST'], ['/unlink', 'POST'], ['/settings', 'GET'], ['/settings', 'POST'], ['/settings/reset', 'POST']]) {
    assert.equal((await api(path, null, method)).status, 401, path);
    assert.equal((await api(path, customer, method)).status, 403, path);
  }
  assert.equal(await State.countDocuments(), 0);
});

test('status shows the link, the QR only while waiting for a scan, today\'s count and the queue totals', async () => {
  await State.create({ _id: STATE_ID, connection: 'qr', qr: 'data:image/png;base64,AAA', heartbeatAt: new Date(), day: '2000-01-01', sentToday: 99 });
  await Queue.create([{ to: '919876543210', text: 'a' }, { status: 'skipped', text: 'b', lastError: 'No phone' }]);
  let { status, data } = await api('/status');
  assert.equal(status, 200);
  assert.equal(data.enabled, true);
  assert.equal(data.workerRunning, true);
  assert.equal(data.qr, 'data:image/png;base64,AAA');
  assert.equal(data.sentToday, 0, 'yesterday\'s count is not today\'s');
  assert.equal('dailyLimit' in data, false, 'there is no daily limit');
  assert.equal(data.counts.pending, 1);
  assert.equal(data.counts.skipped, 1);
  assert.equal(data.counts.sent, 0);

  await State.updateOne({ _id: STATE_ID }, { connection: 'connected', heartbeatAt: new Date(Date.now() - 120_000), phone: '919876543210' });
  delete process.env.ENABLE_WHATSAPP;
  ({ data } = await api('/status'));
  assert.equal(data.qr, null);
  assert.equal(data.workerRunning, false);
  assert.equal(data.enabled, false);
  assert.equal(data.phone, '919876543210');
});

test('pause, resume and unlink only set the request; the worker does the rest', async () => {
  await api('/pause', admin, 'POST');
  assert.equal((await State.findById(STATE_ID).lean()).paused, true);
  await api('/resume', admin, 'POST');
  assert.equal((await State.findById(STATE_ID).lean()).paused, false);
  await api('/unlink', admin, 'POST');
  assert.equal((await State.findById(STATE_ID).lean()).logoutRequested, true);
  assert.equal((await api('/status')).data.unlinkRequested, true);
});

test('the queue list is newest first, filters by status and pages by 20', async () => {
  for (let i = 0; i < 25; i += 1) await Queue.create({ to: '919876543210', text: `m${i}`, createdAt: hoursAgo(25 - i) });
  await Queue.create({ status: 'skipped', text: 'skipped one', lastError: 'No phone' });
  let { data } = await api('/queue');
  assert.equal(data.total, 26);
  assert.equal(data.pages, 2);
  assert.equal(data.rows.length, 20);
  assert.equal(data.rows[0].text, 'skipped one');
  ({ data } = await api('/queue?status=skipped'));
  assert.deepEqual(data.rows.map(row => row.lastError), ['No phone']);
  ({ data } = await api('/queue?status=pending&page=2'));
  assert.equal(data.rows.length, 5);
  assert.equal((await api('/queue?status=nonsense')).status, 400);
});

test('history "not sent" lists failed, skipped and expired together, never a sent or waiting one', async () => {
  for (const status of ['sent', 'pending', 'failed', 'skipped', 'expired']) {
    await Queue.create({ status, text: status, ...(status === 'skipped' ? {} : { to: '919876543210' }) });
  }
  const { data } = await api('/queue?status=not-sent');
  assert.deepEqual(data.rows.map(row => row.status).sort(), ['expired', 'failed', 'skipped']);
  assert.equal(data.total, 3);
});

test('upcoming: waiting messages in sending order with when each should go, or why nothing goes', async () => {
  const live = { _id: STATE_ID, connection: 'connected', heartbeatAt: new Date(), settings: { ...RECOMMENDED, quietHours: false } };
  await State.create(live);
  await Queue.create([
    { to: '919000000002', text: 'second', createdAt: hoursAgo(1) },
    { to: '919000000001', text: 'first', createdAt: hoursAgo(2) },
    { to: '919000000003', text: 'gone', status: 'sent', createdAt: hoursAgo(3) },
  ]);
  let { status, data } = await api('/queue/upcoming');
  assert.equal(status, 200);
  assert.equal(data.stopped, null);
  assert.equal(data.total, 2);
  assert.deepEqual(data.rows.map(row => [row.position, row.text]), [[1, 'first'], [2, 'second']]);
  const [one, two] = data.rows.map(row => new Date(row.eta).getTime());
  assert.ok(one >= Date.now() - 5_000 && one < Date.now() + 60_000);
  assert.ok(two - one >= RECOMMENDED.minGapSec * 1000, 'the second one waits the gap after the first');

  await State.updateOne({ _id: STATE_ID }, { paused: true });
  ({ data } = await api('/queue/upcoming'));
  assert.equal(data.stopped, 'paused');
  assert.deepEqual(data.rows.map(row => row.eta), [null, null]);

  await State.updateOne({ _id: STATE_ID }, { paused: false, connection: 'qr' });
  assert.equal((await api('/queue/upcoming')).data.stopped, 'offline');
  await State.updateOne({ _id: STATE_ID }, { connection: 'connected', heartbeatAt: new Date(Date.now() - 120_000) });
  assert.equal((await api('/queue/upcoming')).data.stopped, 'not-running');
  delete process.env.ENABLE_WHATSAPP;
  assert.equal((await api('/queue/upcoming')).data.stopped, 'off');
});

test('send again puts only a failed message from the last 24 hours back in the queue', async () => {
  const fresh = await Queue.create({ to: '919876543210', text: 'x', status: 'failed', attempts: 3, lastError: 'socket closed', expiresAt: new Date(Date.now() + 1e9), createdAt: hoursAgo(2) });
  const old = await Queue.create({ to: '919876543210', text: 'y', status: 'failed', createdAt: hoursAgo(25) });
  const sent = await Queue.create({ to: '919876543210', text: 'z', status: 'sent', createdAt: hoursAgo(1) });

  const { data } = await api('/queue?status=failed');
  assert.deepEqual(data.rows.map(row => [row.text, row.canRetry]), [['x', true], ['y', false]]);

  assert.equal((await api(`/queue/${fresh._id}/retry`, admin, 'POST')).status, 200);
  const row = await Queue.findById(fresh._id).lean();
  assert.deepEqual([row.status, row.attempts, row.lastError, row.expiresAt], ['pending', 0, null, undefined]);
  for (const id of [old._id, sent._id, fresh._id]) assert.equal((await api(`/queue/${id}/retry`, admin, 'POST')).status, 409);
  assert.equal((await api('/queue/not-an-id/retry', admin, 'POST')).status, 400);
});

test('sending rules: recommended until saved, a save is checked and stored, reset brings back the recommended rules', async () => {
  let { data } = await api('/settings');
  assert.deepEqual(data.settings, RECOMMENDED);
  assert.deepEqual(data.recommended, RECOMMENDED);
  assert.equal('dailyLimit' in data.limits, false);
  assert.deepEqual(data.warnings, []);

  const mine = { ...RECOMMENDED, minGapSec: 45, quietFrom: 20, quietTo: 12, maxAgeHours: 12 };
  ({ data } = await api('/settings', admin, 'POST', mine));
  assert.deepEqual(data.settings, mine);
  assert.match(data.warnings[0], /will expire/);
  assert.deepEqual((await State.findById(STATE_ID).lean()).settings, mine);
  ({ data } = await api('/status'));
  assert.equal(data.minGapSec, 45);

  const refused = await api('/settings', admin, 'POST', { ...mine, minGapSec: 10 });
  assert.equal(refused.status, 400);
  assert.match(refused.message, /Gap between messages must be a whole number from 30 to 600/);
  assert.equal((await State.findById(STATE_ID).lean()).settings.minGapSec, 45, 'a refused save changes nothing');

  ({ data } = await api('/settings/reset', admin, 'POST'));
  assert.deepEqual(data.settings, RECOMMENDED);
  assert.deepEqual((await State.findById(STATE_ID).lean()).settings, RECOMMENDED);
});

test('send again follows the saved "drop a message after" hours', async () => {
  await State.create({ _id: STATE_ID, settings: { ...RECOMMENDED, maxAgeHours: 1 } });
  const row = await Queue.create({ to: '919876543210', text: 'x', status: 'failed', createdAt: hoursAgo(2) });
  assert.equal((await api('/queue?status=failed')).data.rows[0].canRetry, false);
  const refused = await api(`/queue/${row._id}/retry`, admin, 'POST');
  assert.equal(refused.status, 409);
  assert.match(refused.message, /last 1 hours/);
});
