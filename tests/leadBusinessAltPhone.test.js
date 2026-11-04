// Business name + alternate number on leads, the WhatsApp name guess, and editing a client's lead.
// Isolated: in-memory MongoDB (a replica set: client edits run in a transaction); controllers run
// directly; no mail or WhatsApp goes out.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Lead = require('../models/leadModel');
const User = require('../models/userModel');
const updateLead = require('../controller/lead/updateLead');
const createLead = require('../controller/lead/createLead');
const convertLead = require('../controller/lead/convertLead');
const globalSearch = require('../controller/lead/globalSearch');
const getAdminClients = require('../controller/user/getAdminClients');
const updateProfile = require('../controller/user/updateUserProfileController');
const updatePartnerCustomer = require('../controller/user/updatePartnerCustomer');
const getLeadDetail = require('../controller/lead/getLeadDetail');
const { guessFromProfileName } = require('../helpers/whatsappProfileName');
const { hasConfirmedName } = require('../helpers/leadName');
const { claimInquiryLead } = require('../helpers/leadPhone');

let db, admin;
async function call(controller, { params = {}, body = {}, query = {}, userId, userRole = 'admin' } = {}) {
  let status = 200, payload;
  const res = { status(code) { status = code; return res; }, json(data) { payload = data; return res; }, set() { return res; } };
  await controller({ userRole, userId: userId || admin._id, params, body, query }, res);
  return { status, ...payload };
}
const update = (lead, body) => call(updateLead, { params: { leadId: String(lead._id) }, body: { action: 'editDetails', ...body } });
const client = async (fields = {}) => {
  const user = await User.create({ name: 'Ravi Kumar', email: 'ravi@example.test', phone: '9876543210', roles: ['customer'], ...fields });
  const lead = await Lead.create({ name: user.name, email: user.email, phone: user.phone, status: 'Won', convertedToUserId: user._id, businessName: 'Ravi Traders' });
  return { user, lead };
};

before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(db.getUri(), { dbName: 'lead-business-altphone-isolated' });
  admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
  await Promise.all([Lead.init(), User.init()]);
});
beforeEach(() => Promise.all([Lead.deleteMany({}), User.deleteMany({ _id: { $ne: admin._id } })]));
after(async () => { await mongoose.disconnect(); await db?.stop(); });

test('the WhatsApp profile name fills a field only when it is clear', () => {
  const cases = [
    ['Rahul Sharma', { name: 'Rahul Sharma', businessName: '' }],
    ['Sharma Electronics', { name: '', businessName: 'Sharma Electronics' }],
    ['Rahul | Sharma Electronics', { name: 'Rahul', businessName: 'Sharma Electronics' }],
    ['Balaji Traders - Amit', { name: 'Amit', businessName: 'Balaji Traders' }],
    ['Rajesh (Shree Balaji Traders)', { name: 'Rajesh', businessName: 'Shree Balaji Traders' }],
    ['~ Preet ~ 😊', { name: 'Preet', businessName: '' }],
    ['😊', { name: '', businessName: '' }],
    ['Jai Mata Di', { name: '', businessName: '' }],
    ['Hi', { name: '', businessName: '' }],
    ['9876543210', { name: '', businessName: '' }],
    ['Good Morning', { name: '', businessName: '' }],
    ['Shree Ganesh Ji', { name: '', businessName: '' }],
    ['Rahul Official', { name: 'Rahul Official', businessName: '' }],
    ['Digital Rahul', { name: 'Digital Rahul', businessName: '' }],
    ['Amit-AK Mobiles', { name: 'Amit', businessName: 'AK Mobiles' }],
    ['Ram-Lal', { name: '', businessName: '' }],
    ['राहुल शर्मा', { name: 'राहुल शर्मा', businessName: '' }],
    ['', { name: '', businessName: '' }],
  ];
  for (const [profileName, expected] of cases) assert.deepEqual(guessFromProfileName(profileName), expected, profileName);
});

test('Add Lead saves the two optional fields and checks them', async () => {
  const saved = await call(createLead, { body: { name: 'Ravi', businessName: ' Ravi Traders ', phone: '9876543210', altPhone: '91234 56789' } });
  assert.equal(saved.status, 201);
  const lead = await Lead.findById(saved.data._id).lean();
  assert.equal(lead.businessName, 'Ravi Traders');
  assert.equal(lead.altPhone, '91234 56789');
  const plain = await call(createLead, { body: { name: 'Amit', phone: '9000000001' } });
  assert.equal(plain.status, 201);
  assert.equal((await Lead.findById(plain.data._id).lean()).businessName, '');
  const same = await call(createLead, { body: { name: 'Sam', phone: '9000000002', altPhone: '+91 90000 00002' } });
  assert.equal(same.status, 400);
  const badEmail = await call(createLead, { body: { name: 'Sam', phone: '9000000003', email: 'sam@' } });
  assert.equal(badEmail.status, 400);
});

test('a name guessed from WhatsApp keeps the lead Inquiry until the admin saves it', async () => {
  const lead = await Lead.create({ phone: '+919876543210', status: 'Inquiry', name: 'Ravi', nameFromWhatsapp: true, email: 'ravi@example.test' });
  assert.equal(hasConfirmedName(lead), false);
  const moved = await call(updateLead, { params: { leadId: String(lead._id) }, body: { action: 'followUp', badge: 'Positive', note: 'Called' } });
  assert.equal(moved.status, 400);
  assert.match(moved.message, /name first/);
  const converted = await call(convertLead, { params: { leadId: String(lead._id) } });
  assert.equal(converted.status, 400);
  assert.match(converted.message, /WhatsApp/);
  const saved = await update(lead, { name: 'Ravi Kumar', phone: '+919876543210', email: 'ravi@example.test' });
  assert.equal(saved.status, 200);
  const row = await Lead.findById(lead._id).lean();
  assert.equal(row.status, 'Contacted');
  assert.equal(row.nameFromWhatsapp, false);
});

test('a name the person gives on a form replaces the WhatsApp guess', async () => {
  await Lead.create({ phone: '+919876543210', status: 'Inquiry', name: 'Jai', nameFromWhatsapp: true });
  const lead = await claimInquiryLead('9876543210', { name: 'Ravi Kumar', email: 'ravi@example.test' });
  assert.equal(lead.name, 'Ravi Kumar');
  assert.equal(lead.nameFromWhatsapp, false);
  assert.equal(lead.status, 'Contacted');
});

test("a client's lead can be edited: name and phone reach the account, the email stays", async () => {
  const { user, lead } = await client();
  // The client's own project request holds the same phone and email: not a duplicate.
  await Lead.create({ name: user.name, email: user.email, phone: user.phone, requestedByUserId: user._id });
  const saved = await update(lead, { name: 'Ravi K', businessName: 'Ravi Traders Pvt Ltd', phone: '9811111111', altPhone: '9822222222', email: user.email });
  assert.equal(saved.status, 200, saved.message);
  const row = await Lead.findById(lead._id).lean();
  assert.equal(row.status, 'Won');
  assert.equal(row.businessName, 'Ravi Traders Pvt Ltd');
  assert.equal(row.altPhone, '9822222222');
  const account = await User.findById(user._id).lean();
  assert.equal(account.name, 'Ravi K');
  assert.equal(account.phone, '9811111111');
  assert.equal((await update(lead, { name: 'Ravi K', phone: '9811111111', email: 'other@example.test' })).status, 400);
  await User.create({ name: 'Other', email: 'other@example.test', phone: '9833333333', roles: ['customer'] });
  assert.equal((await update(lead, { name: 'Ravi K', phone: '98333 33333', email: user.email })).status, 409);
  assert.equal((await User.findById(user._id).lean()).phone, '9811111111');
});

test("a client's own Settings change reaches their lead", async () => {
  const { user, lead } = await client();
  const saved = await call(updateProfile, { userId: user._id, userRole: 'customer', body: { name: 'Ravi New', phone: '9844444444' } });
  assert.equal(saved.status, 200);
  const row = await Lead.findById(lead._id).lean();
  assert.equal(row.name, 'Ravi New');
  assert.equal(row.phone, '9844444444');
  assert.equal(row.businessName, 'Ravi Traders');
});

test('search finds people by business name and by any phone, ignoring spaces', async () => {
  const { user } = await client();
  await Lead.create({ name: 'Amit', phone: '90000 00001', altPhone: '9123456789', businessName: 'AK Mobiles', status: 'Contacted' });
  const search = async (q) => (await call(globalSearch, { query: { q } })).data;
  const byBusiness = await search('ravi traders');
  assert.deepEqual(byBusiness.map((row) => [row.type, String(row._id), row.businessName]), [['client', String(user._id), 'Ravi Traders']]);
  assert.equal((await search('ak mob'))[0].name, 'Amit');
  assert.equal((await search('9000000001'))[0].name, 'Amit');
  assert.equal((await search('91234 56789'))[0].name, 'Amit');
  assert.equal((await search('98765-43210'))[0].type, 'client');
  assert.equal((await search('+91 90000 00001'))[0].name, 'Amit');
  assert.equal((await search('09123456789'))[0].name, 'Amit');
  const clients = (await call(getAdminClients)).data;
  assert.equal(clients.find((row) => String(row._id) === String(user._id)).businessName, 'Ravi Traders');
});

test("a client's lead lists the account's own name, phone and email", async () => {
  const { user, lead } = await client();
  await User.updateOne({ _id: user._id }, { $set: { name: 'Ravi New', phone: '9000000009' } });
  const detail = await call(getLeadDetail, { params: { leadId: String(lead._id) } });
  assert.deepEqual(detail.data.client, { name: 'Ravi New', email: 'ravi@example.test', phone: '9000000009' });
});

test("editing a client whose lead is out of date never writes the old copy over the account", async () => {
  const { user, lead } = await client();
  // The client changed Settings before the sync existed: account and lead differ.
  await User.updateOne({ _id: user._id }, { $set: { name: 'Ravi New', phone: '9000000009', email: 'ravi.new@example.test' } });
  // Someone else's account now holds the lead's old number.
  await User.create({ name: 'Other', email: 'other@example.test', phone: '9876543210', roles: ['customer'] });
  // The form starts from the account; the admin only adds a business name.
  const saved = await update(lead, { name: 'Ravi New', phone: '9000000009', email: 'ravi.new@example.test', businessName: 'Ravi Traders Pvt Ltd' });
  assert.equal(saved.status, 200, saved.message);
  const account = await User.findById(user._id).lean();
  assert.deepEqual([account.name, account.phone, account.email], ['Ravi New', '9000000009', 'ravi.new@example.test']);
  const row = await Lead.findById(lead._id).lean();
  assert.deepEqual([row.name, row.phone, row.email, row.businessName], ['Ravi New', '9000000009', 'ravi.new@example.test', 'Ravi Traders Pvt Ltd']);
  // The old lead copy (another account's number now) is refused, as is the lead's old email.
  assert.equal((await update(lead, { name: 'Ravi New', phone: '9876543210', email: 'ravi.new@example.test' })).status, 409);
  assert.equal((await update(lead, { name: 'Ravi New', phone: '9000000009', email: 'ravi@example.test' })).status, 400);
  assert.equal((await User.findById(user._id).lean()).phone, '9000000009');
});

test("a partner's edit reaches the client's lead, email included", async () => {
  const partner = await User.create({ name: 'Partner', email: 'partner@example.test', roles: ['customer'] });
  const { user, lead } = await client({ referredBy: partner._id });
  const saved = await call(updatePartnerCustomer, { userId: partner._id, userRole: 'customer', params: { customerId: String(user._id) }, body: { name: 'Ravi P', email: 'ravi.p@example.test', phone: '9855555555' } });
  assert.equal(saved.status, 200, saved.message);
  const row = await Lead.findById(lead._id).lean();
  assert.deepEqual([row.name, row.email, row.phone], ['Ravi P', 'ravi.p@example.test', '9855555555']);
});
