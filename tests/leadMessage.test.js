const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.RESEND_API_KEY = 'not-a-real-provider-key';
process.env.FROM_EMAIL = 'sender@example.test';
process.env.TOKEN_SECRET_KEY = 'isolated-lead-message-secret';

// Real routes, mail scope, review decision, queue and Final Message job on an isolated database. Only the mail provider is fake.
const mongoose = require('mongoose');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Lead = require('../models/leadModel');
const User = require('../models/userModel');
const { EmailDraft, EmailHistory, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { FinalMessage, Lock, Queue, State } = require('../whatsapp/src/models.js');
const { requestMiddleware } = require('../helpers/emailController');
const { followFinalMessages } = require('../helpers/finalMessageJobs');
const { pendingLeads } = require('../helpers/finalMessage');
const { withRequiredLinks } = require('../helpers/emailMarkup');
const { queueProposalWhatsApp } = require('../helpers/leadProposalMessage');
const leadFileUpload = require('../middleware/leadFileUpload');

const nativeFetch = global.fetch;
const LINK = 'https://example.test/proposal';
let db, server, base, admin, mails;
const cookie = (user = admin, role = 'admin') => `token=${jwt.sign({ _id: String(user._id), role }, process.env.TOKEN_SECRET_KEY)}`;
const lead = (fields = {}) => Lead.create({ name: 'Ravi', phone: '9876543210', status: 'Contacted', ...fields });
const withProposal = () => ({ proposals: [{ version: 1, downloadLink: 'https://example.test/old', uploadedAt: new Date() }, { version: 2, downloadLink: LINK, amount: 500, uploadedAt: new Date() }] });
async function call(path, method = 'POST', body, auth = cookie()) {
  const response = await nativeFetch(`${base}${path}`, { method, headers: { Cookie: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const review = id => call(`/email-control/drafts/${id}`, 'GET').then(result => result.data);
async function open(id) {
  const result = await call(`/admin/leads/${id}/message`);
  assert.equal(result.status, 200, result.message);
  assert.equal(result.emailDraftIds.length, 1);
  assert.ok(result.emailReviewDraft, 'single lead action includes the shared review payload');
  const direct = await review(result.emailDraftIds[0]);
  assert.equal(String(result.emailReviewDraft._id), String(direct._id));
  assert.deepEqual(result.emailReviewDraft.templateOptions, direct.templateOptions);
  assert.deepEqual(result.emailReviewDraft.messageTypes, direct.messageTypes);
  assert.equal(result.emailReviewDraft.headers, undefined);
  return result.emailReviewDraft;
}
const move = async (draft, event) => call(`/email-control/drafts/${draft._id}/message-type`, 'POST', { event });
const send = (draft, channels) => call(`/email-control/drafts/${draft._id}/decision`, 'POST', { choice: 'send', channels, subject: draft.subject, subjectDoc: draft.templateSubjectDoc, doc: draft.templateDoc || draft.doc, templateId: draft.selectedTemplateId });
const stored = id => Lead.findById(id).lean();

before(async () => {
  db = await MongoMemoryServer.create();
  process.env.MONGODB_URI = db.getUri();
  await mongoose.connect(db.getUri(), { dbName: 'lead-message-isolated-test' });
  await Promise.all([Queue.init(), Lead.init(), FinalMessage.init()]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const authToken = require('../middleware/authToken');
  app.use(requestMiddleware);
  app.use('/email-control', require('../routes/emailControl'));
  app.post('/admin/leads/:leadId/message', authToken, require('../controller/lead/leadMessage'));
  app.post('/admin/leads/:leadId', authToken, leadFileUpload, require('../controller/lead/updateLead'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (url, options) => { mails.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 }); };
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true'; mails = [];
  await Promise.all([Lead, User, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate, Queue, FinalMessage, State, Lock].map(model => model.deleteMany({})));
  admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
});
after(async () => {
  global.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

for (const status of ['Inquiry', 'Contacted', 'Positive', 'Negative', 'Dead', 'Won']) {
  test(`a ${status} lead gets a message on WhatsApp, and its stage stays`, async () => {
    const { _id } = await lead({ status });
    const draft = await open(_id);
    assert.equal(draft.event, 'lead.message');
    assert.equal(draft.defaultChannel, 'whatsapp');
    assert.equal((await send(draft, 'whatsapp')).data.status, 'queued');
    const [row] = await Queue.find().lean();
    assert.equal(row.to, '919876543210'); assert.equal(row.event, 'lead.message'); assert.match(row.text, /Hello Ravi/);
    assert.equal((await stored(_id)).status, status);
  });
}

test('only an admin can open it, and a lead in Trash cannot get one', async () => {
  const { _id } = await lead();
  assert.equal((await call(`/admin/leads/${_id}/message`, 'POST', undefined, cookie(admin, 'customer'))).status, 403);
  assert.equal(await EmailDraft.countDocuments(), 0);
  const trashed = await lead({ deletedAt: new Date() });
  assert.equal((await call(`/admin/leads/${trashed._id}/message`)).status, 404);
});

test('a lead no channel can reach gets a clear refusal and no draft', async () => {
  const { _id } = await lead({ phone: '' });
  const result = await call(`/admin/leads/${_id}/message`);
  assert.equal(result.status, 409); assert.match(result.message, /WhatsApp number and email/);
  assert.equal(await EmailDraft.countDocuments(), 0);
});

test('the list shows only what fits this lead: Proposal needs a proposal, and an Off action is disabled', async () => {
  const plain = await open((await lead())._id);
  assert.deepEqual(plain.messageTypes.map(type => type.id), ['lead.message', 'lead.created', 'lead.finalMessage']);
  assert.equal(plain.messageTypes[0].label, 'General message');
  await EmailPolicy.create({ event: 'lead.created', mode: 'off' });
  const full = await open((await lead(withProposal()))._id);
  assert.deepEqual(full.messageTypes.map(type => type.id), ['lead.message', 'lead.created', 'lead.proposal', 'lead.finalMessage']);
  assert.equal(full.messageTypes[1].enabled, false);
  assert.equal((await move(full, 'lead.created')).status, 409);
});

test('with General Off the popup opens on the next type; with all Off nothing is prepared', async () => {
  await EmailPolicy.create({ event: 'lead.message', mode: 'off' });
  const { _id } = await lead();
  assert.equal((await open(_id)).event, 'lead.created');
  await EmailPolicy.create([{ event: 'lead.created', mode: 'off' }, { event: 'lead.finalMessage', mode: 'off' }]);
  assert.equal((await call(`/admin/leads/${_id}/message`)).status, 409);
});

test('changing the type moves the same draft: one History row, the new action\'s templates and values', async () => {
  const { _id } = await lead({ email: 'ravi@example.test', ...withProposal() });
  const draft = await open(_id);
  const other = await EmailTemplate.create({ event: 'lead.finalMessage', name: 'Second', subject: 'Second', text: 'Closing in {{timeLimit}}' });
  const moved = (await move(draft, 'lead.finalMessage')).data;
  assert.equal(String(moved._id), String(draft._id));
  assert.equal(moved.event, 'lead.finalMessage'); assert.match(moved.html, /24 hours/);
  assert.ok(moved.templateOptions.some(option => option.id === String(other._id)));
  assert.equal(moved.channelOptions.find(option => option.id === 'both').enabled, true);
  const proposal = (await move(moved, 'lead.proposal')).data;
  assert.match(proposal.html, new RegExp(LINK)); assert.doesNotMatch(proposal.html, /example\.test\/old/);
  assert.deepEqual(proposal.requiredLinks, [LINK]);
  const general = (await move(proposal, 'lead.message')).data;
  assert.deepEqual(general.requiredLinks, []);
  assert.equal(await EmailDraft.countDocuments(), 1);
  const history = await EmailHistory.find().lean();
  assert.equal(history.length, 1); assert.equal(history[0].event, 'lead.message');
});

test('the type cannot change to a foreign action or after the send, and other drafts have no type list', async () => {
  const { _id } = await lead();
  const draft = await open(_id);
  assert.equal((await move(draft, 'auth.otp')).status, 400);
  assert.equal((await move(draft, 'lead.proposal')).status, 400, 'no proposal on this lead');
  await send(draft, 'whatsapp');
  assert.equal((await move(draft, 'lead.created')).status, 409);
  assert.equal((await stored(_id)).followUps.length, 1);
  const plain = await EmailDraft.create({ event: 'lead.proposal', actor: admin._id, application: 'portal', status: 'pending', to: ['a@example.test'], subject: 'Other', text: 'Other', expiresAt: new Date(Date.now() + 3_600_000) });
  assert.equal((await review(plain._id)).messageTypes, undefined);
  assert.equal((await call(`/email-control/drafts/${plain._id}/message-type`, 'POST', { event: 'lead.message' })).status, 404);
});

test('Final message through this popup never starts the wait, and the Final Message button still counts the lead', async () => {
  const { _id } = await lead({ status: 'Negative' });
  const draft = (await move(await open(_id), 'lead.finalMessage')).data;
  assert.ok(draft.messageTypes.find(type => type.id === 'lead.finalMessage').note);
  assert.equal((await send(draft, 'whatsapp')).data.status, 'queued');
  await Queue.updateMany({}, { $set: { status: 'sent', sentAt: new Date() } });
  await followFinalMessages();
  assert.equal(await FinalMessage.countDocuments(), 0);
  assert.equal((await stored(_id)).status, 'Negative');
  assert.equal((await pendingLeads()).length, 1);
});

test('the same lead can get a message again', async () => {
  const { _id } = await lead();
  for (let turn = 0; turn < 2; turn += 1) await send(await open(_id), 'whatsapp');
  assert.equal(await Queue.countDocuments(), 2);
  assert.equal((await stored(_id)).followUps.length, 2);
});

test('Both sends one mail and one WhatsApp, and a nameless lead loses only the greeting', async () => {
  const both = await open((await lead({ email: 'ravi@example.test', status: 'Won' }))._id);
  assert.equal(both.defaultChannel, 'both');
  assert.equal((await send(both, 'both')).data.status, 'sent');
  assert.equal(mails.length, 1); assert.equal(await Queue.countDocuments(), 1);
  await Queue.deleteMany({});
  await send(await open((await lead({ name: '', status: 'Negative', phone: '9876500001' }))._id), 'whatsapp');
  const [row] = await Queue.find().lean();
  assert.doesNotMatch(row.text, /Hello|\{\{/); assert.match(row.text, /Please reply here/);
});

test('General message names the sender once on WhatsApp', async () => {
  await send(await open((await lead())._id), 'whatsapp');
  const [row] = await Queue.find().lean();
  assert.equal(row.text.match(/Mera Software/g).length, 1, row.text);
});

test('a new template saved here belongs to the selected action only', async () => {
  const { _id } = await lead();
  const draft = (await move(await open(_id), 'lead.created')).data;
  const saved = await call('/email-control/templates', 'POST', { event: draft.event, sourceTemplateId: draft.selectedTemplateId, name: 'Short welcome', subject: draft.subject, subjectDoc: draft.templateSubjectDoc, doc: draft.templateDoc });
  assert.equal(saved.data.event, 'lead.created');
  assert.equal(await EmailTemplate.countDocuments({ event: 'lead.message', system: false }), 0);
  const refused = await call('/email-control/templates', 'POST', { event: 'lead.message', sourceTemplateId: draft.selectedTemplateId, name: 'Moved', subject: draft.subject, text: draft.text });
  assert.equal(refused.status, 400);
  assert.ok((await review(draft._id)).templateOptions.some(option => option.name === 'Short welcome'));
});

test('the timeline line is added once, under the current stage, and neither edits nor decides the stage', async () => {
  const { _id } = await lead({ followUps: [{ note: 'First call', badge: 'Contacted', createdAt: new Date(Date.now() - 1000) }] });
  const draft = await open(_id);
  await send(draft, 'whatsapp');
  await require('../helpers/leadMessage').recordOnTimeline(draft._id);
  const saved = await stored(_id);
  assert.equal(saved.followUps.length, 2);
  const line = saved.followUps[1];
  assert.equal(line.note, 'Message: General message. WhatsApp queued.');
  assert.equal(line.badge, 'Contacted'); assert.equal(String(line.createdBy), String(admin._id));

  const edit = (followUpId, badge, note) => {
    const form = new FormData(); form.append('action', 'editFollowUp'); form.append('followUpId', String(followUpId)); form.append('badge', badge); form.append('note', note);
    return nativeFetch(`${base}/admin/leads/${_id}`, { method: 'POST', headers: { Cookie: cookie() }, body: form }).then(async response => ({ status: response.status, ...await response.json() }));
  };
  assert.equal((await edit(line._id, 'Positive', 'changed')).status, 400);
  assert.equal((await edit(saved.followUps[0]._id, 'Positive', 'First call')).status, 200);
  assert.equal((await stored(_id)).status, 'Positive', 'the last real follow-up still decides the stage');
});

test("Don't Send leaves no timeline line and nothing in the queue", async () => {
  const { _id } = await lead();
  const draft = await open(_id);
  await call(`/email-control/drafts/${draft._id}/decision`, 'POST', { choice: 'skip' });
  assert.equal((await stored(_id)).followUps.length, 0);
  assert.equal(await Queue.countDocuments(), 0);
});

test('a required link goes once, whether the text holds it or its detail', async () => {
  assert.equal(withRequiredLinks('View: {{link}}', [LINK], { link: LINK }), 'View: {{link}}');
  assert.equal(withRequiredLinks('View: {{link}}', [LINK], new Map([['link', LINK]])), 'View: {{link}}');
  assert.equal(withRequiredLinks(`View: ${LINK}`, [LINK]), `View: ${LINK}`);
  assert.equal(withRequiredLinks('Removed by the reviewer', [LINK], { link: LINK }), `Removed by the reviewer\n\n${LINK}`);
  const once = text => assert.equal(text.split(LINK).length - 1, 1, text);

  const { _id } = await lead(withProposal());
  await send((await move(await open(_id), 'lead.proposal')).data, 'whatsapp');
  once((await Queue.findOne().lean()).text);
  await Queue.deleteMany({});

  const emailLead = await lead({ email: 'ravi@example.test', phone: '9876500002', ...withProposal() });
  await send((await move(await open(emailLead._id), 'lead.proposal')).data, 'both');
  once(mails[0].text); once((await Queue.findOne().lean()).text);
  await Queue.deleteMany({});

  const phoneOnly = await lead({ phone: '9876500003', ...withProposal() });
  const draft = (await move(await open(phoneOnly._id), 'lead.proposal')).data;
  await queueProposalWhatsApp(phoneOnly, phoneOnly.proposals[1], { subject: draft.subject, subjectDoc: draft.templateSubjectDoc, doc: draft.templateDoc });
  once((await Queue.findOne().lean()).text);
});
