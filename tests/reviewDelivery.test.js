const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { EmailDraft, EmailTemplate, EmailHistory, EmailPolicy } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { requestMiddleware, queueMail } = require('../helpers/emailController');
let db, server, base, admin, customer, providerCalls, providerFails;
const nativeFetch = global.fetch;
const textDoc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const nameDoc = () => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dear ' }, { type: 'emailVariable', attrs: { key: 'name' } }, { type: 'text', text: ', updated wording' }] }] });
before(async () => {
  process.env.TOKEN_SECRET_KEY = 'review-channel-isolated-secret';
  process.env.RESEND_API_KEY = 'test'; process.env.FROM_EMAIL = 'sender@example.test';
  db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri(), { dbName: 'review-channel-tests' });
  await Queue.init();
  [admin, customer] = await User.create([{ name: 'Admin', email: 'admin@example.test', roles: ['admin'] }, { name: 'Ravi', email: 'ravi@example.test', phone: '9876543210', roles: ['customer'] }]);
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    providerCalls.push({ key: options.headers['Idempotency-Key'], payload: JSON.parse(options.body) });
    return new Response(JSON.stringify(providerFails ? { message: 'failed' } : { id: 'provider-accepted' }), { status: providerFails ? 503 : 200 });
  };
  const app = express(); app.use(express.json()); app.use(require('cookie-parser')()); app.use(requestMiddleware);
  app.use('/email-control', require('../routes/emailControl'));
  app.post('/action', require('../middleware/authToken'), async (req, res) => {
    await queueMail('lead.proposal', { to: ['ravi@example.test'], values: { name: 'Ravi', amount: '₹500', link: 'https://example.test/proposal' }, requiredLinks: ['https://example.test/proposal'] });
    res.json({ success: true });
  });
  app.post('/lead', require('../middleware/authToken'), require('../controller/lead/createLead'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true'; providerCalls = []; providerFails = false;
  await Promise.all([EmailDraft, EmailTemplate, EmailHistory, EmailPolicy, Queue, Lead].map(model => model.deleteMany({})));
});
after(async () => { global.fetch = nativeFetch; if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });
async function api(path, method = 'GET', body, user = admin) {
  const response = await nativeFetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Cookie: `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
async function draft() {
  const result = await api('/action', 'POST', {});
  return (await api(`/email-control/drafts/${result.emailDraftIds[0]}`)).data;
}
const decision = (draft, channels) => ({ choice: 'send', channels, subject: draft.subject, subjectDoc: draft.templateSubjectDoc, doc: draft.templateDoc || draft.doc, templateId: draft.selectedTemplateId });
test('review exposes original dynamic fields while preview fills actual recipient; saves selected ID with conflict protection', async () => {
  const row = await draft();
  assert.ok(JSON.stringify(row.templateDoc).includes('emailVariable'));
  assert.ok(!JSON.stringify(row.templateDoc).includes('Ravi'));
  assert.ok(row.html.includes('Ravi'));
  const before = await EmailTemplate.countDocuments();
  const save = await api(`/email-control/templates/${row.selectedTemplateId}`, 'PUT', { name: row.templateLabel, doc: nameDoc(), subjectDoc: row.templateSubjectDoc, expectedUpdatedAt: row.templateRevision });
  assert.equal(save.status, 200); assert.equal(String(save.data._id), row.selectedTemplateId);
  assert.equal(await EmailTemplate.countDocuments(), before);
  assert.ok(save.data.text.includes('{{name}}')); assert.ok(!save.data.text.includes('Ravi'));
  const reopened = (await api(`/email-control/drafts/${row._id}`)).data;
  assert.ok(reopened.templatePreviewHtml.includes('Ravi, updated wording'), 'original editor and customer preview use the same current template');
  assert.equal((await api(`/email-control/templates/${row.selectedTemplateId}`, 'PUT', { name: row.templateLabel, doc: nameDoc(), subjectDoc: row.templateSubjectDoc, expectedUpdatedAt: row.templateRevision })).status, 409);
  const next = await draft(); assert.ok(next.html.includes('Ravi, updated wording'));
});
test('email-only never queues WhatsApp; WhatsApp-only never calls email or increments email outbox', async () => {
  let row = await draft();
  let result = await api(`/email-control/drafts/${row._id}/decision`, 'POST', decision(row, 'email'));
  assert.equal(result.data.delivery.email, 'sent'); assert.equal(await Queue.countDocuments(), 0); assert.equal(providerCalls.length, 1);
  row = await draft();
  result = await api(`/email-control/drafts/${row._id}/decision`, 'POST', decision(row, 'whatsapp'));
  assert.equal(result.data.status, 'queued'); assert.equal(providerCalls.length, 1); assert.equal(await Queue.countDocuments(), 1);
  assert.equal((await EmailHistory.findOne({ draftId: row._id })).status, 'queued');
  assert.equal((await api('/email-control/outbox?application=portal')).data.summary.sent, 1);
});
test('Both queues once, duplicate decisions reuse frozen channels/content', async () => {
  const row = await draft(), payload = decision(row, 'both');
  const results = await Promise.all([api(`/email-control/drafts/${row._id}/decision`, 'POST', payload), api(`/email-control/drafts/${row._id}/decision`, 'POST', payload)]);
  assert.ok(results.some(result => result.data?.status === 'sent'));
  assert.equal(providerCalls.length, 1); assert.equal(await Queue.countDocuments(), 1);
  assert.equal((await api(`/email-control/drafts/${row._id}/decision`, 'POST', payload)).data.status, 'sent');
  assert.equal(providerCalls.length, 1); assert.equal(await Queue.countDocuments(), 1);
  assert.equal((await api(`/email-control/drafts/${row._id}/decision`, 'POST', decision(row, 'email'))).status, 409);
});
test('email succeeds, queue write fails: retry queues WhatsApp without sending email twice', async () => {
  const row = await draft(), payload = decision(row, 'both');
  const original = Queue.create;
  Queue.create = async () => { throw new Error('Queue unavailable'); };
  try {
    const first = await api(`/email-control/drafts/${row._id}/decision`, 'POST', payload);
    assert.equal(first.data.status, 'failed'); assert.equal(first.data.delivery.email, 'sent');
  } finally { Queue.create = original; }
  await api('/email-control?application=portal'); // Outbox repair must not hide unfinished channel delivery.
  assert.equal((await EmailDraft.findById(row._id)).status, 'failed');
  const retry = await api(`/email-control/drafts/${row._id}/decision`, 'POST', { ...payload, subject: 'Must not replace locked subject' });
  assert.equal(retry.data.status, 'sent'); assert.equal(providerCalls.length, 1); assert.equal(await Queue.countDocuments(), 1);
});
test('WhatsApp queues while email fails; retry completes email only, using the same provider key and payload', async () => {
  const row = await draft(), payload = decision(row, 'both'); providerFails = true;
  const first = await api(`/email-control/drafts/${row._id}/decision`, 'POST', payload);
  assert.equal(first.data.delivery.whatsapp, 'queued'); assert.equal(first.data.delivery.email, 'failed');
  providerFails = false;
  assert.equal((await api(`/email-control/drafts/${row._id}/decision`, 'POST', payload)).data.status, 'sent');
  assert.equal(await Queue.countDocuments(), 1); assert.equal(providerCalls.length, 2);
  assert.deepEqual(providerCalls[0], providerCalls[1]);
});
test('missing contact disables WhatsApp, tampered selection is rejected and Off remains authoritative', async () => {
  const row = await draft(); await User.updateOne({ _id: customer._id }, { phone: '' });
  const current = (await api(`/email-control/drafts/${row._id}`)).data;
  assert.equal(current.channelOptions.find(option => option.id === 'whatsapp').enabled, false);
  assert.equal((await api(`/email-control/drafts/${row._id}/decision`, 'POST', decision(row, 'whatsapp'))).status, 409);
  await EmailPolicy.create({ event: row.event, mode: 'off' });
  assert.equal((await api(`/email-control/drafts/${row._id}/decision`, 'POST', decision(row, 'email'))).status, 409);
  await User.updateOne({ _id: customer._id }, { phone: '9876543210' });
});
test('unsaved phone-only Add Lead previews original template, saves business record first and queues only on Send', async () => {
  const preview = (await api('/email-control/lead-preview', 'POST', { name: 'Neha', phone: '9876543211', email: '' })).data;
  assert.equal(preview.defaultChannel, 'whatsapp'); assert.ok(preview.templateDoc);
  assert.equal(await Queue.countDocuments(), 0);
  const created = await api('/lead', 'POST', { name: 'Neha', phone: '9876543211', email: '', emailReview: decision(preview, 'whatsapp') });
  assert.equal(created.success, true); assert.equal(await Lead.countDocuments({ name: 'Neha' }), 1);
  assert.equal(await Queue.countDocuments(), 1); assert.equal(providerCalls.length, 0);
  assert.match((await Queue.findOne()).text, /Neha/);
});
test('unsaved lead with email uses the form phone for availability, then sends Both only after successful save', async () => {
  const values = { name: 'New Customer', phone: '9876543219', email: 'new-customer@example.test' };
  const preview = (await api('/email-control/lead-preview', 'POST', values)).data;
  assert.equal(preview.channelOptions.find(row => row.id === 'both').enabled, true);
  assert.equal(await Queue.countDocuments(), 0);
  const created = await api('/lead', 'POST', { ...values, emailReview: decision(preview, 'both') });
  assert.equal(created.success, true); assert.equal(created.messageDelivery.email, 'sent'); assert.equal(created.messageDelivery.whatsapp, 'queued');
  assert.equal(providerCalls.length, 1); assert.equal(await Queue.countDocuments(), 1);
  assert.equal((await Queue.findOne()).to, '919876543219');
  const repeated = await api('/lead', 'POST', { ...values, emailReview: decision(preview, 'both') });
  assert.equal(repeated.success, false); assert.equal(providerCalls.length, 1); assert.equal(await Queue.countDocuments(), 1);
});
test('phone-only proposal reuses original templates and queues trusted recipient values once', async () => {
  const { whatsappPreview, queueProposalWhatsApp } = require('../helpers/leadProposalMessage');
  const lead = await Lead.create({ name: 'Phone Customer', phone: '9876543215' });
  const proposal = { version: 1, amount: 500, downloadLink: 'https://example.test/real-proposal' };
  const preview = await whatsappPreview(lead, proposal);
  assert.ok(preview.templateDoc); assert.equal(preview.defaultChannel, 'whatsapp');
  assert.equal(preview.channelOptions.find(row => row.id === 'email').enabled, false);
  const custom = await EmailTemplate.create({ event: 'lead.proposal', name: 'Short proposal', subject: 'Dear {{name}}', text: 'Hello {{name}}' });
  const selected = await api('/email-control/review-preview', 'POST', { event: 'lead.proposal', templateId: String(custom._id), values: { name: 'Preview only' } });
  assert.equal(selected.data.selectedTemplateId, String(custom._id));
  const payload = { channels: 'whatsapp', subjectDoc: selected.data.templateSubjectDoc, doc: selected.data.templateDoc };
  await queueProposalWhatsApp(lead, proposal, payload);
  await queueProposalWhatsApp(lead, proposal, payload);
  assert.equal(await Queue.countDocuments(), 1);
  const queued = await Queue.findOne();
  assert.match(queued.text, /Phone Customer/); assert.doesNotMatch(queued.text, /Preview only/);
  assert.ok(queued.text.includes(proposal.downloadLink)); assert.equal(providerCalls.length, 0);
});
test('original-template optional fields remain valid when the current draft has no value', async () => {
  const row = await draft();
  await EmailDraft.updateOne({ _id: row._id }, { $unset: { 'values.amount': 1 } });
  const current = (await api(`/email-control/drafts/${row._id}`)).data;
  assert.equal(current.editorFields.variables.find(field => field.key === 'amount').value, '');
  assert.equal((await api(`/email-control/drafts/${row._id}/preview`, 'POST', { subject: current.subject, subjectDoc: current.templateSubjectDoc, doc: current.templateDoc })).status, 200);
  assert.equal((await api(`/email-control/drafts/${row._id}/decision`, 'POST', decision(current, 'email'))).data.status, 'sent');
});
