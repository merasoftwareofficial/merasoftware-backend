const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createGate, uploadBatch } = require('../helpers/uploadConcurrency');
const Submission = require('../models/uploadSubmissionModel');
const Order = require('../models/orderProductModel');
require('../models/productModel');
const Request = require('../models/updateRequestModel');
const Link = require('../models/externalUploadLinkModel');
const { claimSubmission, findSubmission, failSubmission, commitSubmission } = require('../helpers/uploadSubmission');
const { randomUUID } = require('node:crypto');

let database;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Submission.init(), Request.init(), Order.init(), Link.init()]);
});
after(async () => { await mongoose.disconnect(); if (database) await database.stop(); });

const tick = () => new Promise(resolve => setImmediate(resolve));
function makeRequest(ownerId, orderId, uploadId = randomUUID()) {
  return { userId: String(ownerId), query: { uploadId },
    body: { planId: String(orderId), instructions: '[]', serviceOrderId: String(orderId) },
    files: [{ originalname: 'small.txt', mimetype: 'text/plain', size: 3, buffer: Buffer.from('abc') }] };
}
async function service(limit = 3) {
  const ownerId = new mongoose.Types.ObjectId();
  const orderId = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({ _id: orderId, userId: ownerId, isServicePlan: true, isActive: true,
    servicePlanStatus: 'active', serviceAccessUsedInCycle: 0, serviceAccessUsedTotal: 0,
    servicePlanSnapshot: { capability: 'upload_data', portalAccessCount: limit, filesLimit: 100, limitScope: 'per_plan' } });
  return { ownerId, orderId };
}

test('parallel batches keep order and obey both per-request and shared limits', async () => {
  const gate = createGate(6);
  let active = 0, maximum = 0;
  const batch = async () => {
    let local = 0, localMaximum = 0;
    const output = await uploadBatch(Array.from({ length: 9 }, (_, index) => index), index => gate(async () => {
      active++; local++;
      maximum = Math.max(maximum, active); localMaximum = Math.max(localMaximum, local);
      await tick();
      active--; local--;
      return { index };
    }), async () => {});
    assert.deepEqual(output.map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(localMaximum <= 3);
  };
  await Promise.all([batch(), batch(), batch()]);
  assert.equal(maximum, 6);
});

test('failed batch settles in-flight work, stops new files, then cleans all successes', async () => {
  const events = [];
  const started = [];
  await assert.rejects(uploadBatch([0, 1, 2, 3, 4], async index => {
    started.push(index);
    if (index === 1) throw new Error('Drive failed');
    await tick();
    events.push(`saved:${index}`);
    return { index };
  }, async item => { events.push(`deleted:${item.index}`); }), /Drive failed/);
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(events.slice(0, 2).sort(), ['saved:0', 'saved:2']);
  assert.deepEqual(events.slice(2).sort(), ['deleted:0', 'deleted:2']);
});

test('same identity cannot be claimed twice; content conflicts and stale attempts are fenced', async () => {
  const { ownerId, orderId } = await service();
  const req = makeRequest(ownerId, orderId);
  const claimed = await claimSubmission(req);
  assert.ok(claimed.document);
  assert.equal((await claimSubmission(req)).pending, true);
  const changed = { ...req, body: { ...req.body, instructions: '[{"text":"different"}]' } };
  await assert.rejects(claimSubmission(changed), /different data/);
  req.uploadAttempt = claimed;
  await failSubmission(req);
  const retried = await claimSubmission(req);
  assert.notEqual(retried.document.attemptToken, claimed.document.attemptToken);
  assert.equal((await Submission.updateOne(claimed.filter, { $set: { phase: 'incorrect' } })).modifiedCount, 0);
});

test('request, service allowance, single-use link and replay result commit together', async () => {
  const { ownerId, orderId } = await service();
  const linkId = new mongoose.Types.ObjectId();
  const reservationId = randomUUID();
  await Link.collection.insertOne({ _id: linkId, customerId: ownerId, orderId, status: 'active', mode: 'single', tokenDigest: randomUUID(), useCount: 0, reservationId });
  const req = makeRequest(ownerId, orderId);
  req.externalUpload = { session: { customerId: String(ownerId), linkId: String(linkId) }, link: { _id: linkId, mode: 'single' }, reservationId };
  req.uploadAttempt = await claimSubmission(req);
  const committed = await commitSubmission(req, { instructions: [], files: [{ filename: 'small.txt', size: 3 }] });
  assert.equal(committed.response.success, true);
  assert.equal((await Request.countDocuments({ _id: committed.requestId })), 1);
  assert.equal((await Order.findById(orderId)).serviceAccessUsedInCycle, 1);
  assert.equal((await Link.findById(linkId)).status, 'used');
  assert.equal((await Link.findById(linkId)).useCount, 1);
  const replay = await claimSubmission(req);
  assert.deepEqual(replay.replay, committed.response);
  assert.equal(await Request.countDocuments({ updatePlanId: orderId }), 1);
  const foreign = { ...req, userId: String(new mongoose.Types.ObjectId()) };
  assert.equal(await findSubmission(foreign), null);
  assert.equal(await findSubmission({ ...req, externalUpload: undefined }), null);
});

test('transaction failure rolls back request and allowance writes', async () => {
  const { ownerId, orderId } = await service();
  const req = makeRequest(ownerId, orderId);
  req.uploadAttempt = await claimSubmission(req);
  const original = Submission.updateOne;
  try {
    Submission.updateOne = function(filter, update, options) {
      if (update.$set?.status === 'succeeded') throw new Error('Simulated final write failure');
      return original.call(this, filter, update, options);
    };
    await assert.rejects(commitSubmission(req, { instructions: [], files: [] }), /Simulated final write/);
  } finally { Submission.updateOne = original; }
  assert.equal(await Request.countDocuments({ updatePlanId: orderId }), 0);
  assert.equal((await Order.findById(orderId)).serviceAccessUsedInCycle, 0);
  assert.equal((await findSubmission(req)).status, 'processing');
});

test('two simultaneous submissions cannot spend the last service allowance twice', async () => {
  const { ownerId, orderId } = await service(1);
  const requests = [makeRequest(ownerId, orderId), makeRequest(ownerId, orderId)];
  for (const req of requests) req.uploadAttempt = await claimSubmission(req);
  const results = await Promise.allSettled(requests.map(req => commitSubmission(req, { instructions: [], files: [] })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await Request.countDocuments({ updatePlanId: orderId }), 1);
  assert.equal((await Order.findById(orderId)).serviceAccessUsedInCycle, 1);
});

test('real external HTTP flow replays a used single-use link and rejects revoked access', async () => {
  process.env.EXTERNAL_UPLOAD_TOKEN_SECRET = 'local-test-secret-only-more-than-32-characters';
  process.env.NODE_ENV = 'test';
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const User = require('../models/userModel');
  const Drive = require('../helpers/googleDriveService');
  const originals = { createDriveClient: Drive.prototype.createDriveClient, createFolder: Drive.prototype.createFolder, uploadFile: Drive.prototype.uploadFile };
  let uploads = 0;
  Drive.prototype.createDriveClient = () => ({});
  Drive.prototype.createFolder = async () => 'test-folder';
  Drive.prototype.uploadFile = async () => ({ id: `test-file-${++uploads}`, link: 'https://example.test/file' });
  const controller = require('../controller/user/externalUploadController');
  const { issueExternalUploadSession, SESSION_STAGE, AUTH_MODE } = require('../helpers/externalUploadSession');
  const { ownerId, orderId } = await service();
  await User.collection.insertOne({ _id: ownerId, isActive: true, isGuest: false, deletedAt: null, allowLoginFreeUploadLinks: true, name: 'Test', email: 'test@example.test' });
  const linkId = new mongoose.Types.ObjectId();
  await Link.collection.insertOne({ _id: linkId, customerId: ownerId, orderId, status: 'active', mode: 'single', tokenDigest: randomUUID(), useCount: 0, reservationId: null });
  let cookie;
  issueExternalUploadSession({ res: {cookie(name,value) { cookie = `${name}=${value}`; }}, linkId, customerId: ownerId, orderId, stage: SESSION_STAGE.ACCESS, authMode: AUTH_MODE.LINK });
  const app = express();
  app.use(cookieParser());
  app.post('/submit', controller.requireAccess, controller.reserveSingleUse, controller.parseFiles, controller.submit);
  app.get('/progress/:uploadId', controller.requireAccess, require('../controller/user/getUploadProgress'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const uploadId = randomUUID();
  const submit = async (text = 'abc') => {
    const form = new FormData();
    form.set('instructions', '[]');
    form.append('files', new Blob([text], { type: 'text/plain' }), 'test.txt');
    const response = await fetch(`${origin}/submit?uploadId=${uploadId}`, { method: 'POST', headers: {cookie}, body: form });
    return { status: response.status, body: await response.json() };
  };
  try {
    const first = await submit();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.success, true);
    const replay = await submit();
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    assert.equal(uploads, 1);
    assert.equal((await Order.findById(orderId)).serviceAccessUsedInCycle, 1);
    assert.equal((await Link.findById(linkId)).useCount, 1);
    assert.equal((await submit('different')).status, 409);
    const progress = await fetch(`${origin}/progress/${uploadId}`, { headers: {cookie} });
    assert.equal((await progress.json()).data.status, 'succeeded');
    await Link.updateOne({ _id: linkId }, { $set: {status:'revoked'} });
    assert.equal((await fetch(`${origin}/progress/${uploadId}`, {headers:{cookie}})).status, 401);
  } finally {
    Object.assign(Drive.prototype, originals);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
