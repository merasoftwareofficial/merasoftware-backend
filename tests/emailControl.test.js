const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { requestMiddleware, queueMail, plainText, render } = require('../helpers/emailController');
const { EmailDraft, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const userModel = require('../models/userModel');
const authToken = require('../middleware/authToken');
const nativeFetch = global.fetch;
let db, server, base, admin, customer, secondAdmin, calls;
let providerFails = false;
const cookie = user => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function api(path, user = admin, body, method = 'POST') {
  const response = await nativeFetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Cookie: cookie(user) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
async function draft() {
  const result = await api('/action', admin, {});
  assert.equal(result.emailStatus, 'awaiting-review');
  return result.emailDraftIds[0];
}
before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-email-test-secret';
  process.env.RESEND_API_KEY = 'not-a-real-provider-key';
  process.env.FROM_EMAIL = 'sender@example.test';
  db = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  await mongoose.connect(db.getUri(), { dbName: 'email-control-isolated-test' });
  [admin, customer, secondAdmin] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
    { name: 'Admin 2', email: 'admin2@example.test', roles: ['admin'] },
  ]);
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails', 'Only the provider is mocked');
    calls.push({ payload: JSON.parse(options.body), key: options.headers['Idempotency-Key'] });
    return new Response(JSON.stringify(providerFails ? { message: 'refused' } : { id: 'provider-id' }), { status: providerFails ? 503 : 200 });
  };
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use(requestMiddleware);
  app.use('/email-control', require('../routes/emailControl'));
  app.post('/lead', authToken, require('../controller/lead/createLead'));
  app.post('/action', authToken, async (req, res) => {
    await queueMail('invoice.project', { reminderInvoice: req.body.reminderInvoice, to: ['client@example.test'], subject: 'Invoice', html: '<p>Original <a href="https://example.test/invoice">invoice</a></p>', attachments: [{ filename: 'invoice.pdf', content: Buffer.from('test-pdf') }] });
    res.status(req.body.fail ? 400 : 200).json({ success: !req.body.fail });
  });
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { calls = []; providerFails = false; await Promise.all([EmailDraft.deleteMany({}), EmailPolicy.deleteMany({}), EmailTemplate.deleteMany({})]); });
after(async () => { global.fetch = nativeFetch; if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });

test('cron and legacy mail builders cannot send or create review drafts', async () => {
  assert.equal((await queueMail('invoice.project', { to: ['x@example.test'] })).suppressed, true);
  const legacy = require('../helpers/emailService');
  for (const [key, builder] of Object.entries(legacy)) if (key.startsWith('send')) assert.equal(await builder(), false, key);
  assert.equal(await require('../helpers/otpUtils').sendOTPEmail('x@example.test', '123456'), false);
  assert.equal(calls.length, 0); assert.equal(await EmailDraft.countDocuments(), 0);
});
test('successful action stages a review with preserved recipient, links and attachment', async () => {
  const id = await draft(); const result = await api(`/email-control/drafts/${id}`, admin, null, 'GET');
  assert.equal(result.data.status, 'pending'); assert.deepEqual(result.data.to, ['client@example.test']);
  assert.match(result.data.text, /https:\/\/example.test\/invoice/);
  assert.equal(result.data.attachments[0].filename, 'invoice.pdf');
  assert.equal(result.data.attachments[0].content, undefined); assert.equal(calls.length, 0);
});
test('failed business action leaves no sendable draft', async () => {
  const result = await api('/action', admin, { fail: true });
  assert.equal(result.status, 400); assert.equal(await EmailDraft.countDocuments(), 0); assert.equal(calls.length, 0);
});
test('settings require admin and draft decisions belong to the action user', async () => {
  assert.equal((await api('/email-control', null, null, 'GET')).status, 401);
  assert.equal((await api('/email-control', customer, null, 'GET')).status, 403);
  const result = await api('/action', customer, {}); assert.equal(result.emailDraftIds.length, 1);
  const own = await api(`/email-control/drafts/${result.emailDraftIds[0]}`, customer, null, 'GET'); assert.equal(own.success, true);
  assert.equal((await api(`/email-control/drafts/${result.emailDraftIds[0]}/decision`, customer, { choice: 'skip' })).success, true);
  const id = await draft(); assert.equal((await api(`/email-control/drafts/${id}`, secondAdmin, null, 'GET')).status, 400);
  assert.equal(calls.length, 0);
});
test('Off blocks new drafts and previously prepared mail', async () => {
  const id = await draft();
  await api('/email-control/policies/invoice.project', admin, { mode: 'off' }, 'PUT');
  const result = await api('/action', admin, {}); assert.equal(result.emailDraftIds, undefined);
  const decision = await api(`/email-control/drafts/${id}/decision`, admin, { choice: 'send', subject: 'Invoice', text: 'Message' });
  assert.equal(decision.success, false); assert.equal(calls.length, 0);
});
test('Don’t Send is final and never contacts the provider', async () => {
  const id = await draft();
  assert.equal((await api(`/email-control/drafts/${id}/decision`, admin, { choice: 'skip' })).data.status, 'skipped');
  assert.equal((await api(`/email-control/drafts/${id}/decision`, admin, { choice: 'send', subject: 'X', text: 'Y' })).success, false);
  assert.equal(calls.length, 0);
});
test('Send uses reviewed content, escapes HTML and sends the PDF exactly once', async () => {
  const id = await draft(); const decision = { choice: 'send', subject: 'Edited invoice', text: 'Hello <script>alert(1)</script>' };
  const results = await Promise.all([api(`/email-control/drafts/${id}/decision`, admin, decision), api(`/email-control/drafts/${id}/decision`, admin, decision)]);
  assert.equal(results.filter(r => r.success).length, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.subject, decision.subject); assert.match(calls[0].payload.html, /&lt;script&gt;/);
  assert.equal(calls[0].payload.attachments[0].content, Buffer.from('test-pdf').toString('base64'));
  assert.equal((await EmailDraft.findById(id)).status, 'sent');
});
test('failed send retries keep the same idempotency key and content', async () => {
  const id = await draft(); providerFails = true;
  await api(`/email-control/drafts/${id}/decision`, admin, { choice: 'send', subject: 'First', text: 'Original decision' });
  assert.equal((await EmailDraft.findById(id)).status, 'failed'); providerFails = false;
  await api(`/email-control/drafts/${id}/decision`, admin, { choice: 'send', subject: 'Changed', text: 'Changed decision' });
  assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key); assert.deepEqual(calls[0].payload, calls[1].payload);
});
test('templates are action scoped and default selection is validated', async () => {
  const template = (await api('/email-control/templates', admin, { event: 'invoice.project', name: 'Friendly', subject: 'Your {{subject}}', text: 'Please review:\n{{message}}' })).data;
  assert.equal((await api('/email-control/policies/lead.created', admin, { mode: 'review', defaultTemplate: template._id }, 'PUT')).success, false);
  await api('/email-control/policies/invoice.project', admin, { mode: 'review', defaultTemplate: template._id }, 'PUT');
  const id = await draft(); const record = await EmailDraft.findById(id);
  assert.equal(record.subject, 'Your Invoice'); assert.match(record.text, /^Please review:/);
});
test('expired and malformed decisions cannot send', async () => {
  const id = await draft();
  assert.equal((await api(`/email-control/drafts/${id}/decision`, admin, { choice: 'send', subject: 'x\r\nbcc: x', text: 'x' })).success, false);
  await EmailDraft.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await api(`/email-control/drafts/${id}/decision`, admin, { choice: 'send', subject: 'x', text: 'x' })).success, false); assert.equal(calls.length, 0);
});
test('lead save honors Send and Don’t Send; duplicates never send', async () => {
  const review = { choice: 'send', subject: 'Welcome edited', text: 'Hello new lead' };
  const body = { name: 'New Lead', phone: '100001', email: 'lead@example.test', emailReview: review };
  const result = await api('/lead', admin, body); assert.equal(result.success, true); assert.equal(result.emailStatus, 'sent'); assert.equal(calls.length, 1);
  assert.equal((await api('/lead', admin, body)).status, 409); assert.equal(calls.length, 1);
  const skipped = await api('/lead', admin, { name: 'Skip Lead', phone: '100002', email: 'skip@example.test', emailReview: { choice: 'skip' } });
  assert.equal(skipped.success, true); assert.equal(calls.length, 1);
});
test('provider failure never reports lead save as failed', async () => {
  providerFails = true;
  const result = await api('/lead', admin, { name: 'Failed Mail Lead', phone: '100003', email: 'failed@example.test', emailReview: { choice: 'send', subject: 'Welcome', text: 'Hello' } });
  assert.equal(result.success, true); assert.equal(result.emailStatus, 'failed'); assert.equal(result.emailDraftIds.length, 1);
});
test('website intake prepares a central review and never sends', async () => {
  const result = await api('/email-control/website-drafts', admin, { event: 'website.subscription.confirm', to: ['reader@example.test'], subject: 'Confirm', text: 'Confirm at https://example.test/confirm' });
  assert.equal(result.data.sent, false); assert.equal(result.emailStatus, 'awaiting-review'); assert.equal(calls.length, 0);
  assert.equal((await api('/email-control/website-drafts', customer, { event: 'website.subscription.confirm' })).status, 403);
});
test('reminder counters change only on delivered mail and only once', async () => {
  const Invoice = require('../models/monthlyInvoiceModel');
  const invoice = await Invoice.collection.insertOne({ remindersSent: 0 });
  const create = async () => (await api('/action', admin, { reminderInvoice: String(invoice.insertedId) })).emailDraftIds[0];
  const skipped = await create();
  await api(`/email-control/drafts/${skipped}/decision`, admin, { choice: 'skip' });
  assert.equal((await Invoice.findById(invoice.insertedId)).remindersSent, 0);
  const id = await create(); const body = { choice: 'send', subject: 'Reminder', text: 'Please pay' };
  await api(`/email-control/drafts/${id}/decision`, admin, body);
  await api(`/email-control/drafts/${id}/decision`, admin, body);
  assert.equal((await Invoice.findById(invoice.insertedId)).remindersSent, 1);
});
test('text conversion retains links and template interpolation is literal', () => {
  assert.equal(plainText('<p>Hello <a href="https://example.test">open</a></p>'), 'Hello open (https://example.test)');
  assert.equal(render('Hi {{name}}', { name: '$& <name>' }), 'Hi $& <name>');
});
test('website assertions are bound to body and path and cannot use expired access', async () => {
  const { signingKey, digest } = require('../helpers/websiteEmailAccess');
  const route = '/policies/website.subscription.confirm?application=website';
  const body = { mode: 'off' };
  const assertion = (overrides = {}, expiresIn = 60) => jwt.sign({ access: 'admin', method: 'PUT', path: route, digest: digest(body), sub: String(customer._id), ...overrides }, signingKey(), { algorithm: 'HS256', audience: 'email-control', issuer: 'merasoftware-website', expiresIn });
  const send = async (token, payload = body, target = route) => nativeFetch(base + '/email-control' + target, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-website-email-assertion': token }, body: JSON.stringify(payload) });
  assert.equal((await send(assertion(), { mode: 'review' })).status, 401);
  assert.equal((await send(assertion(), body, '/policies/invoice.project?application=portal')).status, 401);
  assert.equal((await send(assertion({}, -1))).status, 401);
  assert.equal(await EmailPolicy.countDocuments(), 0);
  assert.equal((await send(assertion())).status, 200);
  assert.equal(calls.length, 0);
});
