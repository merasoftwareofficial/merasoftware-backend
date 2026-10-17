const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const multer = require('../middleware/uploadFiles');
const { createUploadTiming, uploadTimingMiddleware, measureUpload } = require('../helpers/uploadTiming');

function loadWithStubs(relative, stubs) {
  const filename = path.resolve(__dirname, '..', relative);
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, process,
    console: { log() {}, error() {} },
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : nativeRequire(name),
  }, { filename });
  return module.exports;
}

test('stage timings use a monotonic clock and preserve failed operations', async () => {
  let clock = 0;
  let record;
  const timing = createUploadTiming({ now: () => clock, emit: value => { record = value; } });
  const result = await timing.measure('save', async () => { clock += 12; return 'saved'; });
  assert.equal(result, 'saved');
  const error = new Error('private failure text');
  await assert.rejects(timing.measure('drive_file_upload', async () => { clock += 8; throw error; }), value => value === error);
  timing.finish({ status: 500 });
  assert.equal(record.totalMs, 20);
  assert.deepEqual(record.events.map(event => [event.durationMs, event.ok]), [[12, true], [8, false]]);
  assert.ok(!JSON.stringify(record).includes('private failure text'));
  assert.equal(await measureUpload(null, 'save', () => Promise.resolve(7)), 7);
});

test('disabled diagnostics leave non-upload and upload requests untouched', () => {
  const original = process.env.UPLOAD_TIMING_ENABLED;
  try {
    delete process.env.UPLOAD_TIMING_ENABLED;
    let next = 0;
    const req = { method: 'POST', path: '/api/user-request-update' };
    uploadTimingMiddleware(req, {}, () => next++);
    assert.equal(req.uploadTiming, undefined);
    process.env.UPLOAD_TIMING_ENABLED = 'true';
    uploadTimingMiddleware({ method: 'GET', path: '/api/user-request-update' }, {}, () => next++);
    uploadTimingMiddleware({ method: 'POST', path: '/api/signin' }, {}, () => next++);
    assert.equal(next, 3);
  } finally {
    if (original === undefined) delete process.env.UPLOAD_TIMING_ENABLED;
    else process.env.UPLOAD_TIMING_ENABLED = original;
  }
});

test('aborted connections produce one diagnostic without waiting for a response', () => {
  const original = process.env.UPLOAD_TIMING_ENABLED;
  const originalInfo = console.info;
  const records = [];
  try {
    process.env.UPLOAD_TIMING_ENABLED = 'true';
    console.info = (prefix, value) => records.push(JSON.parse(value));
    const req = Object.assign(new EventEmitter(), { method: 'POST', path: '/api/external-upload/submit' });
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader() {} });
    uploadTimingMiddleware(req, res, () => {});
    res.emit('close');
    res.emit('finish');
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'connection_closed');
    assert.equal(records[0].surface, 'external');
  } finally {
    console.info = originalInfo;
    if (original === undefined) delete process.env.UPLOAD_TIMING_ENABLED;
    else process.env.UPLOAD_TIMING_ENABLED = original;
  }
});

// Real middleware, multipart parser, controller and Drive service; only external
// Drive/database/email dependencies are replaced. No credentials or live writes.
test('multipart upload reports each real controller/Drive stage and keeps response semantics', async t => {
  const original = process.env.UPLOAD_TIMING_ENABLED;
  const originalInfo = console.info;
  const records = [];
  const deleted = [];
  let permissionFailure = false;
  let fileNumber = 0;
  let saves = 0;
  let permissionCalls = 0;
  const fakeDrive = {
    files: {
      list: async () => ({ data: { files: [{ id: 'folder' }] } }),
      create: async ({ resource, media }) => {
        // Consume the actual file stream to exercise byte handling.
        let bytes = 0;
        for await (const chunk of media.body) bytes += chunk.length;
        assert.equal(bytes, 2048);
        return { data: { id: `file-${++fileNumber}`, name: resource.name, webViewLink: 'https://example.test/file' } };
      },
      delete: async ({ fileId }) => deleted.push(fileId),
    },
    permissions: { create: async () => { permissionCalls++; if (permissionFailure) throw new Error('permission denied'); } },
  };
  const Drive = loadWithStubs('helpers/googleDriveService.js', {
    googleapis: { google: { auth: { GoogleAuth: class {} }, drive: () => fakeDrive } },
  });
  class UpdateRequest {
    constructor(value) { Object.assign(this, value); this._id = 'request'; }
    async save() { saves++; }
    static findById() { return { populate() { return this; }, then(resolve) { return Promise.resolve({}).then(resolve); } }; }
  }
  const controller = loadWithStubs('controller/user/submitUpdateRequest.js', {
    '../../models/updateRequestModel': UpdateRequest,
    '../../models/orderProductModel': { findOne: () => ({ populate: async () => ({ isWebsiteProject: true, isActive: true }) }) },
    '../../models/adminSettingsModel': { getSettings: async () => ({ fileExpirationDays: 30 }) },
    '../../helpers/googleDriveService': Drive,
    '../../helpers/emailService': { sendUpdateRequestNotification: async () => {}, sendUserConfirmation: async () => {} },
    '../../helpers/notificationService': { createUpdateRequestNotification: async () => {} },
    '../../models/userModel': {},
    '../../helpers/projectUploadGate': { assertProjectAcceptsUpload: async () => null },
    '../../helpers/uploadOrderPolicy': { assertUploadOrder: async () => ({ isProjectUpload: true, isServiceUpload: false, isLegacyUpload: false }) },
    mongoose: { Types: { ObjectId: class { constructor(value) { this.value = value; } } } },
  });
  const app = express();
  app.use(uploadTimingMiddleware);
  app.post('/api/user-request-update', (req, res, next) => { req.userId = 'test-user'; next(); }, multer.any(), controller);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    process.env.UPLOAD_TIMING_ENABLED = 'true';
    console.info = (prefix, value) => { if (prefix === '[upload-timing]') records.push(JSON.parse(value)); };
    const url = `http://127.0.0.1:${server.address().port}/api/user-request-update`;
    const submit = async count => {
      const form = new FormData();
      form.set('planId', 'test-order');
      form.set('instructions', '[]');
      for (let index = 0; index < count; index++) form.append('files', new Blob([Buffer.alloc(2048)], { type: 'text/plain' }), `private-name-${index}.txt`);
      const response = await fetch(url, { method: 'POST', body: form });
      return { response, payload: await response.json() };
    };
    await t.test('success, byte counts, correlation and no sensitive timing fields', async () => {
      const { response, payload } = await submit(3);
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.updatesRemaining, null);
      assert.equal(saves, 1);
      const record = records.at(-1);
      assert.equal(record.id, response.headers.get('X-Upload-Timing-Id'));
      assert.equal(record.fileCount, 3);
      assert.equal(record.fileBytes, 6144);
      assert.equal(record.events.filter(event => event.stage === 'drive_file_upload').length, 3);
      assert.equal(record.events.filter(event => event.stage === 'drive_file_permission').length, 3);
      for (const stage of ['request_body_received', 'controller_entered', 'order_lookup', 'request_save', 'controller_response_ready']) {
        assert.ok(record.events.some(event => event.stage === stage), stage);
      }
      assert.ok(!JSON.stringify(record).includes('private-name'));
      assert.ok(!JSON.stringify(record).includes('test-user'));
    });
    await t.test('Drive permission failure is timed, cleanup runs, no extra DB save', async () => {
      permissionFailure = true;
      const { response, payload } = await submit(1);
      assert.equal(response.status, 500);
      assert.equal(payload.success, false);
      assert.equal(saves, 1);
      assert.equal(deleted.length, 1);
      assert.equal(records.at(-1).events.find(event => event.stage === 'drive_file_permission').ok, false);
    });
    assert.equal(permissionCalls, 4);
  } finally {
    console.info = originalInfo;
    if (original === undefined) delete process.env.UPLOAD_TIMING_ENABLED;
    else process.env.UPLOAD_TIMING_ENABLED = original;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
