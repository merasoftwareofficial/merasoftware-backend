const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Inbox, Lock, Queue, Rule, State, STATE_ID } = require('../whatsapp/src/models.js');
const { DEFAULT_AD_MESSAGE, RULE_KEY } = require('../whatsapp/src/autoReplyRules.js');
const { RECOMMENDED } = require('../whatsapp/src/settings.js');
const { createSender } = require('../whatsapp/src/sender.js');
const { createInbound } = require('../whatsapp/src/inbound.js');
const { processInbox } = require('../helpers/autoReplyJobs');
const { FIRST_REPLY, replyText } = require('../helpers/autoReplyContent');
const { enqueueWhatsApp } = require('../helpers/whatsappQueue');
const { audience } = require('../helpers/broadcastAudience');
const { submit } = require('../helpers/broadcastService');
const { dispatch } = require('../helpers/broadcastJobs');
const { Broadcast, BroadcastRecipient, BroadcastGate } = require('../models/broadcastModel');
const Template = require('../models/messageTemplateModel');
const Lead = require('../models/leadModel');
const userModel = require('../models/userModel');
const nativeFetch = global.fetch;
const PHONE = '919876543210';
let db, server, base, admin, customer, controlBase, serial = 0;
const silent = { error() {}, warn() {}, info() {} };
const cookie = user => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function api(url, user = admin, method = 'GET', body) {
  const headers = { ...(user ? { Cookie: cookie(user) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await nativeFetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const row = (fields = {}) => ({ messageId: `m-${++serial}`, phone: PHONE, text: DEFAULT_AD_MESSAGE, status: 'new', profileName: 'Ravi', sentAt: new Date(), ...fields });
const setSwitches = (autoReply = {}) => State.updateOne({ _id: STATE_ID }, { $set: { autoReply: { recognise: true, sendReplies: true, addLeads: true, ...autoReply } } }, { upsert: true });
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const named = () => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dear ' }, { type: 'emailVariable', attrs: { key: 'name' } }] }] });
const config = { timeZone: 'Asia/Kolkata' };
function fakeWhatsApp() {
  const sent = [];
  return { sent, isConnected: () => true, resolve: async to => `${to}@s.whatsapp.net`, send: async (jid, text) => { sent.push([jid, text]); return `id-${sent.length}`; } };
}
const openSending = () => State.updateOne({ _id: STATE_ID }, { $set: { connection: 'connected', heartbeatAt: new Date(), settings: { ...RECOMMENDED, quietHours: false, jitterSec: 0, typing: false } } }, { upsert: true });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-auto-reply-test-secret';
  db = await MongoMemoryServer.create();
  process.env.MONGODB_URI = db.getUri(); // the worker config requires it; nothing here connects with it
  await mongoose.connect(db.getUri(), { dbName: 'auto-reply-isolated-test' });
  await Promise.all([Inbox.init(), Rule.init(), Queue.init(), Broadcast.init(), BroadcastRecipient.init(), Template.init()]);
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
  ]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/auto-reply', require('../routes/autoReply'));
  app.use('/api/whatsapp-control', require('../routes/whatsappControl'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/auto-reply`;
  controlBase = `http://127.0.0.1:${server.address().port}/api/whatsapp-control`;
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true';
  await Promise.all([Inbox, Rule, State, Queue, Lead, Lock, Broadcast, BroadcastRecipient, BroadcastGate, Template].map(model => model.deleteMany({})));
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });

test('only a signed-in admin can open anything', async () => {
  for (const [path, method] of [['/status', 'GET'], ['/switches', 'POST'], ['/message', 'POST'], ['/reply', 'POST']]) {
    assert.equal((await api(base + path, null, method)).status, 401, path);
    assert.equal((await api(base + path, customer, method)).status, 403, path);
  }
  assert.equal(await Rule.countDocuments(), 0);
});

test('starts with every switch Off, the owner\'s ad message and the owner\'s reply, unchanged', async () => {
  const { data } = await api(`${base}/status`);
  assert.deepEqual(data.switches, { recognise: false, sendReplies: false, addLeads: false });
  assert.equal(data.message, DEFAULT_AD_MESSAGE);
  assert.equal(data.listening, false);
  assert.deepEqual(data.detected, { rows: [], total: 0, needsAttention: 0, repliesSent: 0, repliesWaiting: 0, newLeads: 0 });
  assert.equal(replyText(null), FIRST_REPLY);
  await api(`${base}/status`);
  assert.equal(await Rule.countDocuments(), 1, 'opening the box twice keeps one rule');
});

test('each switch turns On and Off alone; anything else is refused', async () => {
  for (const key of ['recognise', 'sendReplies', 'addLeads']) {
    assert.equal((await api(`${base}/switches`, admin, 'POST', { [key]: true })).status, 200);
    assert.equal((await api(`${base}/status`)).data.switches[key], true);
    assert.equal((await api(`${base}/switches`, admin, 'POST', { [key]: false })).status, 200);
    assert.equal((await api(`${base}/status`)).data.switches[key], false);
  }
  assert.equal((await api(`${base}/switches`, admin, 'POST', { other: true })).status, 400);
  assert.equal((await api(`${base}/switches`, admin, 'POST', { recognise: 'yes' })).status, 400);
  assert.equal((await api(`${base}/switches`, admin, 'POST', {})).status, 400);
});

test('saving or resetting Sending rules leaves the switches as they were', async () => {
  await api(`${base}/switches`, admin, 'POST', { recognise: true });
  assert.equal((await api(`${controlBase}/settings`, admin, 'POST', RECOMMENDED)).status, 200);
  assert.equal((await api(`${base}/status`)).data.switches.recognise, true);
  assert.equal((await api(`${controlBase}/settings/reset`, admin, 'POST')).status, 200);
  assert.equal((await api(`${base}/status`)).data.switches.recognise, true);
});

test('a short ad message is refused; the full message is saved', async () => {
  for (const message of ['', 'Hello', '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!', 'Can I get more info', 'x'.repeat(1001)]) {
    assert.equal((await api(`${base}/message`, admin, 'POST', { message })).status, 400, message);
  }
  const saved = 'I saw your website design advert today';
  assert.equal((await api(`${base}/message`, admin, 'POST', { message: `  ${saved}  ` })).status, 200);
  assert.equal((await api(`${base}/status`)).data.message, saved);
  assert.equal(await Rule.countDocuments({ key: RULE_KEY }), 1);
});

test('the reply can be changed, can\'t be empty, and can\'t hold the name field', async () => {
  assert.equal((await api(`${base}/reply`, admin, 'POST', { doc: doc('New words') })).status, 200);
  assert.equal(replyText(await Rule.findOne({ key: RULE_KEY }).lean()), 'New words');
  assert.equal((await api(`${base}/reply`, admin, 'POST', { doc: doc('  ') })).status, 400);
  assert.equal((await api(`${base}/reply`, admin, 'POST', {})).status, 400);
  assert.equal((await api(`${base}/reply`, admin, 'POST', { doc: named() })).status, 400);
  assert.equal(replyText(await Rule.findOne({ key: RULE_KEY }).lean()), 'New words');
});

test('shows recognised messages and counts, and says whether it can listen', async () => {
  await Inbox.create([row({ replyStatus: 'sent', leadId: new mongoose.Types.ObjectId(), status: 'closed' }), row({ replyStatus: 'pending', status: 'closed' }), row({ phone: null, status: 'needs-attention' })]);
  await State.updateOne({ _id: STATE_ID }, { $set: { connection: 'connected', heartbeatAt: new Date() } }, { upsert: true });
  const { data } = await api(`${base}/status`);
  assert.equal(data.listening, true);
  const { rows, ...counts } = data.detected;
  assert.equal(rows.length, 3);
  assert.deepEqual(counts, { total: 3, needsAttention: 1, repliesSent: 1, repliesWaiting: 1, newLeads: 1 });
  process.env.ENABLE_WHATSAPP = 'false';
  assert.equal((await api(`${base}/status`)).data.listening, false);
});

test('all On, a new number: one Inquiry lead with the details, and one reply in the queue', async () => {
  await setSwitches();
  const message = await Inbox.create(row());
  assert.deepEqual(await processInbox(), { reason: 'done', closed: 1 });
  const lead = await Lead.findOne().lean();
  assert.equal(lead.status, 'Inquiry');
  assert.equal(lead.name, undefined);
  assert.equal(lead.phone, `+${PHONE}`);
  assert.equal(lead.source, 'WhatsApp ad');
  assert.equal(lead.inquiry.message, DEFAULT_AD_MESSAGE);
  assert.equal(lead.inquiry.profileName, 'Ravi');
  assert.equal(String(lead.inquiry.inboxId), String(message._id));
  const [queued] = await Queue.find().lean();
  assert.equal(await Queue.countDocuments(), 1);
  assert.equal(String(queued._id), String(message._id));
  assert.equal(queued.to, PHONE);
  assert.equal(queued.text, FIRST_REPLY);
  assert.equal(queued.status, 'pending');
  assert.equal(queued.event, 'auto-reply');
  const closed = await Inbox.findById(message._id).lean();
  assert.equal(closed.status, 'closed');
  assert.equal(closed.outcome, 'lead-and-reply');
  assert.equal(closed.replyStatus, 'pending');
});

test('each switch alone', async () => {
  for (const [autoReply, outcome, leads, replies] of [
    [{ sendReplies: false, addLeads: false }, 'detected-only', 0, 0],
    [{ sendReplies: false }, 'lead-only', 1, 0],
    [{ addLeads: false }, 'reply-only', 0, 1],
    [{ recognise: false }, 'switched-off', 0, 0],
    [{ recognise: false, sendReplies: false, addLeads: false }, 'switched-off', 0, 0],
  ]) {
    await Promise.all([Inbox.deleteMany({}), Lead.deleteMany({}), Queue.deleteMany({})]);
    await setSwitches(autoReply);
    await Inbox.create(row());
    await processInbox();
    const label = JSON.stringify(autoReply);
    assert.equal((await Inbox.findOne().lean()).outcome, outcome, label);
    assert.equal(await Lead.countDocuments(), leads, label);
    assert.equal(await Queue.countDocuments(), replies, label);
  }
});

test('turning a switch back On never acts on what came while it was Off', async () => {
  await setSwitches({ sendReplies: false, addLeads: false });
  await Inbox.create(row());
  await processInbox();
  await setSwitches();
  await processInbox();
  assert.equal(await Lead.countDocuments(), 0);
  assert.equal(await Queue.countDocuments(), 0);
});

test('the same person again: no new lead, no second reply, only the last-message time', async () => {
  await setSwitches();
  const first = new Date('2026-10-30T10:00:00Z'), second = new Date('2026-10-30T11:00:00Z');
  await Inbox.create(row({ sentAt: first }));
  await processInbox();
  await Inbox.create(row({ sentAt: second }));
  await processInbox();
  assert.equal(await Lead.countDocuments(), 1);
  assert.equal(await Queue.countDocuments(), 1);
  const lead = await Lead.findOne().lean();
  assert.deepEqual(lead.inquiry.firstAt, first);
  assert.deepEqual(lead.inquiry.lastAt, second);
  assert.equal((await Inbox.findOne({ sentAt: second }).lean()).outcome, 'known-person');
});

test('two messages from one person in the same run: still one lead and one reply', async () => {
  await setSwitches();
  await Inbox.create([row(), row()]);
  await processInbox();
  assert.equal(await Lead.countDocuments(), 1);
  assert.equal(await Queue.countDocuments(), 1);
});

test('with Add to leads off, the same person still gets only one reply', async () => {
  await setSwitches({ addLeads: false });
  await Inbox.create(row());
  await processInbox();
  await Inbox.create(row());
  await processInbox();
  assert.equal(await Queue.countDocuments(), 1);
  assert.equal(await Lead.countDocuments(), 0);
});

test('already known people get no lead and no reply, and their lead is untouched', async () => {
  await setSwitches();
  const cases = [
    { lead: { name: 'C', phone: '9876543210', status: 'Contacted' } },
    { lead: { name: 'N', phone: '+91 98765 43210', status: 'Negative' } },
    { lead: { name: 'W', phone: '919876543210', status: 'Won' } },
    { lead: { name: 'T', phone: '9876543210', deletedAt: new Date() } },
    { user: { name: 'U', email: 'known@example.test', phone: '9876543210', roles: ['customer'] } },
  ];
  for (const { lead, user } of cases) {
    await Promise.all([Inbox.deleteMany({}), Lead.deleteMany({}), Queue.deleteMany({}), userModel.deleteOne({ email: 'known@example.test' })]);
    if (lead) await Lead.create(lead);
    if (user) await userModel.create(user);
    await Inbox.create(row());
    await processInbox();
    const label = JSON.stringify(lead || user);
    assert.equal((await Inbox.findOne().lean()).outcome, 'known-person', label);
    assert.equal(await Queue.countDocuments(), 0, label);
    assert.equal(await Lead.countDocuments(), lead ? 1 : 0, label);
    if (lead) {
      const after = await Lead.findOne().lean();
      assert.equal(after.status, lead.status || 'Contacted', label);
      assert.equal(after.inquiry, undefined, label);
    }
  }
  await userModel.deleteOne({ email: 'known@example.test' });
});

test('a row with no number makes nothing and stays for the admin', async () => {
  await setSwitches();
  await Inbox.create(row({ phone: null, status: 'needs-attention' }));
  await processInbox();
  assert.equal(await Lead.countDocuments(), 0);
  assert.equal(await Queue.countDocuments(), 0);
  assert.equal(await Inbox.countDocuments({ status: 'needs-attention' }), 1);
});

test('a job that stopped halfway finishes the same way: one lead, one reply, same words', async () => {
  await setSwitches();
  const message = await Inbox.create(row());
  await processInbox();
  // Back to the moment before the row closed, with the lead and the reply already made.
  await Inbox.updateOne({ _id: message._id }, { $set: { status: 'new' }, $unset: { outcome: 1 } });
  await Rule.create({ key: RULE_KEY, message: DEFAULT_AD_MESSAGE, reply: JSON.stringify(doc('Changed meanwhile')) });
  await processInbox();
  assert.equal(await Lead.countDocuments(), 1);
  assert.equal(await Queue.countDocuments(), 1);
  assert.equal((await Queue.findOne().lean()).text, FIRST_REPLY);
  assert.equal((await Inbox.findById(message._id).lean()).outcome, 'lead-and-reply', 'not mistaken for an old contact because of its own lead');
});

test('a job that stopped before the reply reached the queue: it goes, with the words chosen the first time', async () => {
  await setSwitches();
  const message = await Inbox.create(row());
  await processInbox();
  await Inbox.updateOne({ _id: message._id }, { $set: { status: 'new' }, $unset: { outcome: 1 } });
  await Queue.deleteMany({});
  await Rule.create({ key: RULE_KEY, message: DEFAULT_AD_MESSAGE, reply: JSON.stringify(doc('Changed meanwhile')) });
  await processInbox();
  assert.equal((await Queue.findById(message._id).lean()).text, FIRST_REPLY);
  assert.equal(await Lead.countDocuments(), 1);
});

test('a number normalizePhone can\'t read is still one person: one lead, one reply', async () => {
  await setSwitches();
  await Inbox.create(row({ phone: '915123456789' }));
  await processInbox();
  await Inbox.create(row({ phone: '915123456789' }));
  await processInbox();
  assert.equal(await Lead.countDocuments(), 1);
  assert.equal(await Queue.countDocuments(), 1);
});

test('Off pressed while the job is working: the reply it just queued is cancelled', async () => {
  await setSwitches();
  const realEnqueue = Queue.create;
  Queue.create = async function (...args) {
    const made = await realEnqueue.apply(this, args);
    await State.updateOne({ _id: STATE_ID }, { $set: { 'autoReply.sendReplies': false } }); // pressed right after the job's check
    return made;
  };
  try {
    await Inbox.create(row());
    await processInbox();
  } finally { Queue.create = realEnqueue; }
  const queued = await Queue.findOne().lean();
  assert.equal(queued.status, 'cancelled');
  assert.match(queued.lastError, /turned off/);
  assert.equal(await Lead.countDocuments(), 1, 'the lead stays');
});

test('each row reads the switches fresh: Off pressed between two rows stops the second', async () => {
  await setSwitches();
  const realCreate = Lead.create;
  Lead.create = async function (...args) {
    const made = await realCreate.apply(this, args);
    await State.updateOne({ _id: STATE_ID }, { $set: { 'autoReply.recognise': false } });
    return made;
  };
  try {
    await Inbox.create(row());
    await new Promise(resolve => setTimeout(resolve, 5));
    await Inbox.create(row({ phone: '919111111111' }));
    await processInbox();
  } finally { Lead.create = realCreate; }
  assert.equal(await Lead.countDocuments(), 1);
  assert.equal((await Inbox.findOne({ phone: '919111111111' }).lean()).outcome, 'switched-off');
});

test('a failed reply sent again by hand from Queue History shows as sent', async () => {
  await setSwitches();
  await Inbox.create(row());
  await processInbox();
  const { _id } = await Inbox.findOne().lean();
  await Queue.updateOne({ _id }, { $set: { status: 'failed' } });
  await processInbox();
  assert.equal((await Inbox.findById(_id).lean()).replyStatus, 'failed');
  await Queue.updateOne({ _id }, { $set: { status: 'sent' } });
  await processInbox();
  assert.equal((await Inbox.findById(_id).lean()).replyStatus, 'sent');
});

test('two jobs at once: the lock lets one run', async () => {
  await setSwitches();
  await Inbox.create(row());
  const results = await Promise.all([processInbox(), processInbox(), processInbox()]);
  assert.equal(await Lead.countDocuments(), 1);
  assert.equal(await Queue.countDocuments(), 1);
  assert.equal(results.reduce((total, result) => total + result.closed, 0), 1);
});

test('with WhatsApp off on the server the job does nothing', async () => {
  process.env.ENABLE_WHATSAPP = 'false';
  await setSwitches();
  await Inbox.create(row());
  assert.equal((await processInbox()).reason, 'disabled');
  assert.equal(await Inbox.countDocuments({ status: 'new' }), 1);
  assert.equal(await Queue.countDocuments(), 0);
});

test('turning Send replies or Recognise off cancels waiting replies, and only those', async () => {
  for (const key of ['sendReplies', 'recognise']) {
    await Promise.all([Inbox.deleteMany({}), Lead.deleteMany({}), Queue.deleteMany({})]);
    await setSwitches();
    await Inbox.create(row());
    await processInbox();
    const other = await enqueueWhatsApp({ to: '919111111111', text: 'A service message', event: 'sendProjectCreatedEmail' });
    const sending = await enqueueWhatsApp({ to: '919222222222', text: 'Already going', event: 'auto-reply' });
    await Queue.updateOne({ _id: sending._id }, { $set: { status: 'sending' } });
    const { data } = await api(`${base}/switches`, admin, 'POST', { [key]: false });
    assert.equal(data.cancelled, 1, key);
    const cancelled = await Queue.findOne({ status: 'cancelled' }).lean();
    assert.equal(cancelled.to, PHONE, key);
    assert.match(cancelled.lastError, /turned off/);
    assert.equal((await Queue.findById(other._id).lean()).status, 'pending', 'service messages go on');
    assert.equal((await Queue.findById(sending._id).lean()).status, 'sending', 'one already claimed is left alone');
    await processInbox();
    assert.equal((await Inbox.findOne({ phone: PHONE }).lean()).replyStatus, 'cancelled', 'the result is copied');
    assert.equal(await Lead.countDocuments(), 1, 'the lead stays');
  }
  assert.equal((await api(`${base}/switches`, admin, 'POST', { addLeads: false })).data.cancelled, 0);
});

test('a reply already waiting keeps its words; a saved change applies to the next person', async () => {
  await setSwitches();
  await Inbox.create(row());
  await processInbox();
  assert.equal((await api(`${base}/reply`, admin, 'POST', { doc: doc('Newer words') })).status, 200);
  assert.equal((await Queue.findOne({ to: PHONE }).lean()).text, FIRST_REPLY);
  await Inbox.create(row({ phone: '919111111111' }));
  await processInbox();
  assert.equal((await Queue.findOne({ to: '919111111111' }).lean()).text, 'Newer words');
});

test('the real sender: the reply waits behind older messages, keeps the gap, and goes once', async () => {
  await setSwitches();
  await openSending();
  await enqueueWhatsApp({ to: '919111111111', text: 'Older service message', event: 'sendProjectCreatedEmail' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await Inbox.create(row());
  await processInbox();
  const wa = fakeWhatsApp();
  let time = new Date();
  const sender = createSender({ Queue, State, transport: wa, config, now: () => time, random: () => 0 });
  assert.equal((await sender.step()).reason, 'sent');
  assert.deepEqual(wa.sent.map(([jid]) => jid), ['919111111111@s.whatsapp.net'], 'the older one first');
  assert.equal((await sender.step()).reason, 'gap', 'no bypass: the reply waits out the gap');
  assert.equal(wa.sent.length, 1);
  time = new Date(time.getTime() + (RECOMMENDED.minGapSec + 1) * 1000);
  assert.equal((await sender.step()).reason, 'sent');
  assert.deepEqual(wa.sent[1], [`${PHONE}@s.whatsapp.net`, FIRST_REPLY]);
  time = new Date(time.getTime() + (RECOMMENDED.minGapSec + 1) * 1000);
  assert.equal((await sender.step()).reason, 'empty');
  assert.equal(wa.sent.length, 2);
  await processInbox();
  assert.equal((await Inbox.findOne().lean()).replyStatus, 'sent', 'the result is copied back');
});

test('the real sender: quiet hours hold the reply', async () => {
  await setSwitches();
  await openSending();
  await State.updateOne({ _id: STATE_ID }, { $set: { 'settings.quietHours': true, 'settings.quietFrom': 22, 'settings.quietTo': 8 } });
  await Inbox.create(row());
  await processInbox();
  const wa = fakeWhatsApp();
  const night = new Date('2026-10-30T18:00:00Z'); // 11:30 pm in India
  const sender = createSender({ Queue, State, transport: wa, config, now: () => night, random: () => 0 });
  assert.equal((await sender.step()).reason, 'quiet-hours');
  assert.equal(wa.sent.length, 0);
  assert.equal(await Queue.countDocuments({ status: 'pending' }), 1);
});

test('a message from our side: the waiting reply is cancelled, the lead stays, other chats are untouched', async () => {
  await setSwitches();
  await openSending();
  const at = new Date();
  await Inbox.create(row({ sentAt: at }));
  await Inbox.create(row({ sentAt: at, phone: '919111111111' }));
  await processInbox();
  const inbound = createInbound({ Inbox, Queue, Rule, State, logger: silent });
  await inbound.handle({ type: 'notify', messages: [{ key: { id: 'mine', remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true }, message: { conversation: 'Hi, this is the owner' }, messageTimestamp: Math.floor(at.getTime() / 1000) + 60 }] });
  const mine = await Queue.findOne({ to: PHONE }).lean();
  assert.equal(mine.status, 'cancelled');
  assert.match(mine.lastError, /from our side/);
  assert.equal((await Queue.findOne({ to: '919111111111' }).lean()).status, 'pending');
  assert.equal(await Lead.countDocuments(), 2);
  const wa = fakeWhatsApp();
  const sender = createSender({ Queue, State, transport: wa, config, random: () => 0 });
  await sender.step();
  assert.deepEqual(wa.sent.map(([jid]) => jid), ['919111111111@s.whatsapp.net'], 'the cancelled reply never goes');
});

test('a message from our side before the job ran: no reply is queued, the lead is still made', async () => {
  await setSwitches();
  const at = new Date();
  await Inbox.create(row({ sentAt: at }));
  const inbound = createInbound({ Inbox, Queue, Rule, State, logger: silent });
  await inbound.handle({ type: 'notify', messages: [{ key: { id: 'mine', remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true }, message: { conversation: 'Hi' }, messageTimestamp: Math.floor(at.getTime() / 1000) + 60 }] });
  await processInbox();
  assert.equal(await Queue.countDocuments(), 0);
  assert.equal(await Lead.countDocuments(), 1);
  assert.equal((await Inbox.findOne().lean()).outcome, 'lead-only');
});

test('our own old message, a reaction, the reply\'s own send, or Auto Reply off: nothing is cancelled', async () => {
  await setSwitches();
  await openSending();
  const at = new Date();
  await Inbox.create(row({ sentAt: at }));
  await processInbox();
  const inbound = createInbound({ Inbox, Queue, Rule, State, logger: silent });
  const seconds = Math.floor(at.getTime() / 1000);
  const own = (id, message, timestamp) => ({ key: { id, remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true }, message, messageTimestamp: timestamp });
  await inbound.handle({ type: 'append', messages: [own('old', { conversation: 'Yesterday' }, seconds - 86_400)] });
  await inbound.handle({ type: 'notify', messages: [own('react', { reactionMessage: { text: '👍' } }, seconds + 60)] });
  await inbound.handle({ type: 'notify', messages: [own('del', { protocolMessage: { type: 0 } }, seconds + 60)] });
  await inbound.handle({ type: 'notify', messages: [{ key: { id: 'g', remoteJid: '120363000000000000@g.us', fromMe: true }, message: { conversation: 'In a group' }, messageTimestamp: seconds + 60 }] });
  assert.equal((await Queue.findOne().lean()).status, 'pending');
  // The reply's own echo: the sender has claimed it, so its row is no longer pending.
  await Queue.updateOne({}, { $set: { status: 'sending' } });
  await inbound.handle({ type: 'notify', messages: [own('echo', { conversation: FIRST_REPLY }, seconds + 60)] });
  assert.equal((await Queue.findOne().lean()).status, 'sending');
  await Queue.updateOne({}, { $set: { status: 'pending' } });
  await State.updateOne({ _id: STATE_ID }, { $set: { 'autoReply.recognise': false } });
  await inbound.handle({ type: 'notify', messages: [own('off', { conversation: 'Hi' }, seconds + 60)] });
  assert.equal((await Queue.findOne().lean()).status, 'pending');
  assert.equal(await Inbox.countDocuments(), 1, 'nothing about our own messages is saved');
});

test('Broadcast: the Inquiry group works; a message using the name skips nameless leads, in the count and the send', async () => {
  await openSending();
  process.env.BROADCAST_JOBS_ENABLED = 'true';
  await Lead.create([{ phone: '+919111111111', status: 'Inquiry' }, { phone: '+919222222222', status: 'Inquiry', name: 'Has Name' }, { phone: '+919333333333', status: 'Negative' }, { phone: 'bad', status: 'Inquiry' }]);
  const all = await audience('Inquiry');
  assert.equal(all.count, 2);
  assert.deepEqual(all.excluded, { invalidPhone: 1, duplicatePhone: 0, noName: 1 });
  assert.equal((await audience('Inquiry', { requireName: true })).count, 1);
  assert.equal((await audience('Negative', { requireName: true })).count, 0);
  await assert.rejects(submit({ requestKey: 'negative-name-request-01', audience: 'Negative', doc: named(), origin: 'new' }, admin._id), /name/);

  await submit({ requestKey: 'inquiry-name-request-001', audience: 'Inquiry', doc: named(), origin: 'new' }, admin._id);
  await dispatch();
  const named_ = await BroadcastRecipient.find().lean();
  assert.equal(named_.length, 1);
  assert.equal(named_[0].phone, '919222222222');
  assert.equal((await Queue.findOne().lean()).text, 'Dear Has Name');
  await Promise.all([Queue.deleteMany({}), BroadcastRecipient.deleteMany({}), Broadcast.deleteMany({}), BroadcastGate.deleteMany({}), Template.deleteMany({})]);

  await submit({ requestKey: 'inquiry-plain-request-01', audience: 'Inquiry', doc: doc('An offer for you'), origin: 'new' }, admin._id);
  await dispatch();
  assert.equal(await BroadcastRecipient.countDocuments(), 2, 'a message with no name reaches them too');
  assert.equal((await Queue.findOne().lean()).text, 'An offer for you');
  delete process.env.BROADCAST_JOBS_ENABLED;
});

test('Broadcast: with one number on a nameless and a named lead, a message using the name goes to the named one', async () => {
  await Lead.create({ phone: '+919111111111', status: 'Negative' });
  await Lead.create({ name: 'Has Name', phone: '9111111111', status: 'Negative' });
  const { recipients } = await audience('Negative', { requireName: true });
  assert.deepEqual(recipients.map(person => person.name), ['Has Name']);
  assert.equal((await audience('Negative')).count, 1, 'without the name, still once');
});

test('a message from our side in a LID chat: the real number is found, and our own number is never taken for theirs', async () => {
  await setSwitches();
  const at = new Date();
  await Inbox.create(row({ sentAt: at }));
  await processInbox();
  const inbound = createInbound({ Inbox, Queue, Rule, State, logger: silent });
  const own = '919000000000';
  const socket = (mapped) => ({ user: { id: `${own}:5@s.whatsapp.net` }, signalRepository: { lidMapping: { getPNForLID: async () => mapped } } });
  const message = { key: { id: 'lid-1', remoteJid: '123456789012345@lid', remoteJidAlt: `${own}@s.whatsapp.net`, fromMe: true }, message: { conversation: 'Hi' }, messageTimestamp: Math.floor(at.getTime() / 1000) + 60 };
  await inbound.handle({ type: 'notify', messages: [message] }, socket(null));
  assert.equal((await Queue.findOne().lean()).status, 'pending', 'our own number finds nothing, and nothing is cancelled');
  await inbound.handle({ type: 'notify', messages: [message] }, socket(`${PHONE}:0@s.whatsapp.net`));
  assert.equal((await Queue.findOne().lean()).status, 'cancelled');
});

test('Broadcast: a person who leaves the Inquiry group gets nothing more', async () => {
  await openSending();
  process.env.BROADCAST_JOBS_ENABLED = 'true';
  const lead = await Lead.create({ phone: '+919111111111', status: 'Inquiry' });
  await submit({ requestKey: 'inquiry-leaves-request-1', audience: 'Inquiry', doc: doc('Offer'), origin: 'new' }, admin._id);
  await dispatch();
  assert.equal(await Queue.countDocuments({ status: 'pending' }), 1);
  await Lead.updateOne({ _id: lead._id }, { $set: { name: 'Ravi', status: 'Contacted' } });
  await dispatch();
  assert.equal((await Queue.findOne().lean()).status, 'cancelled');
  delete process.env.BROADCAST_JOBS_ENABLED;
});
