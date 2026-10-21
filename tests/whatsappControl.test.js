const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Queue, State, STATE_ID } = require('../whatsapp/src/models.js');
const userModel = require('../models/userModel');
const nativeFetch = global.fetch;
let db, server, base, admin, customer;
const cookie = user => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function api(path, user = admin, method = 'GET') {
  const response = await nativeFetch(base + path, { method, headers: user ? { Cookie: cookie(user) } : {} });
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
  for (const [path, method] of [['/status', 'GET'], ['/queue', 'GET'], ['/pause', 'POST'], ['/unlink', 'POST']]) {
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
  assert.equal(data.dailyLimit, 150);
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
