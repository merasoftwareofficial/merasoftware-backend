// Get a Service → Start a Project (controller/lead/customerProjectRequest.js): the category list,
// the callback request saved as a lead, one open request per client, and the convert guard.
// Isolated: in-memory MongoDB; nothing is sent anywhere.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const userModel = require('../models/userModel');
const leadModel = require('../models/leadModel');
const CategoryModel = require('../models/categoryBasePriceModel');
const authToken = require('../middleware/authToken');
const { getProjectRequestCategories, createProjectRequest, SOURCE, REPEAT_WINDOW_MS } = require('../controller/lead/customerProjectRequest');

let db, server, base, admin, customer;
const cookie = (user) => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function call(path, { user = customer, body } = {}) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie(user) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const ask = (body, user) => call('/customer/project-request', { body, user });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-project-request-secret';
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60000 }] });
  await mongoose.connect(db.getUri(), { dbName: 'project-request-isolated-test' });
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Asha Client', email: 'Asha@Example.test', phone: '9876543210', roles: ['customer'] },
  ]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.get('/customer/project-request/categories', authToken, getProjectRequestCategories);
  app.post('/customer/project-request', authToken, createProjectRequest);
  app.post('/admin/leads/:leadId/convert', authToken, require('../controller/lead/convertLead'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { await Promise.all([leadModel.deleteMany({}), CategoryModel.collection.deleteMany({})]); });
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('categories: active and opened to customers, price not needed; clients only', async () => {
  await CategoryModel.collection.insertOne({ category: 'app_development', customerSelectable: false });
  await CategoryModel.collection.insertOne({ category: 'cloud_software_development', status: 'archived' });
  const list = await call('/customer/project-request/categories');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.map((row) => row.category).sort(), ['dynamic_websites', 'standard_websites']);
  assert.equal(list.data.find((row) => row.category === 'standard_websites').label, 'Standard Website');
  assert.ok(!('basePrice' in list.data[0]));
  assert.equal((await call('/customer/project-request/categories', { user: admin })).status, 403);
});

test('a request becomes a New lead linked to the client, with readable notes', async () => {
  const sent = await ask({ category: 'dynamic_websites', phone: ' 98765 43210 ', budget: '30k_1l', start: 'within_month', callTime: 'evening', details: 'A site for my bakery' });
  assert.equal(sent.status, 201);
  const [lead] = await leadModel.find().lean();
  assert.equal(lead.source, SOURCE);
  assert.equal(lead.status, 'New');
  assert.equal(String(lead.requestedByUserId), String(customer._id));
  assert.equal(lead.convertedToUserId, null);
  assert.equal(lead.email, 'asha@example.test');
  assert.equal(lead.phone, '98765 43210');
  for (const text of ['Project type: Dynamic Website', 'Budget: ₹30,000 – ₹1 lakh', 'Start: Within a month', 'Best time to call: Evening', 'What they need: A site for my bakery', `account ${customer._id}`]) {
    assert.ok(lead.notes.includes(text), text);
  }
});

test('skip sends only the type and phone; bad input is refused', async () => {
  assert.equal((await ask({ category: 'nope', phone: '9876543210' })).status, 400);
  assert.equal((await ask({ category: 'standard_websites', phone: '12' })).status, 400);
  assert.equal((await ask({ category: 'standard_websites', phone: '9876543210', budget: 'lots' })).status, 400);
  assert.equal((await ask({ category: 'standard_websites', phone: '9876543210', details: 'x'.repeat(301) })).status, 400);
  assert.equal((await ask({ category: 'standard_websites', phone: '9876543210' }, admin)).status, 403);
  assert.equal(await leadModel.countDocuments(), 0);
  const sent = await ask({ category: 'standard_websites', phone: '9876543210', skipped: true, budget: 'ignored-when-skipped' });
  assert.equal(sent.status, 201);
  const lead = await leadModel.findOne().lean();
  assert.ok(lead.notes.includes('Questions skipped'));
  assert.ok(!lead.notes.includes('Budget'));
});

test('one open request per client: a quick repeat changes nothing, a later one is added as a follow-up', async () => {
  await ask({ category: 'standard_websites', phone: '9876543210' });
  const again = await ask({ category: 'standard_websites', phone: '9876543210' });
  assert.equal(again.status, 200);
  assert.equal(again.data.repeated, true);
  assert.equal(await leadModel.countDocuments(), 1);

  await leadModel.collection.updateOne({}, { $set: { createdAt: new Date(Date.now() - REPEAT_WINDOW_MS - 1000) } });
  const later = await ask({ category: 'dynamic_websites', phone: '9876543210', budget: 'not_sure' });
  assert.equal(later.status, 200);
  assert.equal(later.data.repeated, false);
  const [lead] = await leadModel.find().lean();
  assert.equal(lead.followUps.length, 1);
  assert.ok(lead.followUps[0].note.includes('Project type: Dynamic Website'));
  assert.equal(String(lead.followUps[0].createdBy), String(customer._id));

  // Once the team closes it, the next request opens a fresh lead.
  await leadModel.updateOne({}, { status: 'Won' });
  assert.equal((await ask({ category: 'standard_websites', phone: '9876543210' })).status, 201);
  assert.equal(await leadModel.countDocuments(), 2);
});

test('a portal request cannot be converted: the person is already a client', async () => {
  await ask({ category: 'standard_websites', phone: '9876543210' });
  const lead = await leadModel.findOne().lean();
  const convert = await call(`/admin/leads/${lead._id}/convert`, { user: admin, body: {} });
  assert.equal(convert.status, 409);
  assert.match(convert.message, /existing client/);
  assert.equal((await leadModel.findById(lead._id).lean()).convertedToUserId, null);
});
