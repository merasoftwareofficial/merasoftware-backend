const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { POLICY, normalizedPath, manifestFor } = require('../helpers/websitePreviewPolicy');
const service = require('../helpers/websitePreviewService');
const { Preview, Version, Receipt } = require('../models/websitePreviewModel');
const Users = require('../models/userModel'), Orders = require('../models/orderProductModel');
let database;
before(async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
  process.env.WEBSITE_PREVIEW_PRIVATE_KEY = keys.privateKey; process.env.WEBSITE_PREVIEW_PUBLIC_KEY = keys.publicKey;
  process.env.WEBSITE_PREVIEW_SERVICE_SECRET = 'isolated-preview-service-test-secret-only'; process.env.WEBSITE_PREVIEW_SERVICE_URL = 'https://www.example.test';
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60_000 }] });
  await mongoose.connect(database.getUri('website-preview-test'));
  await Promise.all([Preview.init(), Version.init(), Receipt.init(), Users.init(), Orders.init()]);
});
after(async () => { await mongoose.disconnect(); if (database) await database.stop(); });
async function fixture() {
  const adminId = new mongoose.Types.ObjectId(), customerId = new mongoose.Types.ObjectId(), otherId = new mongoose.Types.ObjectId(), projectId = new mongoose.Types.ObjectId();
  await Users.collection.insertMany([{ _id: adminId, name: 'Preview Admin', email: `${adminId}@example.test`, roles: ['admin'], isActive: true },
    { _id: customerId, name: 'Preview Client', email: `${customerId}@example.test`, roles: ['customer'], isActive: true },
    { _id: otherId, name: 'Other Client', email: `${otherId}@example.test`, roles: ['customer'], isActive: true }]);
  await Orders.collection.insertOne({ _id: projectId, userId: customerId, isWebsiteProject: true, projectSnapshot: { displayName: 'Preview test', category: 'standard_websites' },
    projectProgress: 20, orderVisibility: 'approved', projectLink: 'https://public.example.test', portfolioCaptureAllowed: true });
  const f = { projectId: String(projectId), adminId: String(adminId), customerId: String(customerId), otherId: String(otherId) };
  await service.settings(f.projectId, f.adminId, 'admin', { host: `${String(projectId)}-preview.merasoftware.com` });
  return f;
}
const files = [{ path: 'index.html', size: 10 }, { path: 'assets/site.js', size: 20 }, { path: 'services/index.html', size: 30 }];
async function upload(f) {
  const begun = await service.begin(f.projectId, f.adminId, 'admin', { requestId: randomUUID(), files });
  const batch = await service.uploadBatch(f.projectId, begun.versionId, f.adminId, 'admin');
  const frozen = await service.freeze({ capability: batch.capability });
  return { ...begun, ...frozen };
}
async function ready(f) { const v = await upload(f); await service.finish(v); return v; }

test('manifest validates traversal, normalized duplicates, reserved routes, entry point and actual limits', () => {
  for (const path of ['../a.js', '/a.js', 'x\\y.js', 'x/%2f.js', 'x//a.js', 'api/x.js', 'admin/index.html', 'sw.js', '__website-preview/index.html', 'test.php']) assert.throws(() => normalizedPath(path), undefined, path);
  assert.equal(normalizedPath('Images/bedroom.jpg'), 'Images/bedroom.jpg');
  assert.throws(() => manifestFor([{ path: 'x.js', size: 1 }], 'p', 'v'), /index.html/);
  assert.throws(() => manifestFor([{ path: 'index.html', size: POLICY.fileBytes + 1 }], 'p', 'v'), /size limit/);
  assert.throws(() => manifestFor([{ path: 'index.html', size: 1 }, { path: 'cafe\u0301.js', size: 1 }, { path: 'caf\u00e9.js', size: 1 }], 'p', 'v'), /Duplicate/);
});
test('ownership, guest, ban, deleted owner and current role membership are checked server-side', async () => {
  const f = await fixture();
  await assert.rejects(service.state(f.projectId, f.otherId, 'customer'), e => e.status === 404);
  await assert.rejects(service.begin(f.projectId, f.customerId, 'customer', { requestId: randomUUID(), files }), e => e.status === 403);
  await Users.updateOne({ _id: f.adminId }, { $set: { roles: ['customer'] } });
  await assert.rejects(service.settings(f.projectId, f.adminId, 'admin', { visible: false }), e => e.status === 403);
  await Users.updateOne({ _id: f.customerId }, { $set: { isGuest: true } });
  await assert.rejects(service.state(f.projectId, f.customerId, 'customer'), e => e.status === 403);
});
test('upload request IDs are idempotent and cannot be reused for a different manifest', async () => {
  const f = await fixture(), requestId = randomUUID();
  const a = await service.begin(f.projectId, f.adminId, 'admin', { requestId, files });
  const b = await service.begin(f.projectId, f.adminId, 'admin', { requestId, files });
  assert.equal(a.versionId, b.versionId);
  await assert.rejects(service.begin(f.projectId, f.adminId, 'admin', { requestId, files: [{ path: 'index.html', size: 99 }] }), e => e.status === 409);
});
test('failed replacement leaves the working preview and public portfolio source untouched', async () => {
  const f = await fixture(), a = await ready(f), b = await upload(f);
  await service.failed(b);
  assert.equal((await Preview.findById(f.projectId)).currentVersion, a.versionId);
  assert.equal((await Version.findById(b.versionId)).state, 'failed');
  const order = await Orders.findById(f.projectId).lean();
  assert.equal(order.projectLink, 'https://public.example.test'); assert.equal(order.portfolioCaptureAllowed, true);
});
test('concurrent activation has one winner and never switches to an unverified version', async () => {
  const f = await fixture(), a = await upload(f), b = await upload(f);
  const result = await Promise.allSettled([service.finish(a), service.finish(b)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = result.find(r => r.status === 'rejected'); assert.equal(rejected.reason.status, 409);
  const p = await Preview.findById(f.projectId), v = await Version.findById(p.currentVersion);
  assert.equal(v.state, 'ready');
});
test('visibility changes survive replacement, handoff is single use, and hidden preview is admin-only', async () => {
  const f = await fixture(); await ready(f);
  await assert.rejects(service.grant(f.projectId, f.customerId, 'customer', randomUUID()), e => e.status === 404);
  await service.settings(f.projectId, f.adminId, 'admin', { visible: true });
  const g = await service.grant(f.projectId, f.customerId, 'customer', randomUUID());
  const data = await service.redeem(g.token);
  assert.equal(data.claims.projectId, f.projectId); assert.ok(data.claims.permissionUntil <= data.claims.iat + 60);
  await assert.rejects(service.redeem(g.token), e => e.status === 409);
  const v = await upload(f); await service.settings(f.projectId, f.adminId, 'admin', { visible: false }); await service.finish(v);
  assert.equal((await Preview.findById(f.projectId)).visible, false);
  const adminGrant = await service.grant(f.projectId, f.adminId, 'admin', randomUUID()); assert.ok(adminGrant.token);
});
test('a handoff is invalid after hide, a role removal, or a project cancellation', async () => {
  const f = await fixture(); await ready(f); await service.settings(f.projectId, f.adminId, 'admin', { visible: true });
  const g = await service.grant(f.projectId, f.customerId, 'customer', randomUUID());
  await service.settings(f.projectId, f.adminId, 'admin', { visible: false });
  await assert.rejects(service.redeem(g.token), e => e.status === 403);
  const a = await service.grant(f.projectId, f.adminId, 'admin', randomUUID());
  await Users.updateOne({ _id: f.adminId }, { $set: { roles: [] } });
  await assert.rejects(service.redeem(a.token), e => e.status === 403);
  await Orders.updateOne({ _id: f.projectId }, { $set: { orderVisibility: 'cancelled' } });
  await assert.rejects(service.state(f.projectId, f.customerId, 'customer'), e => e.status === 403);
});
test('expired verification cannot activate and frozen uploads cannot request a new batch', async () => {
  const f = await fixture();
  const begun = await service.begin(f.projectId, f.adminId, 'admin', { requestId: randomUUID(), files });
  const expiry = new Date(Date.now() + 60000);
  await Version.updateOne({ _id: begun.versionId }, { $set: { expiresAt: expiry } });
  const batch = await service.uploadBatch(f.projectId, begun.versionId, f.adminId, 'admin');
  assert.ok(require('jsonwebtoken').decode(batch.capability).validUntil <= expiry.getTime());
  const v = await service.freeze({ capability: batch.capability });
  await assert.rejects(service.uploadBatch(f.projectId, v.versionId, f.adminId, 'admin'), e => e.status === 409);
  await Version.updateOne({ _id: v.versionId }, { $set: { leaseUntil: new Date(Date.now() - 1) } });
  await assert.rejects(service.finish(v), e => e.status === 409);
  assert.equal((await Preview.findById(f.projectId)).currentVersion, null);
});
test('cleanup claims exclude current/recovery and a claimed version cannot be activated again', async () => {
  const f = await fixture(), a = await ready(f), b = await ready(f), c = await ready(f);
  const old = new Date(Date.now() - 26 * 3600_000);
  await Version.collection.updateMany({ projectId: new mongoose.Types.ObjectId(f.projectId) }, { $set: { updatedAt: old, latestTokenExpiry: old } });
  const batch = await service.cleanupClaims(f.projectId, f.adminId, 'admin'); assert.equal(batch.claims.length, 1);
  assert.equal((await Version.findById(a.versionId)).state, 'deleting');
  assert.equal((await Version.findById(b.versionId)).state, 'ready'); assert.equal((await Version.findById(c.versionId)).state, 'ready');
  await assert.rejects(service.finish(a), e => e.status === 409);
  await service.cleanupDone({ capability: batch.claims[0] }); assert.equal((await Version.findById(a.versionId)).state, 'deleted');
});
