const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Lead = require('../models/leadModel');
const Template = require('../models/messageTemplateModel');
const User = require('../models/userModel');
const { Queue, State, Lock } = require('../whatsapp/src/models.js');
const { Broadcast, BroadcastRecipient: Recipient, BroadcastGate } = require('../models/broadcastModel');
const { audience } = require('../helpers/broadcastAudience');
const { submit, saveTemplate, deleteTemplate, listTemplates } = require('../helpers/broadcastService');
const { dispatch, reconcile } = require('../helpers/broadcastJobs');
const { content, render, encode, decode } = require('../helpers/broadcastContent');
const { createSender } = require('../whatsapp/src/sender.js');
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const named = () => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dear ' }, { type: 'emailVariable', attrs: { key: 'name' } }, { type: 'text', text: ', hello!', marks: [{ type: 'bold' }] }] }] });
let db, server, base, admin, customer;
const send = (values = {}) => submit({ requestKey: 'test-request-key-0001', audience: 'Contacted', doc: named(), origin: 'new', ...values }, admin._id);
before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-broadcast-secret';
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = db.getUri();
  await mongoose.connect(db.getUri(), { dbName: 'broadcast-isolated' });
  await Promise.all([Queue.init(), Broadcast.init(), Recipient.init(), Template.init()]);
  [admin, customer] = await User.create([{ name: 'Admin', email: 'admin@example.test', roles: ['admin'] }, { name: 'Customer', email: 'customer@example.test', roles: ['customer'] }]);
  const app = express(); app.use(express.json()); app.use(require('cookie-parser')());
  app.use('/api/broadcast', require('../routes/broadcast'));
  app.use('/api/whatsapp-control', require('../routes/whatsappControl'));
  app.use('/legacy', (req, res, next) => { req.userRole = 'admin'; next(); });
  app.get('/legacy', require('../controller/admin/getMessageTemplates'));
  app.put('/legacy/:templateId', require('../controller/admin/updateMessageTemplate'));
  app.delete('/legacy/:templateId', require('../controller/admin/deleteMessageTemplate'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true'; process.env.BROADCAST_JOBS_ENABLED = 'true';
  await Promise.all([Lead, Template, Broadcast, Recipient, BroadcastGate, Queue, State, Lock].map(model => model.deleteMany({})));
  await Promise.all([require('../models/emailControlModel').EmailDraft.deleteMany({}), require('../models/emailControlModel').EmailHistory.deleteMany({}), require('../models/emailControlModel').EmailPolicy.deleteMany({})]);
  await State.create({ _id: 'main', connection: 'connected', heartbeatAt: new Date(), settings: { quietHours: false, jitterSec: 0, typing: false } });
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });
async function api(path, method = 'GET', body, user = admin) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Cookie: `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
test('stage groups ignore badges; proposal audience includes only badged Contacted/Positive; phone count is deduped', async () => {
  for (const status of ['Contacted', 'Positive', 'Negative', 'Won']) for (const badge of [false, true]) {
    await Lead.create({ name: `${status}-${badge}`, phone: `98765432${String(await Lead.countDocuments()).padStart(2, '0')}`, status, proposalSentAt: badge ? new Date() : null });
  }
  for (const status of ['Contacted', 'Positive', 'Negative', 'Won']) assert.equal((await audience(status)).count, 2);
  assert.equal((await audience('Proposal Sent')).count, 2);
  await Lead.create([{ name: 'Duplicate', phone: '+91 9876543200' }, { name: 'Bad', phone: '123' }, { name: 'Trash', phone: '9876543299', deletedAt: new Date() }]);
  const result = await audience('Contacted');
  assert.equal(result.count, 2); assert.deepEqual(result.excluded, { invalidPhone: 1, duplicatePhone: 1, noName: 0, doNotDisturb: 0 });
});

test('a name guessed from WhatsApp counts as no name: a message by name leaves the lead out', async () => {
  await Lead.create([{ name: 'Ravi', nameFromWhatsapp: true, phone: '9876543201', status: 'Inquiry' }, { name: 'Amit', phone: '9876543202', status: 'Inquiry' }]);
  const byName = await audience('Inquiry', { requireName: true });
  assert.deepEqual(byName.recipients.map((row) => row.name), ['Amit']);
  assert.equal(byName.excluded.noName, 1);
  const plain = await audience('Inquiry');
  assert.deepEqual(plain.recipients.map((row) => row.name).sort(), ['', 'Amit']);
});
test('codec round-trips formatting and field chips; values are literal; unsupported fields/structures are rejected', () => {
  const canonical = content(named());
  assert.deepEqual(decode(encode(canonical)), canonical);
  assert.equal(render(canonical, { name: 'Sandeep Singh' }), 'Dear Sandeep Singh*, hello!*');
  const literal = render(canonical, { name: '{{secret}} *Admin*' });
  assert.ok(literal.includes('{{secret}}')); assert.ok(!literal.includes('*Admin*'));
  const bad = named(); bad.content[0].content[1].attrs.key = 'secret';
  assert.throws(() => content(bad), /Unknown/);
  assert.throws(() => content({ type: 'doc', content: [{ type: 'heading', content: [] }] }), /Unsupported/);
  const formatted = named();
  formatted.content[0].content[1].marks = [{ type: 'italic' }];
  const html = render(content(formatted), { name: '<script>alert(1)</script>' }, { html: true });
  assert.ok(html.includes('<em>&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(render(content(formatted), { name: 'Sandeep' }).includes('_Sandeep_'));
});
test('concurrent duplicate submissions make one broadcast and one auto-template; changed payload rejects reused key', async () => {
  await Lead.create({ name: 'Sandeep', phone: '9876543210' });
  const responses = await Promise.all([send(), send(), send()]);
  assert.equal(new Set(responses.map(row => String(row.id))).size, 1);
  assert.equal(await Broadcast.countDocuments(), 1); assert.equal(await Template.countDocuments({ purpose: 'broadcast' }), 1);
  await assert.rejects(send({ doc: doc('Different') }), /already used/);
  assert.equal(await Queue.countDocuments(), 0, 'accepted is not queued or sent');
});
test('template reuse never auto-saves or overwrites; explicit CRUD is isolated from legacy routes', async () => {
  await Lead.create({ name: 'Lead', phone: '9876543210' });
  const saved = await saveTemplate({ doc: doc('Original') }, admin._id);
  await Template.create({ name: 'Legacy', message: 'Legacy text' });
  await send({ origin: 'template', templateId: String(saved._id), doc: doc('This send only') });
  assert.equal(await Template.countDocuments(), 2);
  assert.equal(render(decode((await Template.findById(saved._id)).message)), 'Original');
  assert.equal((await api('/legacy')).data.length, 1);
  assert.equal((await api(`/legacy/${saved._id}`, 'PUT', { message: 'Bad overwrite' })).status, 404);
  assert.equal((await api(`/legacy/${saved._id}`, 'DELETE')).status, 404);
  const legacy = await Template.findOne({ name: 'Legacy' });
  assert.equal((await api(`/api/broadcast/templates/${legacy._id}`, 'DELETE')).status, 404);
  await saveTemplate({ doc: doc('Explicit update'), name: 'Updated label' }, admin._id, String(saved._id));
  await deleteTemplate(String(saved._id));
  assert.equal(await Broadcast.countDocuments(), 1, 'history is independent');
  assert.equal(render(decode((await Broadcast.findOne()).message)), 'This send only');
});
test('real sender uses the existing queue and gap; three dispatchers release one recipient; service message goes first', async () => {
  await Lead.create([{ name: 'Sandeep', phone: '9876543210' }, { name: 'Neha', phone: '9876543211' }]);
  await send();
  await Promise.all([dispatch(), dispatch(), dispatch()]);
  assert.equal(await Queue.countDocuments({ status: 'pending' }), 1);
  assert.match((await Queue.findOne()).text, /Dear Sandeep/);
  let time = new Date(); const delivered = [];
  const sender = createSender({ Queue, State, config: { timeZone: 'Asia/Kolkata' }, now: () => time, random: () => 0, transport: { isConnected: () => true, resolve: async to => to, send: async (to, text) => { delivered.push([to, text]); return 'test-message'; } } });
  assert.equal((await sender.step()).reason, 'sent');
  await reconcile();
  assert.equal((await Recipient.findOne({ state: 'sent' })).phone, '919876543210');
  const { enqueueWhatsApp } = require('../helpers/whatsappQueue');
  await enqueueWhatsApp({ to: '919000000000', text: 'Service message' });
  assert.equal((await dispatch()).reason, 'service-first');
  assert.equal((await sender.step()).reason, 'gap');
  time = new Date(time.getTime() + 31000);
  assert.equal((await sender.step()).reason, 'sent');
  await dispatch();
  assert.equal(await Queue.countDocuments({ broadcastRecipientId: { $exists: true }, status: 'pending' }), 1);
  time = new Date(time.getTime() + 31000);
  assert.equal((await sender.step()).reason, 'sent');
  await dispatch();
  assert.equal((await Broadcast.findOne()).state, 'finished');
  assert.deepEqual(delivered.map(row => row[0]), ['919876543210', '919000000000', '919876543211']);
});
test('stage/phone changes cancel pending rows; off/pause/offline/quiet hours hold release', async () => {
  const lead = await Lead.create({ name: 'Lead', phone: '9876543210' });
  await send();
  await State.updateOne({ _id: 'main' }, { paused: true });
  assert.equal((await dispatch()).reason, 'paused'); assert.equal(await Queue.countDocuments(), 0);
  await State.updateOne({ _id: 'main' }, { paused: false, connection: 'disconnected' });
  assert.equal((await dispatch()).reason, 'offline');
  await State.updateOne({ _id: 'main' }, { connection: 'connected' });
  process.env.ENABLE_WHATSAPP = 'false'; assert.equal((await dispatch()).reason, 'off');
  process.env.ENABLE_WHATSAPP = 'true';
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  await State.updateOne({ _id: 'main' }, { settings: { quietHours: true, quietFrom: hour, quietTo: (hour + 1) % 24 } });
  assert.equal((await dispatch()).reason, 'quiet-hours');
  await State.updateOne({ _id: 'main' }, { settings: { quietHours: false } });
  await dispatch();
  await Lead.updateOne({ _id: lead._id }, { status: 'Negative' });
  await dispatch();
  assert.equal((await Queue.findOne()).status, 'cancelled');
  assert.equal((await Recipient.findOne()).state, 'cancelled');
});
test('releasing crash recovers the same queue row; terminal history survives queue deletion', async () => {
  await Lead.create({ name: 'Lead', phone: '9876543210' });
  await send(); await dispatch();
  const queued = await Queue.findOne();
  await Recipient.updateOne({ _id: queued._id }, { state: 'releasing', $unset: { queuedAt: 1 } });
  await dispatch();
  assert.equal(await Queue.countDocuments(), 1);
  await Queue.updateOne({ _id: queued._id }, { status: 'sent', sentAt: new Date() });
  await dispatch(); await Queue.deleteMany({}); await dispatch();
  assert.equal((await Recipient.findOne()).state, 'sent'); assert.equal(await Queue.countDocuments(), 0);
});
test('manual queue retry cannot bypass Broadcast release gating; recipient outcomes expose failure reasons', async () => {
  await Lead.create({ name: 'Lead', phone: '9876543210' });
  const accepted = await send(); await dispatch();
  const queued = await Queue.findOne();
  await Queue.updateOne({ _id: queued._id }, { status: 'failed', lastError: 'Not on WhatsApp.' });
  await dispatch();
  const listing = await api('/api/whatsapp-control/queue?status=failed');
  assert.equal(listing.data.rows[0].canRetry, false);
  assert.equal((await api(`/api/whatsapp-control/queue/${queued._id}/retry`, 'POST')).status, 409);
  const results = await api(`/api/broadcast/history/${accepted.id}/recipients`);
  assert.equal(results.data.rows[0].reason, 'Not on WhatsApp.');
  assert.equal(results.data.rows[0].state, 'failed');
});
test('new accepted operation recovers its auto-save after a crash before acceptance side effects', async () => {
  const lead = await Lead.create({ name: 'Lead', phone: '9876543210' });
  await Broadcast.create({ createdBy: admin._id, requestKey: 'crash-before-acceptance', fingerprint: 'test', audience: 'Contacted', message: encode(doc('Recovered')), origin: 'new' });
  await dispatch();
  assert.equal(await Template.countDocuments({ purpose: 'broadcast' }), 1);
  assert.equal(await Recipient.countDocuments({ leadId: lead._id }), 1);
  await dispatch(); assert.equal(await Template.countDocuments({ purpose: 'broadcast' }), 1);
});
test('routes require a current admin; preview uses the actual renderer', async () => {
  assert.equal((await api('/api/broadcast/audiences', 'GET', null, null)).status, 401);
  assert.equal((await api('/api/broadcast/audiences', 'GET', null, customer)).status, 403);
  const result = await api('/api/broadcast/preview', 'POST', { doc: named() });
  assert.equal(result.data.text, render(content(named()), { name: 'Sandeep Singh' }));
  assert.equal((await listTemplates()).length, 0);
});

const media = () => ({ id: String(new mongoose.Types.ObjectId()), url: 'https://res.cloudinary.com/test/video/upload/v1/clip.mp4', publicId: 'clip', assetId: 'immutable-asset', kind: 'video', bytes: 1000, format: 'mp4' });
const composed = extra => ({ version: 2, doc: doc('Separate text'), caption: doc('Caption'), media: media(), position: 'before', subject: 'News', ...extra });

test('canonical composition preserves media-only, field-only text and both orders without changing the old text codec', () => {
  const { composition, compositionParts, readComposition } = require('../helpers/broadcastContent');
  const value = composition(composed());
  assert.deepEqual(compositionParts(value, { name: 'A' }).map(part => !!part.media), [false, true]);
  assert.deepEqual(compositionParts({ ...value, position: 'after' }, {}).map(part => !!part.media), [true, false]);
  assert.equal(compositionParts(composition(composed({ doc: null, caption: null })), {}).length, 1);
  const onlyName = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'emailVariable', attrs: { key: 'name' } }] }] };
  assert.equal(compositionParts(composition({ doc: onlyName }), { name: 'Ravi' })[0].text, 'Ravi');
  assert.equal(readComposition(encode(doc('Old'))).version, 1);
  assert.throws(() => composition(composed({ media: { ...media(), bytes: 17 * 1024 * 1024 } })), /16 MB/);
});

test('SSOT catalog includes Reservation and blocked behaviours; lead-only excludes client project requests', async () => {
  const { CATALOG } = require('../helpers/broadcastAudience');
  assert.ok(CATALOG.some(row => row.id === 'leads:Reservation'));
  assert.ok(CATALOG.find(row => row.id === 'clients:Dead').blocked);
  await Lead.create([{ name: 'Lead', phone: '9876543210' }, { name: 'Request', phone: '9876543211', requestedByUserId: customer._id }]);
  assert.equal((await audience('leads:Contacted')).count, 1);
  const client = await Lead.create({ name: 'Client', phone: '9876543212', status: 'Won', convertedToUserId: customer._id });
  assert.equal((await audience('clients:Contacted')).count, 1);
  await Lead.updateOne({ _id: client._id }, { clientBehaviour: 'NotNow' });
  assert.equal((await audience('clients:Contacted')).count, 0);
  assert.equal((await audience('clients:NotNow')).count, 0);
  await User.updateOne({ _id: customer._id }, { deletedAt: new Date() });
  assert.equal((await audience('clients:Contacted')).count, 0);
  await User.updateOne({ _id: customer._id }, { $unset: { deletedAt: 1 } });
});

test('channel audiences include email-only people and dedupe each destination independently', async () => {
  await Lead.create([{ name: 'Email', email: 'one@example.test' }, { name: 'Both', phone: '9876543210', email: 'two@example.test' }, { name: 'Same', phone: '+91 9876543210', email: 'TWO@example.test' }]);
  assert.equal((await audience('leads:Contacted', { channel: 'email' })).count, 2);
  const both = await audience('leads:Contacted', { channel: 'both' });
  assert.equal(both.count, 3);
  assert.equal(both.recipients.filter(row => row.channel === 'email').length, 2);
});

test('media parts release through the original queue in order, preserve payload, and recheck immediately before handoff', async () => {
  const lead = await Lead.create({ name: 'Lead', phone: '9876543210' });
  await send(composed({ audience: 'leads:Contacted' }));
  await dispatch();
  assert.equal(await Recipient.countDocuments(), 2);
  assert.equal(await Queue.countDocuments(), 1);
  assert.equal((await Queue.findOne()).text, 'Separate text');
  const calls = [];
  const sender = createSender({ Queue, State, config: { timeZone: 'Asia/Kolkata' }, transport: { isConnected: () => true, resolve: async to => to, send: async (jid, text, typing, options) => { if (!await options.beforeSend()) throw Object.assign(new Error('Changed'), { code: 'FINAL_MESSAGE_CHANGED' }); calls.push({ text, media: options.media }); return `sent-${calls.length}`; } } });
  await sender.step(); await dispatch();
  assert.equal(await Queue.countDocuments(), 2);
  const queuedMedia = await Queue.findOne({ 'media.kind': 'video' });
  assert.equal(queuedMedia.text, 'Caption');
  await Lead.updateOne({ _id: lead._id }, { status: 'Positive' });
  await State.updateOne({ _id: 'main' }, { nextSendAt: new Date(0) });
  await sender.step();
  assert.equal((await Queue.findById(queuedMedia._id)).status, 'cancelled');
  assert.equal(calls.length, 1);
});

test('Both uses the existing email provider path once, without an extra WhatsApp copy; preference survives recovery', async () => {
  await Lead.create({ name: 'Lead', phone: '9876543210', email: 'lead@example.test' });
  const nativeFetch = global.fetch, mails = [];
  process.env.RESEND_API_KEY = 'isolated'; process.env.FROM_EMAIL = 'sender@example.test';
  global.fetch = async (url, options) => { assert.equal(url, 'https://api.resend.com/emails'); mails.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: 'email-1' })); };
  try {
    await send(composed({ channel: 'both', audience: 'leads:Contacted', media: null, caption: null }));
    await State.updateOne({ _id: 'main' }, { paused: true });
    await dispatch(); await dispatch();
    assert.equal(mails.length, 1);
    assert.equal(await Queue.countDocuments(), 0, 'WhatsApp still waits for its existing readiness gate');
    assert.equal(await Recipient.countDocuments({ channel: 'email', state: 'sent' }), 1);
    await State.updateOne({ _id: 'main' }, { paused: false }); await dispatch();
    assert.equal(await Queue.countDocuments(), 1, 'exactly one original Broadcast queue row');
    assert.equal(mails[0].subject, 'News');
    assert.equal((await require('../models/emailControlModel').EmailPolicy.findOne({ event: 'broadcast.manual' })).channel, 'both');
    await send(composed({ requestKey: 'another-request-key-0002', channel: 'email', media: null, caption: null }));
    assert.equal((await require('../models/emailControlModel').EmailPolicy.findOne({ event: 'broadcast.manual' })).channel, 'email');
  } finally { global.fetch = nativeFetch; }
});

test('signed library media is mandatory on routes; used assets cannot be retired and retired assets cannot be accepted', async () => {
  const asset = media();
  await Lead.create({ name: 'Lead', phone: '9876543210' });
  const payload = { ...composed({ media: asset }), audience: 'leads:Contacted', requestKey: 'media-route-key-0001', origin: 'new' };
  assert.equal((await api('/api/broadcast/send', 'POST', payload)).status, 400);
  const token = jwt.sign({ asset }, require('../helpers/broadcastMedia').key(), { issuer: 'merasoftware-website', audience: 'broadcast-media', expiresIn: '60s' });
  assert.equal((await api('/api/broadcast/send', 'POST', { ...payload, mediaToken: token })).status, 200);
  await assert.rejects(require('../helpers/broadcastMedia').retireMedia(asset.id), /used by/);
  const other = media();
  await require('../helpers/broadcastMedia').retireMedia(other.id);
  await assert.rejects(send(composed({ media: other, requestKey: 'retired-media-key-0001' })), /being used or removed/);
});


test('email failure retries only its locked email through Broadcast, with the same provider key and no duplicate WhatsApp', async () => {
  await Lead.create({ name: 'Lead', phone: '9876543210', email: 'lead@example.test' });
  const nativeFetch = global.fetch, keys = []; let fail = true;
  process.env.RESEND_API_KEY = 'isolated'; process.env.FROM_EMAIL = 'sender@example.test';
  global.fetch = async (url, options) => { assert.equal(url, 'https://api.resend.com/emails'); keys.push(options.headers['Idempotency-Key']); return new Response(JSON.stringify(fail ? { error: 'temporary' } : { id: 'retried-email' }), { status: fail ? 503 : 200 }); };
  try {
    const run = await send(composed({ channel: 'both', media: null, caption: null }));
    await dispatch();
    assert.equal(await Queue.countDocuments(), 1);
    const recipient = await Recipient.findOne({ channel: 'email' });
    assert.equal(recipient.state, 'failed');
    const draft = await require('../models/emailControlModel').EmailDraft.findById(recipient._id);
    await assert.rejects(require('../helpers/emailController').decide(String(draft._id), admin._id, { choice: 'send', channels: 'both', subject: draft.subject, text: draft.text }, { application: 'portal', portalAdmin: true }), /Manage this delivery from Broadcast/);
    fail = false;
    assert.equal((await require('../helpers/broadcastService').retryEmail(run.id)).count, 1);
    await dispatch(); await dispatch();
    assert.equal((await Recipient.findById(recipient._id)).state, 'sent');
    assert.equal(await Queue.countDocuments(), 1);
    assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
    assert.equal((await require('../helpers/broadcastService').retryEmail(run.id)).count, 0);
  } finally { global.fetch = nativeFetch; }
});

test('recipient index upgrade preserves existing queue identities and permits multiple message parts', async () => {
  await Recipient.collection.dropIndex('broadcastId_1_channel_1_phone_1_email_1_part_1');
  await Recipient.collection.createIndex({ broadcastId: 1, phone: 1 }, { unique: true });
  const id = new mongoose.Types.ObjectId(), run = new mongoose.Types.ObjectId(), lead = new mongoose.Types.ObjectId();
  await Recipient.collection.insertOne({ _id: id, broadcastId: run, leadId: lead, phone: '919876543210', state: 'sent' });
  await require('../helpers/broadcastJobs').upgradeRecipientIndex();
  const legacy = await Recipient.findById(id).lean();
  assert.equal(legacy.channel, 'whatsapp'); assert.equal(legacy.part, 0);
  await Recipient.create({ broadcastId: run, leadId: lead, phone: legacy.phone, part: 1, parts: 2 });
  assert.equal(await Recipient.countDocuments(), 2);
});


test('media without caption reaches the existing queue with an empty text field, and later text waits for its result', async () => {
  await Lead.create({ name: 'Lead', phone: '9876543210' });
  await send(composed({ caption: null, position: 'after' }));
  await dispatch();
  const first = await Queue.findOne();
  assert.equal(first.text, ''); assert.equal(first.media.kind, 'video');
  await dispatch(); assert.equal(await Queue.countDocuments(), 1);
  await Queue.updateOne({ _id: first._id }, { status: 'failed', lastError: 'Transport refused before handoff' });
  await dispatch();
  assert.equal(await Queue.countDocuments(), 1, 'text after a failed video is not sent');
  assert.equal(await Recipient.countDocuments({ state: 'cancelled', part: 1 }), 1);
});

test('website media retirement requires a request-bound assertion and blocks stale signed media after deletion begins', async () => {
  const asset = media();
  const nativeFetch = global.fetch;
  const body = { id: asset.id }, path = '/media/retire';
  const { signingKey, digest } = require('../helpers/websiteEmailAccess');
  const token = jwt.sign({ access: 'admin', method: 'POST', path, digest: digest(body) }, signingKey(), { issuer: 'merasoftware-website', audience: 'email-control', expiresIn: '60s' });
  const invoke = (values, assertion) => nativeFetch(base + '/api/broadcast' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(assertion ? { 'x-website-email-assertion': assertion } : {}) }, body: JSON.stringify(values) });
  assert.equal((await invoke(body)).status, 403);
  assert.equal((await invoke({ id: media().id }, token)).status, 400);
  assert.equal((await invoke(body, token)).status, 200);
  await assert.rejects(saveTemplate(composed({ media: asset }), admin._id), /being used or removed/);
});


test('an oversized personalized caption skips only that destination and does not wedge other broadcasts', async () => {
  await Lead.create({ name: 'A very long recipient name that exceeds the sample', phone: '9876543210' });
  const caption = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(1000) }, { type: 'emailVariable', attrs: { key: 'name' } }] }] };
  await send(composed({ caption }));
  await dispatch(); await dispatch();
  assert.equal(await Queue.countDocuments(), 0);
  assert.equal((await Recipient.findOne()).state, 'skipped');
  await send({ requestKey: 'valid-message-after-caption', doc: doc('Good message') });
  await dispatch();
  assert.equal(await Queue.countDocuments(), 1);
});


test('asset retirement waits for a media save transaction, then sees its committed reference', async () => {
  const asset = media(), { withMediaLock, retireMedia } = require('../helpers/broadcastMedia');
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const saving = withMediaLock(asset.id, async session => {
    await Template.create([{ name: 'Pinned media', purpose: 'broadcast', message: JSON.stringify(require('../helpers/broadcastContent').composition(composed({ media: asset }))), createdBy: admin._id }], { session });
    entered(); await gate;
  });
  await ready;
  let retired = false;
  const deletion = retireMedia(asset.id).then(() => { retired = true; }, error => error);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(retired, false);
  release(); await saving;
  assert.match((await deletion).message, /used by/);
  assert.equal(await Template.countDocuments({ name: 'Pinned media' }), 1);
});

test('a rolled-back media save leaves no template/broadcast/preference and does not prevent deletion', async () => {
  const asset = media(), { withMediaLock, retireMedia } = require('../helpers/broadcastMedia');
  await assert.rejects(withMediaLock(asset.id, async session => {
    await Template.create([{ name: 'Rolled back', purpose: 'broadcast', message: JSON.stringify(require('../helpers/broadcastContent').composition(composed({ media: asset }))), createdBy: admin._id }], { session });
    throw new Error('Process failed before commit');
  }), /before commit/);
  assert.equal(await Template.countDocuments({ name: 'Rolled back' }), 0);
  assert.equal(await Broadcast.countDocuments(), 0);
  assert.equal((await retireMedia(asset.id)).retired, true);
  await assert.rejects(saveTemplate(composed({ media: asset }), admin._id), /being used or removed/);
});

test('a retiring transaction prevents a stale media save from committing even when its work resumes later', async () => {
  const asset = media(), { withMediaLock } = require('../helpers/broadcastMedia');
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const deleting = withMediaLock(asset.id, async (session, retire) => { await retire(); entered(); await gate; });
  await ready;
  const saving = saveTemplate(composed({ media: asset }), admin._id).catch(error => error);
  release(); await deleting;
  assert.match((await saving).message, /being used or removed/);
  assert.equal(await Template.countDocuments(), 0);
});

test('an accepted email audit repairs an interrupted draft without contacting the provider again', async () => {
  await Lead.create({ name: 'Email lead', email: 'email@example.test' });
  const nativeFetch = global.fetch;
  process.env.RESEND_API_KEY = 'isolated'; process.env.FROM_EMAIL = 'sender@example.test';
  global.fetch = async () => new Response(JSON.stringify({ error: 'temporary' }), { status: 503 });
  try {
    await send(composed({ channel: 'email', media: null, caption: null })); await dispatch();
    const recipient = await Recipient.findOne({ channel: 'email' });
    const { EmailDraft, EmailHistory } = require('../models/emailControlModel');
    const sentAt = new Date();
    await EmailDraft.updateOne({ _id: recipient._id }, { status: 'sending' });
    await EmailHistory.updateOne({ draftId: recipient._id }, { status: 'sent', providerId: 'accepted-before-restart', sentAt });
    await Recipient.updateOne({ _id: recipient._id }, { state: 'releasing' });
    global.fetch = async () => { throw new Error('Provider must not be called twice'); };
    await dispatch();
    const recovered = await Recipient.findById(recipient._id);
    assert.equal(recovered.state, 'sent'); assert.equal(+recovered.sentAt, +sentAt);
    assert.equal(await Queue.countDocuments(), 0);
  } finally { global.fetch = nativeFetch; }
});

test('a queued email retry is refused at release if its provider dedupe window expired while waiting', async () => {
  await Lead.create({ name: 'Email lead', email: 'email@example.test' });
  const nativeFetch = global.fetch; let calls = 0;
  process.env.RESEND_API_KEY = 'isolated'; process.env.FROM_EMAIL = 'sender@example.test';
  global.fetch = async () => { calls++; return new Response(JSON.stringify({ error: 'temporary' }), { status: 503 }); };
  try {
    const run = await send(composed({ channel: 'email', media: null, caption: null })); await dispatch();
    assert.equal((await require('../helpers/broadcastService').retryEmail(run.id)).count, 1);
    const recipient = await Recipient.findOne({ channel: 'email' });
    await require('../models/emailControlModel').EmailDraft.collection.updateOne({ _id: recipient._id }, { $set: { createdAt: new Date(Date.now() - 24 * 3600000) } });
    await dispatch();
    assert.equal(calls, 1);
    assert.equal((await Recipient.findById(recipient._id)).state, 'failed');
    assert.match((await Recipient.findById(recipient._id)).reason, /retry window ended/);
  } finally { global.fetch = nativeFetch; }
});

test('signed image/video broadcasts pass through the actual dispatcher, sender and connection transport in both orders', async () => {
  const { createConnection } = require('../whatsapp/src/whatsapp.js');
  const { Auth } = require('../whatsapp/src/models.js');
  await Lead.create({ name: 'Lead', phone: '9876543210' });
  const handlers = {}, payloads = [];
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, child() { return this; } };
  // Only the socket is fake: there is no live phone connection in this test.
  const socket = { ev: { on: (event, fn) => { handlers[event] = fn; } }, onWhatsApp: async to => [{ exists: true, jid: `${to}@s.whatsapp.net` }], end() {}, sendMessage: async (jid, payload) => { payloads.push(payload); return { key: { id: `sent-${payloads.length}` } }; } };
  const connection = createConnection({ Auth, State, logger, makeSocket: () => { opened(); return socket; }, fetchVersion: async () => null });
  connection.start(); await ready; await handlers['connection.update']({ connection: 'open' });
  let time = new Date();
  const sender = createSender({ Queue, State, config: { timeZone: 'Asia/Kolkata' }, transport: connection.transport, now: () => time, random: () => 0 });
  try {
    for (const kind of ['image', 'video']) for (const position of ['before', 'after']) {
      const asset = { ...media(), kind, format: kind === 'image' ? 'png' : 'mp4', url: `https://res.cloudinary.com/test/${kind}/upload/v1/asset.${kind === 'image' ? 'png' : 'mp4'}` };
      const token = jwt.sign({ asset }, require('../helpers/broadcastMedia').key(), { issuer: 'merasoftware-website', audience: 'broadcast-media', expiresIn: '60s' });
      const result = await api('/api/broadcast/send', 'POST', { ...composed({ media: asset, position }), mediaToken: token, audience: 'leads:Contacted', origin: 'new', requestKey: `transport-${kind}-${position}` });
      assert.equal(result.status, 200);
      const start = payloads.length;
      await State.updateOne({ _id: 'main' }, { nextSendAt: new Date(0) });
      await dispatch();
      time = new Date(Math.max(time.getTime(), Date.now()) + 1000);
      assert.equal((await sender.step()).reason, 'sent');
      time = new Date(time.getTime() + 40000);
      await dispatch(); await sender.step(); await reconcile();
      const delivered = payloads.slice(start);
      assert.equal(delivered.length, 2);
      const mediaPayload = delivered[position === 'before' ? 1 : 0];
      assert.deepEqual(mediaPayload[kind], { url: asset.url }); assert.equal(mediaPayload.caption, 'Caption');
      assert.equal(delivered[position === 'before' ? 0 : 1].text, 'Separate text');
      assert.equal(await Recipient.countDocuments({ broadcastId: result.data.id, state: 'sent' }), 2);
    }
  } finally { await connection.stop(); }
});

test('media acceptance rolls back its run, auto-template and preference together when acceptance fails', async () => {
  await Lead.create({ name: 'Lead', phone: '9876543210' });
  const asset = media(), { EmailPolicy } = require('../models/emailControlModel');
  const original = EmailPolicy.updateOne;
  EmailPolicy.updateOne = () => { throw new Error('Injected preference write failure'); };
  try { await assert.rejects(send(composed({ media: asset })), /preference write failure/); }
  finally { EmailPolicy.updateOne = original; }
  assert.equal(await Broadcast.countDocuments(), 0);
  assert.equal(await Template.countDocuments(), 0);
  assert.equal(await EmailPolicy.countDocuments(), 0);
  assert.equal((await require('../helpers/broadcastMedia').retireMedia(asset.id)).retired, true);
});

test('concurrent media sends on different assets share channel preference without losing either acceptance', async () => {
  await Lead.create({ name: 'Lead', phone: '9876543210' });
  const accepted = await Promise.all([
    send(composed({ requestKey: 'parallel-media-accept-0001' })),
    send(composed({ requestKey: 'parallel-media-accept-0002' })),
  ]);
  assert.equal(accepted.length, 2);
  assert.equal(await Broadcast.countDocuments(), 2);
  assert.equal(await Template.countDocuments(), 2);
  assert.equal(await require('../models/emailControlModel').EmailPolicy.countDocuments({ event: 'broadcast.manual' }), 1);
});
