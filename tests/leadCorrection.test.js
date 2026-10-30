const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.RESEND_API_KEY = 'not-a-real-provider-key';
process.env.FROM_EMAIL = 'sender@example.test';

// Only Drive and the mail provider are fake; the routes, upload policy, mail scope and queue are real.
const drivePath = require.resolve('../helpers/googleDriveService');
class FakeDrive {
  async createFolder() { return 'folder'; }
  async uploadFile(name) { return { id: `drive-${name}` }; }
  getDownloadLink(id) { return `https://drive.example.test/${id}`; }
}
require.cache[drivePath] = { id: drivePath, filename: drivePath, loaded: true, exports: FakeDrive };

const mongoose = require('mongoose');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');
const leadModel = require('../models/leadModel');
const userModel = require('../models/userModel');
const { EmailDraft, EmailPolicy } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');
const { requestMiddleware, decide } = require('../helpers/emailController');
const leadFileUpload = require('../middleware/leadFileUpload');
const updateLead = require('../controller/lead/updateLead');
const uploadProposal = require('../controller/lead/uploadProposal');
const sendProposalWhatsapp = require('../controller/lead/sendProposalWhatsapp');
const addRoleToUser = require('../controller/user/addRoleToUser');
const { ensureWonLead } = require('../helpers/wonLead');
const { backfillWonLeads } = require('../scripts/backfillWonLeads');

const nativeFetch = global.fetch;
let db, server, base, admin;
const pdf = { size: 1000, type: 'application/pdf', name: 'proposal.pdf' };
const lead = (status = 'Contacted', extra = {}) => leadModel.create({ name: 'Ravi', phone: '9876543210', status, ...extra });
const read = id => leadModel.findById(id).lean();
const send = async (path, fields = {}, file) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append('attachment', new Blob([Buffer.alloc(file.size, 1)], { type: file.type }), file.name);
  const response = await nativeFetch(`${base}${path}`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
};
const json = async (path, body) => {
  const response = await nativeFetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const propose = (id, fields = {}, file = pdf) => send(`/admin/leads/${id}/proposal`, fields, file);
const reviewed = { choice: 'send', subject: 'Your proposal', text: 'Hello Ravi, your proposal: {{link}}' };

before(async () => {
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri(), { dbName: 'lead-correction-isolated-test' });
  await Promise.all([Queue.init(), leadModel.init()]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.userId = String(admin._id); req.userRole = req.headers['x-role'] || 'admin'; next(); });
  app.use('/api', requestMiddleware);
  app.post('/api/admin/leads/:leadId', leadFileUpload, updateLead);
  app.post('/api/admin/leads/:leadId/proposal', leadFileUpload, uploadProposal);
  app.post('/api/admin/leads/:leadId/proposal/:version/whatsapp', sendProposalWhatsapp);
  app.post('/api/addRole', addRoleToUser);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  global.fetch = async () => new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 });
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true';
  await Promise.all([leadModel.deleteMany({}), userModel.deleteMany({}), EmailDraft.deleteMany({}), EmailPolicy.deleteMany({}), Queue.deleteMany({})]);
  admin = await userModel.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
});
after(async () => {
  global.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('a proposal sets Proposal Sent, adds a timeline entry and keeps every version', async () => {
  const { _id } = await lead();
  const first = await propose(_id, { amount: '25000', note: 'First offer' });
  assert.equal(first.status, 200);
  let row = await read(_id);
  assert.equal(row.status, 'Proposal Sent');
  assert.equal(row.proposals[0].amount, 25000);
  assert.equal(row.proposals[0].note, 'First offer');
  assert.equal(row.followUps[0].note, 'Proposal v1 added, ₹25,000. First offer');
  assert.equal(row.followUps[0].badge, 'Proposal Sent');

  await propose(_id);
  row = await read(_id);
  assert.deepEqual(row.proposals.map(item => item.version), [1, 2]);
  assert.equal(row.proposals[1].amount, null);
  assert.equal(row.followUps[1].note, 'Proposal v2 added');
});

test('any proposal brings a Negative lead back; Positive stays Positive', async () => {
  const negative = await lead('Negative', { proposals: [{ version: 1, name: 'old' }] });
  await propose(negative._id);
  assert.equal((await read(negative._id)).status, 'Proposal Sent');
  const positive = await lead('Positive');
  await propose(positive._id);
  const row = await read(positive._id);
  assert.equal(row.status, 'Positive');
  assert.equal(row.followUps[0].badge, 'Positive');
});

test('refused proposals change nothing and say why, as JSON', async () => {
  const { _id } = await lead();
  const cases = [
    [await propose(_id, {}, null), /attach a proposal file/],
    [await propose(_id, { amount: 'abc' }), /valid amount/],
    [await propose(_id, { amount: '-5' }), /valid amount/],
    [await propose(_id, {}, { size: 1000, type: 'image/png', name: 'a.png' }), /Only JPG/],
    [await propose(_id, {}, { size: 6 * 1024 * 1024, type: 'application/pdf', name: 'b.pdf' }), /5 MB or smaller/],
  ];
  for (const [result, message] of cases) {
    assert.equal(result.status, 400);
    assert.match(result.body.message, message);
  }
  const row = await read(_id);
  assert.equal(row.status, 'Contacted');
  assert.equal(row.proposals.length, 0);
});

test('a converted lead takes no proposal', async () => {
  const { _id } = await lead('Won', { convertedToUserId: new mongoose.Types.ObjectId() });
  assert.equal((await propose(_id)).status, 409);
});

test('a follow-up without a badge keeps the status; only the three statuses can be chosen', async () => {
  const { _id } = await lead('Proposal Sent');
  const path = `/admin/leads/${_id}`;
  assert.equal((await send(path, { action: 'followUp', note: 'Called' })).status, 200);
  let row = await read(_id);
  assert.equal(row.status, 'Proposal Sent');
  assert.equal(row.followUps[0].badge, 'Proposal Sent');

  assert.equal((await send(path, { action: 'followUp', note: 'Liked it', badge: 'Positive' })).status, 200);
  assert.equal((await read(_id)).status, 'Positive');
  for (const badge of ['Proposal Sent', 'Won', 'New']) {
    assert.equal((await send(path, { action: 'followUp', note: 'x', badge })).status, 400, badge);
  }
  assert.equal((await read(_id)).status, 'Positive');
});

test('an old Proposal Sent follow-up can be edited, but not chosen on another one', async () => {
  const created = await lead('Contacted', { followUps: [{ note: 'Old', badge: 'Proposal Sent' }, { note: 'Newer', badge: 'Contacted' }] });
  const [old, newer] = created.followUps;
  const path = `/admin/leads/${created._id}`;
  assert.equal((await send(path, { action: 'editFollowUp', followUpId: String(old._id), badge: 'Proposal Sent', note: 'Edited' })).status, 200);
  assert.equal((await read(created._id)).followUps[0].note, 'Edited');
  assert.equal((await send(path, { action: 'editFollowUp', followUpId: String(newer._id), badge: 'Proposal Sent', note: 'x' })).status, 400);
});

test('a lead with an email gets a reviewed email; its WhatsApp copy goes only after Send', async () => {
  const { _id } = await lead('Contacted', { email: 'ravi@example.test' });
  const { body } = await propose(_id, { amount: '25000' });
  assert.equal(body.emailStatus, 'awaiting-review');
  assert.equal(body.emailDraftIds.length, 1);
  assert.equal(body.data.whatsappPreview, null);
  assert.equal(await Queue.countDocuments(), 0);
  const draft = await EmailDraft.findById(body.emailDraftIds[0]).lean();
  assert.equal(draft.event, 'lead.proposal');
  assert.match(draft.plain, /₹25,000/);
  assert.match(draft.plain, /https:\/\/drive\.example\.test\/drive-proposal\.pdf/);

  await decide(String(draft._id), admin._id, { choice: 'send', subject: draft.subject, text: draft.text }, { application: 'portal', portalAdmin: true });
  for (const end = Date.now() + 2000; Date.now() < end && !(await Queue.countDocuments()); await new Promise(r => setTimeout(r, 25)));
  const rows = await Queue.find().lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].to, '919876543210');
});

test('a phone-only lead is reviewed first, then goes to the queue once, with the link and amount', async () => {
  const { _id } = await lead();
  const { body } = await propose(_id, { amount: '25000' });
  const preview = body.data.whatsappPreview;
  assert.equal(body.emailDraftIds, undefined);
  assert.equal(preview.channel, 'whatsapp');
  assert.deepEqual(preview.to, ['919876543210']);
  assert.ok(preview.doc);
  assert.equal(await Queue.countDocuments(), 0);

  const path = `/admin/leads/${_id}/proposal/1/whatsapp`;
  assert.equal((await json(path, { ...reviewed, text: preview.text, subject: preview.subject })).status, 200);
  const rows = await Queue.find().lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].to, '919876543210');
  assert.equal(rows[0].event, 'lead.proposal');
  assert.match(rows[0].text, /₹25,000/);
  assert.match(rows[0].text, /drive-proposal\.pdf/);
  assert.equal((await json(path, reviewed)).status, 409);
  assert.equal(await Queue.countDocuments(), 1);
});

test('the proposal link stays even if the reviewer removes it', async () => {
  const { _id } = await lead();
  await propose(_id);
  assert.equal((await json(`/admin/leads/${_id}/proposal/1/whatsapp`, { choice: 'send', subject: 'Hi', text: 'No link here' })).status, 200);
  assert.match((await Queue.findOne().lean()).text, /drive-proposal\.pdf/);
});

test('a message that fails to queue can be tried again', async () => {
  const { _id } = await lead();
  await propose(_id);
  const path = `/admin/leads/${_id}/proposal/1/whatsapp`;
  assert.equal((await json(path, { choice: 'send', subject: '', text: 'x' })).status, 400);
  assert.equal((await read(_id)).proposals[0].messageQueuedAt, null);
  assert.equal((await json(path, reviewed)).status, 200);
});

test('no preview when nothing can reach the lead, WhatsApp is off, or the action is Off; the proposal is still saved', async () => {
  const noPhone = await lead('Contacted', { phone: '12345' });
  assert.equal((await propose(noPhone._id)).body.data.whatsappPreview, null);
  assert.equal((await read(noPhone._id)).proposals.length, 1);
  assert.equal((await json(`/admin/leads/${noPhone._id}/proposal/1/whatsapp`, reviewed)).status, 400);

  process.env.ENABLE_WHATSAPP = 'false';
  const off = await lead();
  assert.equal((await propose(off._id)).body.data.whatsappPreview, null);
  assert.equal((await json(`/admin/leads/${off._id}/proposal/1/whatsapp`, reviewed)).status, 409);
  process.env.ENABLE_WHATSAPP = 'true';

  await EmailPolicy.create({ event: 'lead.proposal', mode: 'off' });
  const policyOff = await lead();
  assert.equal((await propose(policyOff._id)).body.data.whatsappPreview, null);
  assert.equal(await Queue.countDocuments(), 0);
});

test('the WhatsApp route is admin only and refuses a lead with an email', async () => {
  const { _id } = await lead('Contacted', { email: 'ravi@example.test' });
  await propose(_id);
  assert.equal((await json(`/admin/leads/${_id}/proposal/1/whatsapp`, reviewed)).status, 409);
  const response = await nativeFetch(`${base}/admin/leads/${_id}/proposal/1/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-role': 'customer' }, body: JSON.stringify(reviewed) });
  assert.equal(response.status, 403);
});

test('a new client gets a Won lead: a new one, or their own open lead', async () => {
  const fresh = await userModel.create({ name: 'Fresh', email: 'fresh@example.test', phone: '9000000001', roles: ['customer'] });
  const created = await ensureWonLead(fresh, admin._id);
  assert.equal(created.status, 'Won');
  assert.equal(String(created.convertedToUserId), String(fresh._id));
  assert.equal(String((await ensureWonLead(fresh))._id), String(created._id), 'a second call changes nothing');
  assert.equal(await leadModel.countDocuments({ convertedToUserId: fresh._id }), 1);

  const open = await lead('Positive', { phone: '+91 90000 00002' });
  const matched = await userModel.create({ name: 'Match', email: 'match@example.test', phone: '9000000002', roles: ['customer'] });
  assert.equal(String((await ensureWonLead(matched))._id), String(open._id));
  const row = await read(open._id);
  assert.equal(row.status, 'Won');
  assert.equal(String(row.convertedToUserId), String(matched._id));

  const member = await userModel.create({ name: 'Member', email: 'member@example.test', roles: ['member'] });
  assert.equal(await ensureWonLead(member), null);
  const guest = await userModel.create({ name: 'Guest', email: 'guest@example.test', roles: ['customer'], isGuest: true });
  assert.equal(await ensureWonLead(guest), null);
});

test('granting the customer role adds the Won lead; other roles do not', async () => {
  const user = await userModel.create({ name: 'New', email: 'new@example.test', phone: '9000000003', roles: ['member'] });
  assert.equal((await json('/addRole', { userId: user._id, role: 'partner' })).status, 200);
  assert.equal(await leadModel.countDocuments({ convertedToUserId: user._id }), 0);
  assert.equal((await json('/addRole', { userId: user._id, role: 'customer' })).status, 200);
  assert.equal((await leadModel.findOne({ convertedToUserId: user._id }).lean()).status, 'Won');
});

test('the backfill counts first, creates only missing leads, never links, and can run again', async () => {
  const linked = await userModel.create({ name: 'Linked', email: 'linked@example.test', roles: ['customer'] });
  await lead('Won', { convertedToUserId: linked._id, email: linked.email });
  await userModel.create({ name: 'Unlinked', email: 'unlinked@example.test', roles: ['customer'] });
  await lead('Won', { email: 'unlinked@example.test', phone: '9000000004' });
  await userModel.create({ name: 'Open', email: 'open@example.test', roles: ['customer'] });
  await lead('Contacted', { email: 'open@example.test', phone: '9000000005' });
  const none = await userModel.create({ name: 'None', email: 'none@example.test', roles: ['customer'] });

  const expected = { clients: 4, linked: 1, wonNotLinked: 1, matchesAnOpenLead: 1, toCreate: 1 };
  const dry = await backfillWonLeads();
  assert.deepEqual({ ...dry, created: undefined }, { ...expected, created: undefined });
  assert.equal(dry.created, 0);
  assert.equal(await leadModel.countDocuments({ convertedToUserId: none._id }), 0);

  const applied = await backfillWonLeads({ apply: true });
  assert.equal(applied.created, 1);
  assert.equal((await leadModel.findOne({ convertedToUserId: none._id }).lean()).status, 'Won');
  assert.equal(await leadModel.countDocuments({ email: 'unlinked@example.test', convertedToUserId: null }), 1);
  assert.equal((await leadModel.findOne({ email: 'open@example.test' }).lean()).status, 'Contacted');
  assert.equal((await backfillWonLeads({ apply: true })).created, 0);
});
