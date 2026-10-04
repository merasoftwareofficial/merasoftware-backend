const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { portfolioSource, publicUrl } = require('../helpers/portfolioSource');
const { isPublicAddress, resolvePublic, captureUrl, createCaptureProxy } = require('../helpers/portfolioCapture');
const http = require('node:http');
let database;
before(async () => { database = new MongoMemoryServer({ instance: { launchTimeout: 60_000 } }); await database.start(); process.env.MONGODB_URI = database.getUri(); await mongoose.connect(process.env.MONGODB_URI); });
after(async () => { await mongoose.disconnect(); if (database) await database.stop(); });

test('source projection excludes private data and uses frozen project names', () => {
  const source = portfolioSource({ _id: 'a'.repeat(24), userId: { _id: 'b'.repeat(24), name: 'Client', email: 'private@example.test', isGuest: false },
    isWebsiteProject: true, projectSnapshot: { displayName: 'Frozen title', category: 'standard_websites', finalPrice: 123 },
    productId: { serviceName: 'Changed template' }, projectProgress: 100, orderVisibility: 'approved', price: 123, messages: ['private'], projectLink: 'https://example.com' });
  assert.equal(source.name, 'Frozen title'); assert.equal(source.state, 'completed');
  assert.equal(source.url, 'https://example.com/');
  assert.equal(JSON.stringify(source).includes('private'), false);
  assert.equal(portfolioSource({ isWebsiteProject: true, userId: { isGuest: true } }), null);
  assert.equal(portfolioSource({ isWebsiteProject: true, userId: null }), null);
  assert.equal(publicUrl('javascript:alert(1)'), ''); assert.equal(publicUrl('https://user:password@example.com'), '');
});
test('standalone and linked services remain purchased orders, even after template deletion', () => {
  const source = portfolioSource({ _id: 'a'.repeat(24), userId: { _id: 'b'.repeat(24) }, isServicePlan: true,
    servicePlanSnapshot: { serviceName: 'SEO monthly' }, productId: null, linkedProjectOrderId: 'c'.repeat(24), servicePlanStatus: 'active', orderVisibility: 'approved' });
  assert.equal(source.type, 'service'); assert.equal(source.name, 'SEO monthly'); assert.equal(source.linkedProjectId, 'c'.repeat(24));
});
test('network checks reject loopback, private, mapped and reserved IPs and mixed DNS answers', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.1.2', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  await assert.rejects(resolvePublic('example.test', async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]));
  assert.equal(await resolvePublic('example.test', async () => [{ address: '8.8.8.8' }]), '8.8.8.8');
  assert.throws(() => captureUrl('file:///etc/passwd')); assert.throws(() => captureUrl('http://example.com:8080')); assert.throws(() => captureUrl('https://user:pass@example.com'));
});
test('capture proxy blocks direct private targets and HTTPS tunnels', async () => {
  const proxy = await createCaptureProxy();
  try {
    const address = new URL(proxy.url);
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: address.hostname, port: address.port, path: 'http://127.0.0.1/private' }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 403);
    const tunnelStatus = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: address.hostname, port: address.port, method: 'CONNECT', path: '127.0.0.1:443' });
      request.on('connect', (response, socket) => { resolve(response.statusCode); socket.destroy(); }); request.on('error', reject); request.end();
    });
    assert.equal(tunnelStatus, 403);
  } finally { await proxy.close(); }
});
test('durable worker retries delivery, imports snapshots and emits deletion tombstones', async () => {
  process.env.PORTFOLIO_WEBSITE_URL = 'http://localhost:3999'; process.env.PORTFOLIO_INTEGRATION_SECRET = 'portfolio-test-secret-'.repeat(3); process.env.PORTFOLIO_CAPTURE_ENABLED = 'false';
  const orders = require('../models/orderProductModel'); const users = require('../models/userModel');
  const outbox = require('../models/portfolioOutboxModel'); const { tick } = require('../scripts/portfolioWorker');
  const userId = new mongoose.Types.ObjectId(), orderId = new mongoose.Types.ObjectId();
  await users.collection.insertOne({ _id: userId, name: 'Test client', isGuest: false });
  await orders.collection.insertOne({ _id: orderId, userId, isWebsiteProject: true, projectSnapshot: { displayName: 'Test project', category: 'standard_websites' }, projectProgress: 100, orderVisibility: 'approved', projectLink: 'https://example.com' });
  const originalFetch = global.fetch; let payload;
  try {
    global.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(tick());
    const failed = await outbox.findById(String(orderId)).lean();
    assert.equal(failed.pending, true); assert.equal(failed.attempts, 1);
    await outbox.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    global.fetch = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({ success: true }) }; };
    await tick(); assert.equal(payload.sources[0].name, 'Test project');
    assert.equal((await outbox.findById(String(orderId))).pending, false);
    const revision = payload.sources[0].revision;
    await orders.deleteOne({ _id: orderId }); await tick();
    assert.equal(payload.sources[0].available, false); assert.ok(payload.sources[0].revision > revision);
    assert.equal(payload.sources[0].captureAllowed, false);
  } finally { global.fetch = originalFetch; }
});
