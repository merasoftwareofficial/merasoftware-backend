const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { randomUUID, createHash } = require('node:crypto');

// The worker's only mail is captured here, so the test sends nothing.
const mails = [];
const emailPath = require.resolve('../helpers/emailService');
const realEmail = require(emailPath);
require.cache[emailPath].exports = { ...realEmail, sendUploadDeliveryStuck: async (record, to) => { mails.push({ record, to }); return true; } };

const Submission = require('../models/uploadSubmissionModel');
const File = require('../models/stagedUploadFileModel');
const Budget = require('../models/uploadStorageBudgetModel');
const Order = require('../models/orderProductModel');
require('../models/productModel');
require('../models/userModel');
const Request = require('../models/updateRequestModel');
const staged = require('../helpers/stagedUploads');
const { runOnce } = require('../helpers/uploadWorker');
const { retryDelivery } = require('../controller/user/stagedUploadController');
const definitions = require('../helpers/emailDefinitions');

let database;
before(async () => {
  process.env.ENABLE_UPLOAD_WORKER = 'true';
  process.env.UPLOAD_STAGING_MAX_BYTES = String(1024 * 1024);
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Submission.init(), File.init(), Budget.init(), Request.init(), Order.init()]);
});
after(async () => {
  await mongoose.disconnect(); await database.stop();
  delete process.env.ENABLE_UPLOAD_WORKER; delete process.env.UPLOAD_STAGING_MAX_BYTES;
});

const drive = failing => ({
  createFolder: async () => 'folder', generateFileId: async () => randomUUID(), deleteFile: async () => {},
  getDownloadLink: id => id, getEmbedableDocumentLink: id => id, getEmbedableImageLink: id => id,
  uploadFile: async () => { if (failing) throw Object.assign(new Error('Drive down'), { code: 503 }); return { id: randomUUID(), link: 'link' }; },
});
const response = () => { const res = { code: 200, set() {}, status(code) { res.code = code; return res; }, json(body) { res.body = body; return res; } }; return res; };

test('a stuck upload mails the admins once, keeps its files, and the admin retry delivers it', async () => {
  const ownerId = new mongoose.Types.ObjectId(), orderId = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({ _id: orderId, userId: ownerId, isActive: true, isWebsiteProject: true, orderVisibility: 'visible', projectProgress: 20 });
  const buffer = Buffer.from('stuck'), fileId = randomUUID(), uploadId = randomUUID();
  const manifest = { planId: String(orderId), serviceOrderId: null, instructions: [], files: [{ id: fileId, name: 'a.txt', type: 'text/plain', size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }] };
  const req = () => ({ userId: String(ownerId), query: { uploadId }, params: { uploadId }, body: structuredClone(manifest) });
  await staged.begin(req());
  await staged.receive({ ...req(), params: { uploadId, fileId }, file: { buffer, size: buffer.length, mimetype: 'text/plain' } });
  await staged.accept(req());

  for (let attempt = 1; attempt <= 8; attempt++) {
    assert.equal(mails.length, 0, 'no mail before the last attempt');
    await Submission.updateOne({ uploadId }, { $set: { nextAttemptAt: new Date(0) } });
    await runOnce({ drive: drive(true) });
  }
  const stuck = await Submission.findOne({ uploadId }).lean();
  assert.equal(stuck.delivery, 'needs_review');
  assert.equal(await File.countDocuments({ submissionId: stuck._id }), 1);
  assert.equal(mails.length, 1);
  assert.equal(String(mails[0].record._id), String(stuck.requestId));
  assert.ok(mails[0].to.length > 0);

  const params = { requestId: String(stuck.requestId) };
  const refused = response();
  await retryDelivery({ userRole: 'customer', params }, refused);
  assert.equal(refused.code, 403);
  const invalid = response();
  await retryDelivery({ userRole: 'admin', params: { requestId: 'not-an-id' } }, invalid);
  assert.equal(invalid.code, 404);

  const accepted = response();
  await retryDelivery({ userRole: 'admin', params }, accepted);
  assert.equal(accepted.body.success, true);
  assert.equal((await Request.findById(stuck.requestId).lean()).deliveryStatus, 'queued');
  await runOnce({ drive: drive(false) });
  assert.equal((await Request.findById(stuck.requestId).lean()).deliveryStatus, 'ready');
  assert.equal(await File.countDocuments({ submissionId: stuck._id }), 0);
  assert.equal((await Budget.findById(staged.BUDGET_ID).lean()).usedBytes, 0);

  const second = response();
  await retryDelivery({ userRole: 'admin', params }, second);
  assert.equal(second.code, 404, 'a delivered upload cannot be retried');
});

test('the stuck-upload mail fills every variable from the upload', () => {
  const definition = (definitions.definitions || definitions).sendUploadDeliveryStuck;
  const built = definition.build({ userId: { name: 'Asha', email: 'asha@example.com' }, files: [{}, {}] }, ['admin@example.com']);
  assert.deepEqual(built.to, ['admin@example.com']);
  assert.equal(built.values.customerName, 'Asha');
  assert.equal(built.values.files, '2 file(s)');
  for (const name of Object.keys(definition.variables)) assert.ok(name in built.values, name);
});
