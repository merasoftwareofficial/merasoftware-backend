const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.RESEND_API_KEY = 'not-a-real-provider-key';
process.env.FROM_EMAIL = 'sender@example.test';
process.env.TOKEN_SECRET_KEY = 'isolated-final-message-secret';

// Real routes, mail scope, review decision, queue, sender, worker listener and job on an isolated database. Only the phone and the mail provider are fake.
const mongoose = require('mongoose');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Lead = require('../models/leadModel');
const User = require('../models/userModel');
const { EmailDraft, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { FinalMessage, Lock, Queue, State, STATE_ID } = require('../whatsapp/src/models.js');
const { RECOMMENDED } = require('../whatsapp/src/settings.js');
const { createSender } = require('../whatsapp/src/sender.js');
const { createInbound } = require('../whatsapp/src/inbound.js');
const { Inbox, Rule } = require('../whatsapp/src/models.js');
const { requestMiddleware } = require('../helpers/emailController');
const { followFinalMessages } = require('../helpers/finalMessageJobs');
const { audience, GROUPS } = require('../helpers/broadcastAudience');
const leadFileUpload = require('../middleware/leadFileUpload');
const final = require('../controller/lead/finalMessage');

const nativeFetch = global.fetch;
const PHONE = '919876543210';
const HOUR = 3_600_000;
const silent = { error() {}, warn() {}, info() {} };
let db, server, base, admin;
const lead = (fields = {}) => Lead.create({ name: 'Ravi', phone: '9876543210', status: 'Contacted', ...fields });
const cookie = () => `token=${jwt.sign({ _id: String(admin._id), role: 'admin' }, process.env.TOKEN_SECRET_KEY)}`;
async function call(path, method = 'POST', body) {
  const response = await nativeFetch(`${base}${path}`, { method, headers: { Cookie: cookie(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const markNegative = async id => {
  const form = new FormData(); form.append('action', 'followUp'); form.append('badge', 'Negative'); form.append('note', 'Not interested');
  const response = await nativeFetch(`${base}/admin/leads/${id}`, { method: 'POST', headers: { Cookie: cookie() }, body: form });
  return { status: response.status, ...await response.json() };
};
const decide = async (id, choice, channels) => {
  const draft = (await call(`/email-control/drafts/${id}`, 'GET')).data;
  return { draft, result: await call(`/email-control/drafts/${id}/decision`, 'POST', { choice, ...(channels ? { channels } : {}), subject: draft.subject, subjectDoc: draft.templateSubjectDoc, doc: draft.templateDoc || draft.doc, templateId: draft.selectedTemplateId }) };
};
const listening = () => State.updateOne({ _id: STATE_ID }, { $set: { connection: 'connected', heartbeatAt: new Date(), settings: { ...RECOMMENDED, quietHours: false, jitterSec: 0, typing: false, minGapSec: 0 } } }, { upsert: true });
function phone() {
  const sent = [];
  return { sent, isConnected: () => true, resolve: async to => `${to}@s.whatsapp.net`, send: async (jid, text) => { sent.push([jid, text]); return `id-${sent.length}`; } };
}
const sendQueue = async transport => {
  await State.updateOne({ _id: STATE_ID }, { $set: { nextSendAt: null } }); // the real gap between messages is not under test here
  const sender = createSender({ Queue, State, transport, config: { timeZone: 'Asia/Kolkata' } });
  await sender.step();
};
const inbound = createInbound({ Inbox, Queue, Rule, State, logger: silent });
const incoming = (message, at = new Date(), number = PHONE) => inbound.handle({ type: 'notify', messages: [{ key: { id: `m-${Math.random()}`, remoteJid: `${number}@s.whatsapp.net`, fromMe: false }, message, messageTimestamp: Math.floor(at.getTime() / 1000) }] });
const pastDeadline = id => FinalMessage.updateOne({ leadId: id }, { $set: { deadlineAt: new Date(Date.now() - 1000), sentAt: new Date(Date.now() - 100 * HOUR) } });
const row = id => FinalMessage.findOne({ leadId: id }).lean();
const stage = async id => (await Lead.findById(id).lean()).status;
async function sentAndWaiting(fields) {
  const { _id } = await lead(fields);
  const marked = await markNegative(_id);
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  const transport = phone();
  await sendQueue(transport);
  await followFinalMessages();
  return { id: _id, transport };
}

before(async () => {
  db = await MongoMemoryServer.create();
  process.env.MONGODB_URI = db.getUri();
  await mongoose.connect(db.getUri(), { dbName: 'final-message-isolated-test' });
  await Promise.all([Queue.init(), Lead.init(), FinalMessage.init()]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const authToken = require('../middleware/authToken');
  app.use('/api', requestMiddleware);
  app.use('/api/email-control', require('../routes/emailControl'));
  app.use('/api/auto-reply', require('../routes/autoReply'));
  app.post('/api/admin/leads/:leadId', authToken, leadFileUpload, require('../controller/lead/updateLead'));
  app.get('/api/admin/leads/:leadId', authToken, require('../controller/lead/getLeadDetail'));
  app.get('/api/admin/final-message/count', authToken, final.countController);
  app.post('/api/admin/final-message/prepare', authToken, final.prepareAllController);
  app.post('/api/admin/leads/:leadId/final-message', authToken, final.prepareOneController);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  global.fetch = async () => new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 });
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true';
  await Promise.all([Lead, User, EmailDraft, EmailPolicy, EmailTemplate, Queue, FinalMessage, State, Lock].map(model => model.deleteMany({})));
  admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
  await listening();
});
after(async () => {
  global.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('marking Negative saves the stage and opens a review; nothing enters the queue until Send', async () => {
  const { _id } = await lead();
  const marked = await markNegative(_id);
  assert.equal(marked.success, true);
  assert.equal(marked.emailStatus, 'awaiting-review');
  assert.equal(marked.emailDraftIds.length, 1);
  assert.equal(await stage(_id), 'Negative');
  assert.equal(await Queue.countDocuments(), 0);
  assert.equal((await row(_id)).status, 'review');
});

test('a lead with no email offers only WhatsApp and shows the number; the setting fills the message and the timer', async () => {
  await call('/auto-reply/final-message/time', 'POST', { hours: 72 });
  const { _id } = await lead();
  const marked = await markNegative(_id);
  const { draft } = await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  assert.equal(draft.defaultChannel, 'whatsapp');
  assert.equal(draft.channelOptions.find(option => option.id === 'email').enabled, false);
  assert.equal(draft.whatsappTo, PHONE);
  assert.ok(draft.editorFields.variables.some(row => row.key === 'timeLimit' && row.label === 'Time limit'), 'the chip can be inserted again');
  assert.ok(JSON.stringify(draft.templateDoc).includes('timeLimit'), 'the time is a chip, not typed text');
  const transport = phone();
  await sendQueue(transport);
  assert.match(transport.sent[0][1], /ਅਗਲੇ 72 hours ਵਿੱਚ/);
  await followFinalMessages();
  const waiting = await row(_id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.deadlineAt - waiting.sentAt, 72 * HOUR);
});

test('a lead with an email and a number offers all channels, default Both', async () => {
  const { _id } = await lead({ email: 'ravi@example.test' });
  const marked = await markNegative(_id);
  const draft = (await call(`/email-control/drafts/${marked.emailDraftIds[0]}`, 'GET')).data;
  assert.equal(draft.defaultChannel, 'both');
  await decide(marked.emailDraftIds[0], 'send', 'both');
  await sendQueue(phone());
  await followFinalMessages();
  assert.equal((await row(_id)).status, 'waiting');
});

test('email only and Don\'t Send start no timer and the lead never goes Dead by itself', async () => {
  const emailLead = await lead({ email: 'a@example.test', phone: '9876543211' });
  const skipped = await lead({ phone: '9876543212' });
  await decide((await markNegative(emailLead._id)).emailDraftIds[0], 'send', 'email');
  await decide((await markNegative(skipped._id)).emailDraftIds[0], 'skip');
  await followFinalMessages();
  await followFinalMessages();
  assert.equal((await row(emailLead._id)).status, 'email-only');
  assert.equal((await row(skipped._id)).status, 'not-sent');
  assert.equal(await stage(emailLead._id), 'Negative');
  assert.equal(await stage(skipped._id), 'Negative');
  assert.equal(await Queue.countDocuments(), 0);
});

test('Don\'t Send can be sent later; a message that went never goes again, even after moving back to Negative', async () => {
  const skipped = await lead({ phone: '9876543212' });
  await decide((await markNegative(skipped._id)).emailDraftIds[0], 'skip');
  await followFinalMessages();
  const again = await call(`/admin/leads/${skipped._id}/final-message`);
  assert.equal(again.emailDraftIds.length, 1, 'Send later reopens the popup');

  const { id } = await sentAndWaiting();
  const form = new FormData(); form.append('action', 'followUp'); form.append('badge', 'Contacted'); form.append('note', 'Talked');
  await nativeFetch(`${base}/admin/leads/${id}`, { method: 'POST', headers: { Cookie: cookie() }, body: form });
  const remarked = await markNegative(id);
  assert.equal(remarked.finalMessage, 'already-sent');
  assert.equal(remarked.emailDraftIds, undefined);
  assert.equal((await call(`/admin/leads/${id}/final-message`)).status, 409);
});

test('no reply by the deadline: Dead, and out of every Broadcast group', async () => {
  const { id } = await sentAndWaiting();
  await followFinalMessages();
  assert.equal(await stage(id), 'Negative', 'not before the deadline');
  await pastDeadline(id);
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
  assert.equal((await row(id)).status, 'dead');
  assert.ok(!GROUPS.some(group => group.id === 'Dead'));
  assert.equal((await audience('Negative')).count, 0);
  const notes = (await Lead.findById(id).lean()).followUps.map(item => item.note);
  assert.ok(notes.some(note => note.includes('Moved to Dead')));
});

test('any reply keeps the lead Negative, shown to the admin: text, voice, photo and reaction', async () => {
  const kinds = [
    [{ conversation: 'nahi chahiye' }, 'nahi chahiye'], [{ audioMessage: { seconds: 4 } }, 'Voice message'],
    [{ imageMessage: { mimetype: 'image/jpeg' } }, 'Photo'], [{ reactionMessage: { text: '👍', key: { id: 'x' } } }, 'Reaction 👍'],
  ];
  for (const [index, [message, label]] of kinds.entries()) {
    const number = `91987654320${index}`;
    const { id } = await sentAndWaiting({ phone: `+${number}` });
    await incoming(message, new Date(Date.now() + 60_000), number);
    await pastDeadline(id);
    await FinalMessage.updateOne({ leadId: id }, { $set: { sentAt: new Date(Date.now() - 1000) } });
    await followFinalMessages();
    assert.equal(await stage(id), 'Negative', label);
    assert.equal((await row(id)).status, 'replied', label);
    assert.equal((await row(id)).lastReplyText, label);
  }
  const { data } = await call('/auto-reply/final-message', 'GET');
  assert.equal(data.counts.replied, 4);
  assert.equal(data.replies.length, 4);
});

test('replies count with Auto Reply off, an older message is not a reply, and other chats save nothing', async () => {
  await State.updateOne({ _id: STATE_ID }, { $set: { 'autoReply.recognise': false } });
  const { id } = await sentAndWaiting();
  const sentAt = (await row(id)).sentAt;
  await incoming({ conversation: 'an old message' }, new Date(sentAt.getTime() - HOUR)); // arrives after a restart
  await followFinalMessages();
  assert.equal((await row(id)).status, 'waiting');
  await incoming({ conversation: 'someone else' }, new Date(), '919111111111');
  assert.equal(await FinalMessage.countDocuments({ phone: '919111111111' }), 0);
  assert.equal(await Inbox.countDocuments(), 0);
  await incoming({ conversation: 'yes tell me' }, new Date(Date.now() + 5000));
  await followFinalMessages();
  assert.equal((await row(id)).status, 'replied');
  await incoming({ conversation: 'a later private chat' }, new Date(Date.now() + 9000));
  assert.equal((await row(id)).lastReplyText, 'yes tell me', 'nothing more is saved once the reply came');
});

test('a reply after going Dead brings the lead back to Negative', async () => {
  const { id } = await sentAndWaiting();
  await pastDeadline(id);
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
  await incoming({ conversation: 'sorry, interested' });
  await followFinalMessages();
  assert.equal(await stage(id), 'Negative');
  assert.equal((await row(id)).status, 'replied');
});

test('the admin moving the lead cancels a waiting message and stops the timer', async () => {
  const waitingInQueue = await lead({ phone: '9876543213' });
  const marked = await markNegative(waitingInQueue._id);
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  await Lead.updateOne({ _id: waitingInQueue._id }, { status: 'Positive' });
  await followFinalMessages();
  assert.equal((await Queue.findOne({ emailDraftId: marked.emailDraftIds[0] }).lean()).status, 'cancelled');
  assert.equal((await row(waitingInQueue._id)).status, 'not-sent');

  const { id } = await sentAndWaiting();
  await Lead.updateOne({ _id: id }, { status: 'Contacted' });
  await pastDeadline(id);
  await followFinalMessages();
  assert.equal(await stage(id), 'Contacted');
  assert.equal((await row(id)).status, 'stopped');
});

test('a failed send starts no timer; nothing goes Dead while WhatsApp is not listening', async () => {
  const failed = await lead({ phone: '9876543214' });
  const marked = await markNegative(failed._id);
  await decide(marked.emailDraftIds[0], 'send', 'whatsapp');
  await sendQueue({ ...phone(), resolve: async () => null });
  await followFinalMessages();
  assert.equal((await row(failed._id)).status, 'not-sent');
  assert.equal(await stage(failed._id), 'Negative');

  const { id } = await sentAndWaiting();
  await pastDeadline(id);
  await State.updateOne({ _id: STATE_ID }, { $set: { connection: 'disconnected' } });
  await followFinalMessages();
  assert.equal(await stage(id), 'Negative');
  await listening();
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
});

test('the Leads button prepares one review per eligible Negative lead, and not clients or those already sent', async () => {
  await User.create({ name: 'Client', email: 'client@example.test', phone: '9000000002', roles: ['customer'] });
  const eligible = await lead({ status: 'Negative', phone: '9000000001' });
  const nameless = await lead({ status: 'Negative', phone: '9000000005', name: undefined });
  await lead({ status: 'Negative', phone: '9000000002' }); // a client's number
  await lead({ status: 'Negative', phone: '9000000003', requestedByUserId: admin._id });
  await lead({ status: 'Negative', phone: 'bad' });
  await lead({ status: 'Positive', phone: '9000000004' });
  assert.equal((await call('/admin/final-message/count', 'GET')).data.count, 2);
  const prepared = await call('/admin/final-message/prepare');
  assert.equal(prepared.data.prepared, 2);
  assert.equal(prepared.emailDraftIds.length, 2);
  assert.equal(await Queue.countDocuments(), 0);
  assert.equal((await row(eligible._id)).status, 'review');
  assert.equal((await row(nameless._id)).status, 'review');
  // Pressed again before deciding: the same drafts open again, no second message.
  const again = await call('/admin/final-message/prepare');
  assert.deepEqual([...again.emailDraftIds].sort(), [...prepared.emailDraftIds].sort());
  assert.equal(await EmailDraft.countDocuments(), 2);
  for (const id of prepared.emailDraftIds) await decide(id, 'send', 'whatsapp');
  await followFinalMessages(); // the next minute's job
  assert.equal((await call('/admin/final-message/count', 'GET')).data.count, 0);
});

test('a nameless lead goes Dead without an error; a Matured lead can\'t be marked Negative; the action Off prepares nothing', async () => {
  const { id } = await sentAndWaiting({ name: undefined, status: 'Inquiry' });
  await pastDeadline(id);
  await followFinalMessages();
  assert.equal(await stage(id), 'Dead');
  const doc = await Lead.findById(id);
  await assert.doesNotReject(doc.save());

  const won = await lead({ status: 'Won', phone: '9000000006', convertedToUserId: admin._id });
  assert.equal((await markNegative(won._id)).status, 400);

  await EmailPolicy.create({ event: 'lead.finalMessage', mode: 'off' });
  const off = await lead({ phone: '9000000007' });
  const marked = await markNegative(off._id);
  assert.equal(marked.success, true);
  assert.equal(marked.finalMessage, 'unavailable');
  assert.equal(await stage(off._id), 'Negative');
});

test('the time setting refuses bad values and a saved value leaves sent messages alone', async () => {
  assert.equal((await call('/auto-reply/final-message/time', 'POST', { hours: 0 })).status, 400);
  assert.equal((await call('/auto-reply/final-message/time', 'POST', { hours: 'abc' })).status, 400);
  const { id } = await sentAndWaiting();
  const before = (await row(id)).deadlineAt;
  await call('/auto-reply/final-message/time', 'POST', { hours: 5 });
  await followFinalMessages();
  assert.deepEqual((await row(id)).deadlineAt, before);
  assert.equal((await call('/auto-reply/final-message', 'GET')).data.hours, 5);
});

test('the lead page reads the message state', async () => {
  const { id } = await sentAndWaiting();
  const { data } = await call(`/admin/leads/${id}`, 'GET');
  assert.equal(data.finalMessage.status, 'waiting');
  assert.ok(data.finalMessage.deadlineAt);
});
