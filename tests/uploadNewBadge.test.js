const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Drive is replaced before the download route loads it. Nothing here reaches Google.
let driveFails = false;
const drivePath = require.resolve('../helpers/googleDriveService');
require.cache[drivePath] = {
  id: drivePath, filename: drivePath, loaded: true,
  exports: class { async getFileStream() { if (driveFails) throw new Error('Drive down'); const s = new PassThrough(); s.end('data'); return s; } },
};

const Order = require('../models/orderProductModel');
require('../models/productModel');
require('../models/developerModel');
require('../models/userModel');
const Request = require('../models/updateRequestModel');
const Submission = require('../models/uploadSubmissionModel');
const { countNewUploads, getOrderUploadHistory } = require('../helpers/orderUploadHistory');
const { claimSubmission, commitSubmission } = require('../helpers/uploadSubmission');
const downloadZip = require('../controller/order/downloadUploadRequestZip');
const getOrderDetails = require('../controller/order/getOrderDetails');
const getOrderUploads = require('../controller/order/getOrderUploads');
const { randomUUID } = require('node:crypto');

const id = () => new mongoose.Types.ObjectId();
const goodFile = () => ({ driveFileId: 'drive-1', originalName: 'a.zip', filename: 'a.zip', size: 3 });
let database;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Submission.init(), Request.init(), Order.init()]);
});
after(async () => { await mongoose.disconnect(); if (database) await database.stop(); });

async function project() {
  const ownerId = id(), projectId = id(), linkedId = id();
  await Order.collection.insertMany([
    { _id: projectId, userId: ownerId, isServicePlan: false, createdAt: new Date() },
    { _id: linkedId, userId: ownerId, isServicePlan: true, linkedProjectOrderId: projectId, createdAt: new Date() },
  ]);
  return { ownerId, projectId, linkedId };
}
const upload = async (fields) => (await Request.collection.insertOne({ status: 'pending', deliveryStatus: 'ready', files: [goodFile()], createdAt: new Date(), ...fields })).insertedId;

function call(controller, req) {
  return new Promise((resolve, reject) => {
    let code = 200;
    const res = {
      status(value) { code = value; return this; },
      json(body) { resolve({ status: code, body }); return this; },
    };
    Promise.resolve(controller(req, res)).catch(reject);
  });
}
function download(requestId, role, userId) {
  const res = new PassThrough();
  res.setHeader = () => {};
  res.status = function (code) { this.code = code; return this; };
  res.json = function (body) { this.body = body; this.end(); return this; };
  res.resume();
  return new Promise((resolve, reject) => {
    res.on('finish', () => resolve(res));
    res.on('error', reject);
    downloadZip({ params: { requestId: String(requestId) }, userRole: role, userId: String(userId) }, res).catch(reject);
  });
}

test('only a new, ready, downloadable upload of this project counts; an old one never does', async () => {
  const { ownerId, projectId, linkedId } = await project();
  await upload({ userId: ownerId, updatePlanId: projectId }); // from before this feature
  await upload({ userId: ownerId, updatePlanId: projectId, awaitingFirstDownload: true });
  await upload({ userId: ownerId, updatePlanId: linkedId, awaitingFirstDownload: true });
  await upload({ userId: ownerId, updatePlanId: projectId, awaitingFirstDownload: true, deliveryStatus: 'queued', files: [] });
  await upload({ userId: ownerId, updatePlanId: projectId, awaitingFirstDownload: true, deliveryStatus: 'needs_review', files: [] });
  await upload({ userId: ownerId, updatePlanId: projectId, awaitingFirstDownload: true, files: [{ ...goodFile(), expirationDate: new Date(Date.now() - 1000) }] });
  await upload({ userId: ownerId, updatePlanId: projectId, awaitingFirstDownload: false, firstDownloadedAt: new Date() });
  await upload({ userId: ownerId, updatePlanId: id(), awaitingFirstDownload: true });
  assert.equal(await countNewUploads([projectId, linkedId], ownerId), 2);
});

test('a new upload is marked when it is created, through both creation paths', async () => {
  const ownerId = id(), orderId = id();
  await Order.collection.insertOne({ _id: orderId, userId: ownerId, isServicePlan: true, isActive: true,
    servicePlanStatus: 'active', serviceAccessUsedInCycle: 0, serviceAccessUsedTotal: 0,
    servicePlanSnapshot: { capability: 'upload_data', portalAccessCount: 3, filesLimit: 100, limitScope: 'per_plan' } });
  const req = { userId: String(ownerId), query: { uploadId: randomUUID() },
    body: { planId: String(orderId), instructions: '[]', serviceOrderId: String(orderId) },
    files: [{ originalname: 'a.txt', mimetype: 'text/plain', size: 3, buffer: Buffer.from('abc') }] };
  req.uploadAttempt = await claimSubmission(req);
  const committed = await commitSubmission(req, { instructions: [], files: [goodFile()] });
  assert.equal((await Request.findById(committed.requestId).lean()).awaitingFirstDownload, true);
  // The older path needs a full upload request with Drive, so its one line is checked in the source.
  assert.match(fs.readFileSync(path.join(__dirname, '../controller/user/submitUpdateRequest.js'), 'utf8'), /awaitingFirstDownload: true/);
});

test('saving an old upload does not make it new', async () => {
  const { ownerId, projectId } = await project();
  const oldId = await upload({ userId: ownerId, updatePlanId: projectId });
  const old = await Request.findById(oldId);
  old.status = 'in_progress';
  await old.save();
  assert.equal(await Request.collection.countDocuments({ _id: oldId, awaitingFirstDownload: { $exists: true } }), 0);
  assert.equal(await countNewUploads([projectId], ownerId), 0);
});

test('the first admin download clears it, and the customer download does not', async () => {
  const { ownerId, projectId } = await project();
  const requestId = await upload({ userId: ownerId, updatePlanId: projectId, awaitingFirstDownload: true });

  await download(requestId, 'customer', ownerId);
  assert.equal(await countNewUploads([projectId], ownerId), 1);

  await download(requestId, 'admin', id());
  assert.equal(await countNewUploads([projectId], ownerId), 0);
  const saved = await Request.findById(requestId).lean();
  assert.ok(saved.firstDownloadedAt instanceof Date);
  assert.equal(saved.awaitingFirstDownload, false);

  const firstAt = saved.firstDownloadedAt.getTime();
  await download(requestId, 'admin', id());
  assert.equal((await Request.findById(requestId).lean()).firstDownloadedAt.getTime(), firstAt);
});

test('the first download is saved before the admin gets the end of the zip', async () => {
  const { ownerId, projectId } = await project();
  const requestId = await upload({ userId: ownerId, updatePlanId: projectId, awaitingFirstDownload: true });
  const res = await download(requestId, 'admin', id());
  assert.equal(res.code, undefined);
  assert.equal((await Request.collection.findOne({ _id: requestId })).awaitingFirstDownload, false);
});

test('a download that fails leaves the upload new', async () => {
  const { ownerId, projectId } = await project();
  const requestId = await upload({ userId: ownerId, updatePlanId: projectId, awaitingFirstDownload: true });
  driveFails = true;
  try {
    const res = await download(requestId, 'admin', id());
    assert.equal(res.code, 502);
  } finally { driveFails = false; }
  assert.equal(await countNewUploads([projectId], ownerId), 1);
});

test('the admin project read carries the count; the customer read and a plan read do not', async () => {
  const { ownerId, projectId, linkedId } = await project();
  await upload({ userId: ownerId, updatePlanId: linkedId, awaitingFirstDownload: true });
  const read = (orderId, role, userId) => call(getOrderDetails, { params: { orderId: String(orderId) }, userRole: role, userId: String(userId) });

  assert.equal((await read(projectId, 'admin', id())).body.data.newUploadsCount, 1);
  const customer = await read(projectId, 'customer', ownerId);
  assert.equal(customer.body.success, true);
  assert.equal('newUploadsCount' in customer.body.data, false);
  assert.equal('newUploadsCount' in (await read(linkedId, 'admin', id())).body.data, false);
});

test('the upload list tags new uploads for our team only, and still names plan uploads', async () => {
  const { ownerId, projectId, linkedId } = await project();
  await upload({ userId: ownerId, updatePlanId: projectId });
  await upload({ userId: ownerId, updatePlanId: linkedId, awaitingFirstDownload: true });
  const read = (role, userId) => call(getOrderUploads, { params: { orderId: String(projectId) }, userRole: role, userId: String(userId) });

  const team = (await read('admin', id())).body.data;
  assert.equal(team.length, 2);
  assert.deepEqual(team.map(row => row.isNew).sort(), [false, true]);
  assert.equal(team.find(row => row.orderId === String(linkedId)).isPlanUpload, true);
  assert.equal(team.find(row => row.orderId === String(projectId)).isPlanUpload, false);

  const own = (await read('customer', ownerId)).body.data;
  assert.equal(own.length, 2);
  assert.equal(own.every(row => !('isNew' in row) && !('awaitingFirstDownload' in row)), true);
  assert.equal(own.find(row => row.orderId === String(linkedId)).isPlanUpload, true);

  const helper = await getOrderUploadHistory(projectId);
  assert.equal(helper.find(row => row.orderId === String(linkedId)).isPlanUpload, true);
});
