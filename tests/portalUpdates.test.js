const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Invoice = require('../models/invoiceModel');
const Reservation = require('../models/offerReservationModel');
process.env.TOKEN_SECRET_KEY = 'isolated-portal-sse-test';
let db, worker, server, base, users;
const cookie = user => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(db.getUri(), { dbName: 'merasoftware-fix-test' });
  await Promise.all([User.init(), Invoice.init(), Reservation.init()]);
  users = await User.create([
    { email: 'admin@isolated.test', roles: ['admin'] },
    { email: 'a@isolated.test', roles: ['customer'] },
    { email: 'b@isolated.test', roles: ['customer'] },
  ]);
  worker = await new MongoClient(db.getUri()).connect();
  const app = express(); app.use(cookieParser());
  app.get('/updates', require('../middleware/authToken'), require('../routes/leadUpdates').portal);
  server = app.listen(0, '127.0.0.1'); await new Promise(done => server.once('listening', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await worker.close(); await mongoose.disconnect(); await db.stop(); });

async function open(user) {
  const controller = new AbortController();
  const response = await fetch(base + '/updates', { headers: { cookie: cookie(user) }, signal: controller.signal });
  assert.equal(response.status, 200);
  const messages = [], waiters = new Set();
  const reader = response.body.getReader();
  void (async () => {
    let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += new TextDecoder().decode(chunk.value);
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) { messages.push(JSON.parse(data.slice(6))); for (const check of waiters) check(); }
        }
      }
    } catch (error) { if (error.name !== 'AbortError') throw error; }
  })();
  const wait = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('SSE signal timeout')); }, 7000);
    const check = () => { const found = messages.find(predicate); if (found) { clearTimeout(timer); waiters.delete(check); resolve(found); } };
    waiters.add(check); check();
  });
  await wait(message => message.type === 'ready');
  return { messages, wait, close: () => controller.abort() };
}

test('customer events are owner scoped across worker insert/update/delete; admin sees domains', async () => {
  const [admin, a, b] = await Promise.all(users.map(open));
  const collection = worker.db('merasoftware-fix-test').collection(Invoice.collection.name);
  const owns = (domain, id) => message => message.resources?.some(resource => resource.domain === domain && resource.ids.includes(String(id)));
  try {
    const invoiceId = new mongoose.Types.ObjectId();
    await collection.insertOne({ _id: invoiceId, userId: users[1]._id, invoiceNumber: 'PRIVATE', amount: 12345 });
    await Promise.all([a.wait(owns('invoices', invoiceId)), admin.wait(owns('invoices', invoiceId))]);
    assert.equal(b.messages.some(owns('invoices', invoiceId)), false);
    assert.doesNotMatch(JSON.stringify(a.messages), /PRIVATE|12345|isolated\.test/);
    a.messages.length = 0;
    await collection.updateOne({ _id: invoiceId }, { $set: { status: 'paid' } });
    await a.wait(owns('invoices', invoiceId));
    a.messages.length = 0;
    await collection.deleteOne({ _id: invoiceId });
    await a.wait(owns('invoices', invoiceId));
    assert.equal(b.messages.some(owns('invoices', invoiceId)), false);
    const offerId = new mongoose.Types.ObjectId();
    await worker.db('merasoftware-fix-test').collection(Reservation.collection.name).insertOne({ _id: offerId, userId: users[2]._id, offerSlug: 'private-offer' });
    await b.wait(owns('offers', offerId));
    assert.equal(a.messages.some(owns('offers', offerId)), false);
  } finally { admin.close(); a.close(); b.close(); }
});

test('reconnection snapshots existing ownership so delete without preimages still reaches its owner', async () => {
  const invoiceId = new mongoose.Types.ObjectId();
  await Invoice.collection.insertOne({ _id: invoiceId, userId: users[1]._id, amount: 1 });
  const a = await open(users[1]);
  try {
    await Invoice.collection.deleteOne({ _id: invoiceId });
    await a.wait(message => message.resources?.some(resource => resource.domain === 'invoices' && resource.ids.includes(String(invoiceId))));
  } finally { a.close(); }
});

test('communication worker writes notify admins only and heartbeat-only writes stay quiet', async () => {
  const { EmailDraft } = require('../models/emailControlModel');
  const { State } = require('../whatsapp/src/models');
  const [admin, customer] = await Promise.all([open(users[0]), open(users[1])]);
  const domain = message => message.resources?.some(resource => resource.domain === 'communication');
  try {
    await worker.db('merasoftware-fix-test').collection(EmailDraft.collection.name).insertOne({ subject: 'SECRET SUBJECT', to: ['private@example.test'] });
    await admin.wait(domain);
    assert.equal(customer.messages.some(domain), false);
    assert.doesNotMatch(JSON.stringify(admin.messages), /SECRET SUBJECT|private@example/);
    admin.messages.length = 0;
    await State.collection.insertOne({ _id: 'verification-worker', connection: 'connected' });
    await admin.wait(domain);
    admin.messages.length = 0;
    await State.collection.updateOne({ _id: 'verification-worker' }, { $set: { heartbeatAt: new Date(), updatedAt: new Date() } });
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(admin.messages.some(domain), false);
    await State.collection.updateOne({ _id: 'verification-worker' }, { $set: { connection: 'disconnected' } });
    await admin.wait(domain);
    assert.equal(customer.messages.some(domain), false);
  } finally { admin.close(); customer.close(); }
});

test('revoked admin is refused before the next changed batch is delivered', async () => {
  const admin = await open(users[0]);
  try {
    await User.updateOne({ _id: users[0]._id }, { $set: { roles: ['customer'] } });
    await admin.wait(message => message.type === 'denied');
    assert.equal(admin.messages.some(message => message.type === 'changed'), false);
  } finally {
    admin.close();
    await User.updateOne({ _id: users[0]._id }, { $set: { roles: ['admin'] } });
  }
});

test('upload link signals include authorized owner for scoped lists without invalidating orders', async () => {
  const Link = require('../models/externalUploadLinkModel');
  const [admin, owner, other] = await Promise.all(users.map(open));
  const changed = message => message.resources?.some(resource => resource.domain === 'upload-links');
  try {
    const id = new mongoose.Types.ObjectId();
    await worker.db('merasoftware-fix-test').collection(Link.collection.name).insertOne({ _id: id, customerId: users[1]._id, tokenHash: 'isolated-history-test', status: 'active' });
    const messages = await Promise.all([admin.wait(changed), owner.wait(changed)]);
    for (const message of messages) {
      const links = message.resources.find(resource => resource.domain === 'upload-links');
      assert.ok(links.ids.includes(String(users[1]._id)));
      assert.ok(links.ids.includes(String(id)));
      assert.equal(message.resources.some(resource => resource.domain === 'orders'), false);
    }
    assert.equal(other.messages.some(changed), false);
    owner.messages.length = 0;
    await Link.collection.deleteOne({ _id: id });
    const deleted = await owner.wait(changed);
    assert.equal(deleted.resources.find(resource => resource.domain === 'upload-links').all, true);
    assert.equal(other.messages.some(changed), false);
  } finally { admin.close(); owner.close(); other.close(); }
});
