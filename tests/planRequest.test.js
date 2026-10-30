// Website plan page → "Get this plan" by a non-client (controller/lead/planRequest.js): the choice is
// re-quoted, one lead per person gets the request (follow-up on repeats), and the two mails send only
// while their action is On. Isolated: in-memory MongoDB; only the mail provider is mocked.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { requestMiddleware } = require('../helpers/emailController');
const { EmailDraft, EmailPolicy } = require('../models/emailControlModel');
const userModel = require('../models/userModel');
const leadModel = require('../models/leadModel');
const Product = require('../models/productModel');
const authToken = require('../middleware/authToken');
const { memberPlanRequest, integrationPlanRequest, SOURCE, NOTE_TITLE, REPEAT_WINDOW_MS } = require('../controller/lead/planRequest');

const SECRET = 'x'.repeat(40);
const PLAN_ID = new mongoose.Types.ObjectId();
const nativeFetch = global.fetch;
let db, server, base, member, client, calls;
const cookie = (user) => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function send(path, method, body, headers = {}) {
  const response = await nativeFetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, ...await response.json() };
}
const CHOICE = { planId: String(PLAN_ID), purchase: 'quarterly', tenureMonths: 6, files: 20, updates: 2, releaseMode: 'monthly' };
const VISITOR = { name: ' Ravi  Kumar ', email: 'Ravi@Example.test', countryCode: '+91', phone: '98765 43210' };
const visitor = (body = {}, secret = SECRET) => send('/integration/plan-request', 'PATCH', { ...CHOICE, ...VISITOR, ...body }, { Authorization: `Bearer ${secret}` });
const asMember = (body = {}, user = member) => send('/plan-request', 'POST', { ...CHOICE, ...body }, { Cookie: cookie(user) });
const waitFor = async (check) => { for (let i = 0; i < 100 && !(await check()); i += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-plan-request-secret';
  process.env.PORTFOLIO_INTEGRATION_SECRET = SECRET;
  process.env.RESEND_API_KEY = 'not-a-real-provider-key';
  process.env.FROM_EMAIL = 'sender@example.test';
  process.env.ADMIN_DASHBOARD_URL = 'https://portal.example.test';
  db = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  await mongoose.connect(db.getUri(), { dbName: 'plan-request-isolated-test' });
  [member, client] = await userModel.create([
    { name: 'Meera Member', email: 'meera@example.test', phone: '+919811111111', roles: ['member'] },
    { name: 'Asha Client', email: 'asha@example.test', phone: '+919822222222', roles: ['customer'] },
  ]);
  // The flexible fixture of tests/servicePlanPricing.test.js, on sale.
  await Product.collection.insertOne({ _id: PLAN_ID, serviceName: 'Website Update · Flexible', category: 'service_plan', isServicePlan: true, price: 0, retiredAt: null, archivedAt: null,
    servicePlan: { categoryKey: 'website_updates', capability: 'upload_data', pricingMode: 'flexible', files: { min: 5, max: 100, step: 5 }, ratePerFile: 100,
      slabs: [{ fromFile: 11, ratePerFile: 50 }, { fromFile: 21, ratePerFile: 35 }], updatesPerMonth: { min: 1, max: 4 }, allowOneTime: true, maxTenureMonths: 12, customerCanChooseRelease: true,
      billingOptions: [{ billingCycle: 'monthly', discountPercent: 0 }, { billingCycle: 'quarterly', discountPercent: 5 }] } });
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails', 'Only the provider is mocked');
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 });
  };
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use(requestMiddleware);
  app.post('/plan-request', authToken, memberPlanRequest);
  app.patch('/integration/plan-request', integrationPlanRequest);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  calls = [];
  await Promise.all([leadModel.deleteMany({}), EmailDraft.deleteMany({}), EmailPolicy.deleteMany({})]);
  await userModel.updateOne({ _id: member._id }, { $set: { phone: '+919811111111' } });
});
after(async () => {
  global.fetch = nativeFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('a visitor request needs the website server key and becomes a New lead with the exact choice', async () => {
  assert.equal((await visitor({}, 'y'.repeat(40))).status, 401);
  const sent = await visitor();
  assert.equal(sent.status, 201);
  assert.equal(sent.data.repeated, false);
  const [lead] = await leadModel.find().lean();
  assert.equal(lead.source, SOURCE);
  assert.equal(lead.status, 'Contacted');
  assert.equal(lead.name, 'Ravi Kumar');
  assert.equal(lead.email, 'ravi@example.test');
  assert.equal(lead.phone, '+919876543210');
  assert.equal(lead.reservationUserId, undefined);
  for (const line of [NOTE_TITLE, 'Plan: Website Update · Flexible', 'Choice: 20 files × 2 updates a month, every 3 months for 6 months, updates open month by month', 'Price shown: ₹', '2 payments', 'Not signed in']) {
    assert.ok(lead.notes.includes(line), line);
  }
});

test('the choice is re-quoted: anything the plan does not offer, or bad contact details, is refused', async () => {
  assert.equal((await visitor({ files: 22 })).status, 400);
  assert.equal((await visitor({ purchase: 'yearly' })).status, 400);
  assert.equal((await visitor({ planId: String(new mongoose.Types.ObjectId()) })).status, 404);
  assert.equal((await visitor({ phone: '12345' })).status, 400);
  assert.equal((await visitor({ email: 'not-an-email' })).status, 400);
  assert.equal((await visitor({ name: ' ' })).status, 400);
  assert.equal(await leadModel.countDocuments(), 0);
});

test('one open lead per phone: a quick repeat changes nothing, a later request is a follow-up', async () => {
  await visitor();
  assert.equal((await visitor()).data.repeated, true);
  let lead = await leadModel.findOne().lean();
  assert.equal(lead.followUps.length, 0);
  await leadModel.collection.updateOne({ _id: lead._id }, { $set: { createdAt: new Date(Date.now() - REPEAT_WINDOW_MS - 1000) } });
  const later = await visitor({ purchase: 'one_time', tenureMonths: undefined, releaseMode: undefined, files: 40, updates: 1 });
  assert.equal(later.status, 200);
  assert.equal(later.data.repeated, false);
  assert.equal(await leadModel.countDocuments(), 1);
  lead = await leadModel.findOne().lean();
  assert.equal(lead.followUps.length, 1);
  assert.ok(lead.followUps[0].note.includes('Choice: 40 files × 1 update, one-time'));
  // A closed lead is not reused.
  await leadModel.updateOne({ _id: lead._id }, { $set: { status: 'Negative' } });
  await visitor();
  assert.equal(await leadModel.countDocuments(), 2);
});

test('a member request uses the account: its own lead, the offer-reservation lead reused, clients refused', async () => {
  assert.equal((await send('/plan-request', 'POST', CHOICE)).status, 401);
  assert.equal((await asMember({}, client)).status, 409);
  // The member already has a lead from an offer reservation: the request is added to it.
  const offerLead = await leadModel.create({ name: 'Meera Member', email: 'meera@example.test', phone: '+919811111111', source: 'Offer reservation', reservationUserId: member._id });
  await leadModel.collection.updateOne({ _id: offerLead._id }, { $set: { createdAt: new Date(Date.now() - REPEAT_WINDOW_MS - 1000) } });
  const sent = await asMember();
  assert.equal(sent.status, 200);
  const [lead] = await leadModel.find().lean();
  assert.equal(lead.source, 'Offer reservation');
  assert.equal(lead.followUps.length, 1);
  assert.equal(String(lead.followUps[0].createdBy), String(member._id));
  assert.ok(lead.followUps[0].note.includes(`Website account: meera@example.test (${member._id})`));
  assert.equal((await asMember()).data.repeated, true);
  // A lead the team moved to Trash is not silently reused.
  await leadModel.updateOne({ _id: lead._id }, { $set: { deletedAt: new Date() } });
  assert.equal((await asMember()).status, 409);
});

test('someone who wrote on WhatsApp: their Inquiry becomes the real lead, and a just-made one does not swallow the request', async () => {
  const inquiry = await leadModel.create({ phone: '+919876543210', status: 'Inquiry', source: 'WhatsApp ad' });
  const sent = await visitor();
  assert.equal(sent.status, 200);
  assert.equal(sent.data.repeated, false);
  assert.equal(await leadModel.countDocuments(), 1);
  const lead = await leadModel.findById(inquiry._id).lean();
  assert.equal(lead.status, 'Contacted');
  assert.equal(lead.name, 'Ravi Kumar');
  assert.equal(lead.email, 'ravi@example.test');
  assert.equal(lead.source, 'WhatsApp ad');
  assert.equal(lead.followUps.length, 1);
  assert.ok(lead.followUps[0].note.startsWith(NOTE_TITLE));
});

test('a member who wrote on WhatsApp: the Inquiry becomes their account\'s lead', async () => {
  const inquiry = await leadModel.create({ phone: '9811111111', status: 'Inquiry', source: 'WhatsApp ad' });
  const sent = await asMember();
  assert.equal(sent.status, 200);
  assert.equal(await leadModel.countDocuments(), 1);
  const lead = await leadModel.findById(inquiry._id).lean();
  assert.equal(lead.status, 'Contacted');
  assert.equal(lead.name, 'Meera Member');
  assert.equal(String(lead.reservationUserId), String(member._id));
  assert.equal(lead.followUps.length, 1);
  assert.equal((await asMember()).status, 200, 'the next request finds it by the account');
  assert.equal(await leadModel.countDocuments(), 1);
});

test('a member without a phone adds it once; without a lead one is created for the account', async () => {
  await userModel.updateOne({ _id: member._id }, { $set: { phone: '' } });
  assert.equal((await asMember()).status, 428);
  assert.equal((await asMember({ countryCode: '+91', phone: '98111 33333' })).status, 201);
  assert.equal((await userModel.findById(member._id).lean()).phone, '+919811133333');
  const [lead] = await leadModel.find().lean();
  assert.equal(lead.source, SOURCE);
  assert.equal(String(lead.reservationUserId), String(member._id));
  assert.equal(lead.phone, '+919811133333');
});

test('both mails are Off until an admin turns them On; then they send to the team and the requester', async () => {
  await visitor();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await EmailDraft.countDocuments(), 0);
  assert.equal(calls.length, 0);

  await leadModel.deleteMany({});
  await EmailPolicy.create([{ event: 'plan.request.admin', mode: 'auto' }, { event: 'plan.request.received', mode: 'auto' }]);
  await visitor();
  await waitFor(async () => calls.length === 2);
  const admin = calls.find((mail) => mail.subject.startsWith('New plan request'));
  const received = calls.find((mail) => mail.subject.startsWith('We have received your request'));
  assert.deepEqual(admin.to, ['vacomputers.com@gmail.com', 'syncvap@gmail.com']);
  const lead = await leadModel.findOne().lean();
  assert.ok(admin.text.includes(`https://portal.example.test/admin-panel/leads/${lead._id}`));
  assert.ok(admin.text.includes('+919876543210'));
  assert.deepEqual(received.to, ['ravi@example.test']);
  assert.ok(received.text.includes('20 files × 2 updates a month'));
  // A quick repeat sends nothing again.
  await visitor();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, 2);
});
