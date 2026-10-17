const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { randomUUID, createHash } = require('node:crypto');
const Submission = require('../models/uploadSubmissionModel');
const File = require('../models/stagedUploadFileModel');
const Budget = require('../models/uploadStorageBudgetModel');
const Order = require('../models/orderProductModel');
require('../models/productModel');
const Request = require('../models/updateRequestModel');
const Link = require('../models/externalUploadLinkModel');
const staged = require('../helpers/stagedUploads');
const { runOnce } = require('../helpers/uploadWorker');
const env = { ENABLE_UPLOAD_WORKER: process.env.ENABLE_UPLOAD_WORKER, UPLOAD_STAGING_MAX_BYTES: process.env.UPLOAD_STAGING_MAX_BYTES };
let database;
before(async () => {
  process.env.ENABLE_UPLOAD_WORKER = 'true';
  process.env.UPLOAD_STAGING_MAX_BYTES = String(64 * 1024 * 1024);
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Submission.init(), File.init(), Budget.init(), Request.init(), Order.init(), Link.init()]);
});
after(async () => {
  await mongoose.disconnect(); if (database) await database.stop();
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

async function fixture(count = 2) {
  const ownerId = new mongoose.Types.ObjectId(), orderId = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({ _id: orderId, userId: ownerId, isServicePlan: true, isActive: true,
    servicePlanStatus: 'active', serviceAccessUsedInCycle: 0, serviceAccessUsedTotal: 0,
    servicePlanSnapshot: { capability: 'upload_data', portalAccessCount: 10, filesLimit: 100, limitScope: 'per_plan' } });
  const contents = Array.from({ length: count }, (_, index) => Buffer.from(`file-${index}`));
  const manifest = { planId: String(orderId), serviceOrderId: String(orderId), instructions: [], files: contents.map((buffer, index) => ({
    id: randomUUID(), name: `test-${index}.txt`, type: 'text/plain', size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
  })) };
  const uploadId = randomUUID();
  const req = () => ({ userId: String(ownerId), query: { uploadId }, params: { uploadId }, body: structuredClone(manifest) });
  const receive = index => staged.receive({ ...req(), params: { uploadId, fileId: manifest.files[index].id }, file: {
    originalname: manifest.files[index].name, mimetype: 'text/plain', size: contents[index].length, buffer: contents[index],
  } });
  return { ownerId, orderId, uploadId, manifest, req, receive };
}

test('each file is durably received once; receipt finishes before any Drive work', async () => {
  const f = await fixture();
  const record = await staged.begin(f.req());
  assert.equal(record.phase, 'receiving');
  await f.receive(0);
  await f.receive(0);
  assert.equal(await File.countDocuments({ submissionId: record._id }), 1);
  assert.equal((await Submission.findById(record._id)).completedFiles, 1);
  await assert.rejects(staged.accept(f.req()), /not been received/);
  await f.receive(1);
  const result = await staged.accept(f.req());
  assert.equal(result.response.success, true);
  const request = await Request.findById(result.requestId);
  assert.equal(request.deliveryStatus, 'queued');
  assert.ok(request.files.every(file => !file.driveFileId));
  assert.equal(await File.countDocuments({ submissionId: record._id }), 2);
  assert.equal((await Order.findById(f.orderId)).serviceAccessUsedInCycle, 1);
  const replay = await staged.accept(f.req());
  assert.deepEqual(replay.response, result.response);
  assert.equal((await Order.findById(f.orderId)).serviceAccessUsedInCycle, 1);
  // Prevent the next worker test from claiming this intentionally undelivered job.
  await Submission.updateOne({ _id: record._id }, { $set: { nextAttemptAt: new Date(Date.now() + 3600000) } });
});

test('content validation and owner checks happen before accepting a file', async () => {
  const f = await fixture(1);
  const record = await staged.begin(f.req());
  await assert.rejects(staged.load({ ...f.req(), userId: String(new mongoose.Types.ObjectId()) }), /not found/);
  const bad = { ...f.req(), params: { uploadId: f.uploadId, fileId: f.manifest.files[0].id },
    file: { size: f.manifest.files[0].size, mimetype: 'text/plain', buffer: Buffer.alloc(f.manifest.files[0].size) } };
  await assert.rejects(staged.receive(bad), /does not match/);
  assert.equal(await File.countDocuments({ submissionId: record._id }), 0);
  const changed = f.req(); changed.body.files[0].name = 'different.txt';
  await assert.rejects(staged.begin(changed), /different data/);
});

test('concurrent receipt calls cannot spend allowance twice', async () => {
  const f = await fixture(1);
  const record = await staged.begin(f.req()); await f.receive(0);
  const results = await Promise.all([staged.accept(f.req()), staged.accept(f.req())]);
  assert.equal(results[0].response.data.requestId, results[1].response.data.requestId);
  assert.equal(await Request.countDocuments({ updatePlanId: f.orderId }), 1);
  assert.equal((await Order.findById(f.orderId)).serviceAccessUsedInCycle, 1);
  await Submission.updateOne({ _id: record._id }, { $set: { nextAttemptAt: new Date(Date.now() + 3600000) } });
});

test('worker restart after uncertain Drive upload reuses identities and releases storage only after final commit', async () => {
  const f = await fixture(2);
  const record = await staged.begin(f.req()); await f.receive(0); await f.receive(1); await staged.accept(f.req());
  const remote = new Map(); let generated = 0, failOnce = true;
  const drive = {
    createFolder: async () => 'folder', generateFileId: async () => `generated-${++generated}`,
    uploadFile: async (name, buffer, type, folder, stop, options) => {
      if (!remote.has(options.id)) remote.set(options.id, { id: options.id, link: 'https://example.test/file' });
      if (name === 'test-1.txt' && failOnce) { failOnce = false; throw new Error('Connection lost after remote write'); }
      return remote.get(options.id);
    },
    getDownloadLink: id => `https://example.test/${id}`, deleteFile: async () => {},
  };
  await runOnce({ drive });
  assert.equal((await Submission.findById(record._id)).delivery, 'queued');
  assert.equal(await File.countDocuments({ submissionId: record._id }), 2);
  // Simulate a different worker reclaiming an expired lease.
  await Submission.updateOne({ _id: record._id }, { $set: { delivery: 'running', workerToken: 'old-worker', leaseUntil: new Date(0) } });
  await runOnce({ drive });
  assert.equal((await Submission.findById(record._id)).delivery, 'complete');
  assert.equal((await Request.findOne({ updatePlanId: f.orderId })).deliveryStatus, 'ready');
  assert.equal(remote.size, 2);
  assert.equal(generated, 2);
  assert.equal(await File.countDocuments({ submissionId: record._id }), 0);
  assert.equal((await Submission.findById(record._id)).reservedBytes, 0);
  assert.equal((await Order.findById(f.orderId)).serviceAccessUsedInCycle, 1);
});

test('expiration frees staging exactly once and disabled worker refuses new sessions', async () => {
  const f = await fixture(1);
  const record = await staged.begin(f.req()); await f.receive(0);
  const before = (await Budget.findById(staged.BUDGET_ID)).usedBytes;
  await Submission.updateOne({ _id: record._id }, { $set: { expiresAt: new Date(0) } });
  await staged.expireOne(); await staged.expireOne();
  assert.equal((await Budget.findById(staged.BUDGET_ID)).usedBytes, before - f.manifest.files[0].size);
  assert.equal(await File.countDocuments({ submissionId: record._id }), 0);
  process.env.ENABLE_UPLOAD_WORKER = 'false';
  await assert.rejects(staged.begin((await fixture(1)).req()), /temporarily unavailable/);
  process.env.ENABLE_UPLOAD_WORKER = 'true';
});

test('capacity reservation rejects uploads before any file bytes are accepted', async () => {
  const f = await fixture(1);
  const used = (await Budget.findById(staged.BUDGET_ID)).usedBytes;
  process.env.UPLOAD_STAGING_MAX_BYTES = String(used + 1);
  await assert.rejects(staged.begin(f.req()), error => error.status === 507);
  assert.equal(await Submission.countDocuments({ uploadId: f.uploadId }), 0);
  process.env.UPLOAD_STAGING_MAX_BYTES = String(64 * 1024 * 1024);
});

test('external staged HTTP receipt spends a single-use link once and respects revocation before buffering', async () => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const User = require('../models/userModel');
  const external = require('../controller/user/externalUploadController');
  const controller = require('../controller/user/stagedUploadController');
  const notifications = require('../helpers/uploadNotifications');
  const { issueExternalUploadSession, SESSION_STAGE, AUTH_MODE } = require('../helpers/externalUploadSession');
  const previousSecret = process.env.EXTERNAL_UPLOAD_TOKEN_SECRET;
  process.env.EXTERNAL_UPLOAD_TOKEN_SECRET = 'local-staged-test-secret-more-than-32-characters';
  const originalNotify = notifications.notifyUpload;
  let notified = 0, parsed = 0;
  notifications.notifyUpload = async () => { notified++; };
  const f = await fixture(1);
  await User.collection.insertOne({ _id:f.ownerId, isActive:true, isGuest:false, deletedAt:null, allowLoginFreeUploadLinks:true });
  const linkId = new mongoose.Types.ObjectId();
  await Link.collection.insertOne({ _id:linkId, customerId:f.ownerId, orderId:f.orderId, status:'active', mode:'single', tokenDigest:randomUUID(), useCount:0, reservationId:null });
  let cookie;
  issueExternalUploadSession({res:{cookie(name,value){cookie=name+'='+value;}},linkId,customerId:f.ownerId,orderId:f.orderId,stage:SESSION_STAGE.ACCESS,authMode:AUTH_MODE.LINK});
  const app = express();
  app.use(cookieParser(),express.json());
  app.post('/uploads',external.requireAccess,external.reserveSingleUse,controller.begin);
  app.get('/uploads/:uploadId',external.requireAccess,controller.status);
  app.post('/uploads/:uploadId/files/:fileId',external.requireAccess,controller.authorizeFile,(req,res,next)=>{parsed++;next();},controller.parseFile,controller.receive);
  app.post('/uploads/:uploadId/complete',external.requireAccess,controller.complete);
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base = 'http://127.0.0.1:'+server.address().port+'/uploads';
  try {
    const start = await fetch(base+'?uploadId='+f.uploadId,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({...f.manifest,planId:String(new mongoose.Types.ObjectId())})});
    assert.equal(start.status,200,JSON.stringify(await start.json()));
    const send = async fileId => {
      const form = new FormData();
      form.append('file',new Blob([Buffer.from('file-0')],{type:'text/plain'}),'test-0.txt');
      return fetch(base+'/'+f.uploadId+'/files/'+fileId,{method:'POST',headers:{cookie},body:form});
    };
    assert.equal((await send(randomUUID())).status,404);
    assert.equal(parsed,0,'Unknown file rejected before multipart parse');
    assert.equal((await send(f.manifest.files[0].id)).status,200);
    const first = await fetch(base+'/'+f.uploadId+'/complete',{method:'POST',headers:{cookie}});
    const result = await first.json();
    assert.equal(first.status,200,JSON.stringify(result));
    const replay = await fetch(base+'/'+f.uploadId+'/complete',{method:'POST',headers:{cookie}});
    assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),result);
    assert.equal((await Link.findById(linkId)).useCount,1);
    assert.equal((await Order.findById(f.orderId)).serviceAccessUsedInCycle,1);
    assert.equal(notified,1);
    assert.equal((await Request.findById(result.data.requestId)).deliveryStatus,'queued');
    assert.equal((await fetch(base+'/'+f.uploadId,{headers:{cookie}})).status,200);
    await Link.updateOne({_id:linkId},{$set:{status:'revoked'}});
    const beforeParsed = parsed;
    assert.equal((await send(f.manifest.files[0].id)).status,401);
    assert.equal(parsed,beforeParsed);
    assert.equal((await fetch(base+'/'+f.uploadId,{headers:{cookie}})).status,401);
  } finally {
    notifications.notifyUpload = originalNotify;
    if (previousSecret === undefined) delete process.env.EXTERNAL_UPLOAD_TOKEN_SECRET; else process.env.EXTERNAL_UPLOAD_TOKEN_SECRET = previousSecret;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

test('Drive retry reuses the preallocated ID only after hash and size match', async () => {
  const Drive = require('../helpers/googleDriveService');
  const drive = Object.create(Drive.prototype);
  let permissions = 0, deleted = 0;
  drive.driveClient = {
    files: {
      create:async ({resource})=>{assert.equal(resource.id,'stable-drive-id');assert.equal(resource.appProperties.uploadSha256,'expected');throw Object.assign(new Error('Already created'),{code:409});},
      get:async ()=>({data:{id:'stable-drive-id',name:'file.txt',size:'3',appProperties:{uploadSha256:'expected'},webViewLink:'https://example.test/file'}}),
      delete:async ()=>{deleted++;},
    },
    permissions:{create:async ()=>{permissions++;}},
  };
  const options = {id:'stable-drive-id',sha256:'expected',retainOnError:true};
  assert.equal((await drive.uploadFileNow('file.txt',Buffer.from('abc'),'text/plain','folder',options)).id,'stable-drive-id');
  assert.equal(permissions,1);
  await assert.rejects(drive.uploadFileNow('file.txt',Buffer.from('abcd'),'text/plain','folder',options),/does not match/);
  assert.equal(permissions,1);
  drive.driveClient.permissions.create = async ()=>{throw new Error('Permission unavailable');};
  await assert.rejects(drive.uploadFileNow('file.txt',Buffer.from('abc'),'text/plain','folder',options),/Permission unavailable/);
  assert.equal(deleted,0,'Keep the tracked ID so worker recovery cannot create a duplicate');
});
