// Inquiry leads: a number with no name, added by WhatsApp Auto Reply. Every path that touches a lead's name or
// status must cope with one. Isolated: in-memory MongoDB; controllers run directly; no mail or WhatsApp goes out.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Lead = require('../models/leadModel');
const User = require('../models/userModel');
const updateLead = require('../controller/lead/updateLead');
const createLead = require('../controller/lead/createLead');
const convertLead = require('../controller/lead/convertLead');
const uploadProposal = require('../controller/lead/uploadProposal');
const { ensureWonLead } = require('../helpers/wonLead');
const { claimInquiryLead, findLeadsByPhone, isKnownPerson } = require('../helpers/leadPhone');

let db, admin;
const PHONE = '+919876543210';
const inquiry = (fields = {}) => Lead.create({ phone: PHONE, status: 'Inquiry', source: 'WhatsApp ad', inquiry: { message: 'Hello! Can I get more info on this?', profileName: 'Ravi' }, ...fields });
async function call(controller, { params = {}, body = {}, files } = {}) {
  let status = 200, payload;
  const res = { status(code) { status = code; return res; }, json(data) { payload = data; return res; } };
  await controller({ userRole: 'admin', userId: admin._id, params, body, files }, res);
  return { status, ...payload };
}
const update = (lead, body) => call(updateLead, { params: { leadId: String(lead._id) }, body });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-inquiry-secret';
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri(), { dbName: 'inquiry-lead-isolated' });
  admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
});
beforeEach(() => Promise.all([Lead.deleteMany({}), User.deleteMany({ _id: { $ne: admin._id } })]));
after(async () => { await mongoose.disconnect(); await db?.stop(); });

test('the model: no name is allowed only for Inquiry and Negative', async () => {
  const lead = await inquiry();
  assert.equal(lead.name, undefined);
  assert.equal((await Lead.create({ phone: '9000000001', status: 'Negative' })).status, 'Negative');
  await assert.rejects(Lead.create({ phone: '9000000002' }), /name/);
  for (const status of ['Contacted', 'Positive', 'Won']) await assert.rejects(Lead.create({ phone: '9000000003', status }), /name/);
  lead.status = 'Positive';
  await assert.rejects(lead.save(), /name/);
});

test('saving a name moves an Inquiry to Contacted; no other status moves', async () => {
  const lead = await inquiry();
  const saved = await update(lead, { action: 'editDetails', name: 'Ravi Kumar', phone: PHONE });
  assert.equal(saved.success, true);
  assert.equal(saved.data.status, 'Contacted');
  assert.equal(saved.data.name, 'Ravi Kumar');
  const positive = await Lead.create({ name: 'P', phone: '9000000004', status: 'Positive' });
  assert.equal((await update(positive, { action: 'editDetails', name: 'P2', phone: '9000000004' })).data.status, 'Positive');
  const negative = await Lead.create({ phone: '9000000005', status: 'Negative' });
  assert.equal((await update(negative, { action: 'editDetails', name: 'N', phone: '9000000005' })).data.status, 'Negative');
});

test('a name is still required when editing details', async () => {
  const lead = await inquiry();
  assert.equal((await update(lead, { action: 'editDetails', name: '  ', phone: PHONE })).status, 400);
  assert.equal((await Lead.findById(lead._id).lean()).status, 'Inquiry');
});

test('a follow-up: stays Inquiry or goes Negative with no name; anything else asks for the name', async () => {
  const lead = await inquiry();
  assert.equal((await update(lead, { action: 'followUp', badge: 'Inquiry', note: 'Called, no answer' })).data.status, 'Inquiry');
  for (const badge of ['Contacted', 'Positive']) {
    const refused = await update(lead, { action: 'followUp', badge, note: 'Note' });
    assert.equal(refused.status, 400, badge);
    assert.match(refused.message, /Add this lead's name first/, 'a clear message, not the database\'s');
  }
  assert.equal((await update(lead, { action: 'followUp', badge: 'Negative', note: 'Wrong number' })).data.status, 'Negative');
  const again = await update(lead, { action: 'followUp', badge: 'Positive', note: 'Changed mind' });
  assert.equal(again.status, 400, 'a nameless Negative can\'t move on either');
  assert.match(again.message, /Add this lead's name first/);
  assert.equal((await update(lead, { action: 'followUp', badge: 'Won', note: 'x' })).status, 400, 'Won can\'t be chosen');
});

test('editing a follow-up can\'t move a nameless lead forward either', async () => {
  const lead = await inquiry();
  const { data } = await update(lead, { action: 'followUp', badge: 'Inquiry', note: 'First' });
  const followUpId = String(data.followUps[0]._id);
  const refused = await update(lead, { action: 'editFollowUp', followUpId, badge: 'Positive', note: 'First' });
  assert.equal(refused.status, 400);
  assert.match(refused.message, /Add this lead's name first/);
  assert.equal((await update(lead, { action: 'editFollowUp', followUpId, badge: 'Inquiry', note: 'Only the note' })).status, 200);
});

test('the same number in another form counts as the same person', async () => {
  await inquiry();
  for (const phone of ['9876543210', '09876543210', '+91 98765 43210', '919876543210', '98765-43210']) {
    assert.equal((await findLeadsByPhone(phone)).length, 1, phone);
    assert.equal(await isKnownPerson(phone), true, phone);
  }
  assert.equal(await isKnownPerson('9876543211'), false);
  assert.equal((await findLeadsByPhone('12345')).length, 0);
});

test('known people: trashed leads and accounts count', async () => {
  await Lead.create({ name: 'Old', phone: '9111111111', deletedAt: new Date() });
  await User.create({ name: 'Client', email: 'client@example.test', phone: '+91 92222 22222', roles: ['customer'] });
  assert.equal(await isKnownPerson('919111111111'), true);
  assert.equal(await isKnownPerson('919222222222'), true);
  assert.equal(await isKnownPerson('919333333333'), false);
});

test('adding a lead by hand finds the Inquiry in any number form', async () => {
  await inquiry();
  const refused = await call(createLead, { body: { name: 'Ravi', phone: '98765 43210' } });
  assert.equal(refused.status, 409);
  assert.equal(await Lead.countDocuments(), 1);
});

test('editing another lead to this number is refused, in any form', async () => {
  await inquiry();
  const other = await Lead.create({ name: 'Other', phone: '9000000006' });
  assert.equal((await update(other, { action: 'editDetails', name: 'Other', phone: '98765 43210' })).status, 409);
  const lead = await Lead.findOne({ phone: PHONE });
  assert.equal((await update(lead, { action: 'editDetails', name: 'Same number', phone: '9876543210' })).status, 200, 'its own number is fine');
});

test('a nameless lead becoming a client gets the account\'s name, and its Won lead', async () => {
  for (const status of ['Inquiry', 'Negative']) {
    await Lead.deleteMany({});
    const lead = await inquiry({ status });
    const user = await User.create({ name: 'Ravi Client', email: `ravi-${status}@example.test`, phone: '98765 43210', roles: ['customer'] });
    const won = await ensureWonLead(user);
    assert.equal(String(won._id), String(lead._id));
    assert.equal(won.status, 'Won');
    assert.equal(won.name, 'Ravi Client');
  }
});

test('converting needs a name first, and nothing is created when it is missing', async () => {
  const lead = await inquiry({ email: 'ravi@example.test' });
  const before = await User.countDocuments();
  const refused = await call(convertLead, { params: { leadId: String(lead._id) } });
  assert.equal(refused.status, 400);
  assert.match(refused.message, /name/);
  assert.equal(await User.countDocuments(), before);
  assert.equal((await Lead.findById(lead._id).lean()).status, 'Inquiry');
});

test('a proposal needs a name first', async () => {
  const lead = await inquiry();
  const refused = await call(uploadProposal, { params: { leadId: String(lead._id) }, files: [{ buffer: Buffer.from('x') }] });
  assert.equal(refused.status, 400);
  assert.match(refused.message, /name/);
});

test('someone who gives their details elsewhere: their Inquiry becomes the real lead', async () => {
  const lead = await inquiry();
  const claimed = await claimInquiryLead('98765 43210', { name: 'Ravi', email: 'ravi@example.test' });
  assert.equal(String(claimed._id), String(lead._id));
  assert.equal(claimed.status, 'Contacted');
  assert.equal(claimed.name, 'Ravi');
  assert.equal(claimed.email, 'ravi@example.test');
  assert.equal(await claimInquiryLead(PHONE, { name: 'Again' }), null, 'no Inquiry left to claim');
  await Lead.deleteMany({});
  await inquiry({ deletedAt: new Date() });
  assert.equal(await claimInquiryLead(PHONE, { name: 'Trash' }), null, 'a trashed one stays trashed');
});
