const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { decide } = require('../helpers/emailController');
const { enqueueWhatsAppForEmail, normalizePhone, savedPhoneFor, messageText } = require('../helpers/whatsappQueue');
const { EmailDraft, EmailHistory } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');
const userModel = require('../models/userModel');
const leadModel = require('../models/leadModel');
const nativeFetch = global.fetch;
let db, providerFails;
const portalAdmin = { application: 'portal', portalAdmin: true };
const waitForRows = async (count, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 25))) {
    const rows = await Queue.find().sort({ email: 1 }).lean();
    if (rows.length >= count) return rows;
  }
  return Queue.find().sort({ email: 1 }).lean();
};
const pendingDraft = (to, extra = {}) => EmailDraft.create({
  event: 'invoice.project', application: 'portal', to, status: 'pending', subject: 'Payment reminder - Invoice #INV-7',
  text: 'Hello Ravi,\n\nYour invoice is pending.', plain: 'Hello Ravi,\n\nYour invoice is pending.',
  html: '<p>Hello Ravi</p>', expiresAt: new Date(Date.now() + 60 * 60_000), ...extra,
});
const send = draft => decide(String(draft._id), null, { choice: 'send', subject: draft.subject, text: draft.text }, portalAdmin);

before(async () => {
  process.env.RESEND_API_KEY = 'not-a-real-provider-key';
  process.env.FROM_EMAIL = 'sender@example.test';
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri(), { dbName: 'whatsapp-queue-isolated-test' });
  await Queue.init();
  global.fetch = async url => {
    assert.equal(url, 'https://api.resend.com/emails', 'Only the provider is mocked');
    return new Response(JSON.stringify(providerFails ? { message: 'refused' } : { id: 'provider-id' }), { status: providerFails ? 503 : 200 });
  };
});
beforeEach(async () => {
  providerFails = false;
  process.env.ENABLE_WHATSAPP = 'true';
  await Promise.all([Queue.deleteMany({}), EmailDraft.deleteMany({}), EmailHistory.deleteMany({}), userModel.deleteMany({}), leadModel.deleteMany({})]);
});
after(async () => { global.fetch = nativeFetch; await mongoose.disconnect(); await db?.stop(); });

test('phone numbers in every saved style become country code + number', () => {
  for (const raw of ['9876543210', ' 98765 43210 ', '98765-43210', '09876543210', '+91 98765 43210', '919876543210', '0091 9876543210', '+91-(98765)-43210']) {
    assert.equal(normalizePhone(raw), '919876543210', raw);
  }
  assert.equal(normalizePhone('+1 415 555 0123'), '14155550123');
  for (const raw of ['', null, '12345', '5876543210', 'call me', '98765432101', '+91 5876543210']) assert.equal(normalizePhone(raw), null, String(raw));
});

test('the phone comes from the user account (any letter case), else from the newest lead', async () => {
  await userModel.create({ name: 'Ravi', email: 'Ravi@Example.test', phone: '9876543210', roles: ['customer'] });
  assert.equal(await savedPhoneFor('ravi@example.test'), '9876543210');

  await leadModel.create({ name: 'Old lead', email: 'lead@example.test', phone: '9000000001' });
  await leadModel.create({ name: 'New lead', email: 'lead@example.test', phone: '9000000002' });
  assert.equal(await savedPhoneFor('LEAD@example.test'), '9000000002');

  await userModel.create({ name: 'No phone', email: 'nophone@example.test', roles: ['customer'] });
  await leadModel.create({ name: 'Lead', email: 'nophone@example.test', phone: '9000000003' });
  assert.equal(await savedPhoneFor('nophone@example.test'), '9000000003');
  assert.equal(await savedPhoneFor('nobody@example.test'), null);
});

test('the message is the email subject in bold, then the email text unchanged', () => {
  assert.equal(messageText({ subject: 'Payment *reminder*', plain: 'Hello\n\n- Item' }), '*Payment reminder*\n\nHello\n\n- Item');
  assert.equal(messageText({ subject: '', text: 'Only text' }), 'Only text');
});

test('a sent email queues one WhatsApp per recipient; without a usable phone the row is skipped with the reason', async () => {
  await userModel.create({ name: 'Ravi', email: 'ravi@example.test', phone: '+91 98765 43210', roles: ['customer'] });
  await userModel.create({ name: 'Bad', email: 'bad@example.test', phone: '12345', roles: ['customer'] });
  const draft = await pendingDraft(['ravi@example.test', 'bad@example.test', 'subscriber@example.test']);
  assert.equal((await send(draft)).status, 'sent');

  const rows = await waitForRows(3);
  assert.deepEqual(rows.map(r => [r.email, r.status, r.to ?? null]), [
    ['bad@example.test', 'skipped', null],
    ['ravi@example.test', 'pending', '919876543210'],
    ['subscriber@example.test', 'skipped', null],
  ]);
  assert.equal(rows[1].text, '*Payment reminder - Invoice #INV-7*\n\nHello Ravi,\n\nYour invoice is pending.');
  assert.equal(String(rows[1].emailDraftId), String(draft._id));
  assert.equal(rows[1].event, 'invoice.project');
  assert.match(rows[0].lastError, /not a valid mobile number/);
  assert.match(rows[2].lastError, /No phone number/);
});

test('no WhatsApp when the email is not sent: provider refused, Don’t Send, or WhatsApp turned off', async () => {
  await userModel.create({ name: 'Ravi', email: 'ravi@example.test', phone: '9876543210', roles: ['customer'] });
  providerFails = true;
  await assert.rejects(send(await pendingDraft(['ravi@example.test'])));
  providerFails = false;
  const skipped = await pendingDraft(['ravi@example.test']);
  await decide(String(skipped._id), null, { choice: 'skip' }, portalAdmin);
  delete process.env.ENABLE_WHATSAPP;
  assert.equal((await send(await pendingDraft(['ravi@example.test']))).status, 'sent');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await Queue.countDocuments(), 0);
});

test('queuing the same email twice keeps one row per recipient', async () => {
  await userModel.create({ name: 'Ravi', email: 'ravi@example.test', phone: '9876543210', roles: ['customer'] });
  const draft = await pendingDraft(['ravi@example.test']);
  await enqueueWhatsAppForEmail(draft);
  await enqueueWhatsAppForEmail(draft);
  assert.equal(await Queue.countDocuments(), 1);
});

test('a WhatsApp problem never changes the email result', async () => {
  await userModel.create({ name: 'Ravi', email: 'ravi@example.test', phone: '9876543210', roles: ['customer'] });
  const original = Queue.create;
  Queue.create = async () => { throw new Error('database down'); };
  try {
    assert.equal((await send(await pendingDraft(['ravi@example.test']))).status, 'sent');
    await new Promise(r => setTimeout(r, 300));
  } finally { Queue.create = original; }
  assert.equal(await Queue.countDocuments(), 0);
});
