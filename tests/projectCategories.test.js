// Project Categories SSOT (helpers/projectCategories.js): admin create/edit/archive, built-in
// defaults and locks, the customer rule, both creation paths, packages and the label backfill.
// Isolated: in-memory MongoDB; the website is never contacted.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { requestMiddleware } = require('../helpers/emailController');
const userModel = require('../models/userModel');
const orderModel = require('../models/orderProductModel');
const invoiceModel = require('../models/invoiceModel');
const CategoryModel = require('../models/categoryBasePriceModel');
const authToken = require('../middleware/authToken');
const { listProjectCategories, requireCategoryForNewProject } = require('../helpers/projectCategories');
const { savePackage, DEFAULT_PACKAGES } = require('../helpers/salesPackages');

let db, server, base, admin, customer;
const cookie = (user) => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function call(path, { user = admin, body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie(user) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const save = (body) => call('/admin/category-base-prices', { body });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-project-categories-secret';
  db = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  await mongoose.connect(db.getUri(), { dbName: 'project-categories-isolated-test' });
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
  ]);
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use(requestMiddleware);
  app.get('/admin/category-base-prices', authToken, require('../controller/admin/getCategoryBasePrices'));
  app.post('/admin/category-base-prices', authToken, require('../controller/admin/updateCategoryBasePrice'));
  app.get('/customer/project-categories', authToken, require('../controller/order/getCustomerProjectCategories'));
  app.get('/customer/category-base-price', authToken, require('../controller/order/getCustomerCategoryBasePrice'));
  app.post('/customer/custom-project-order', authToken, require('../controller/order/customerCreateCustomProjectOrder'));
  app.post('/admin/clients/:customerId/create-project', authToken, require('../controller/order/adminCreateProjectOrder'));
  await CategoryModel.syncIndexes();
  await orderModel.syncIndexes();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await Promise.all([CategoryModel.deleteMany({}), orderModel.deleteMany({}), invoiceModel.deleteMany({}), require('../models/salesCatalogueModel').deleteMany({})]);
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('built-in categories exist without stored rows; pre-SSOT rows get their defaults', async () => {
  let list = await listProjectCategories();
  assert.deepEqual(list.map(row => [row.category, row.label, row.configured, row.locked, row.customerSelectable]), [
    ['standard_websites', 'Standard Website', false, true, true],
    ['dynamic_websites', 'Dynamic Website', false, true, true],
    ['cloud_software_development', 'Cloud Software', false, false, true],
    ['app_development', 'App Development', false, false, true],
  ]);
  // A row saved by the old page has only these four fields.
  await CategoryModel.collection.insertOne({ category: 'app_development', basePrice: 60000, description: '', startingNodeTitle: '' });
  list = await listProjectCategories();
  const app = list.find(row => row.category === 'app_development');
  assert.deepEqual([app.label, app.basePrice, app.status, app.customerSelectable], ['App Development', 60000, 'active', true]);
});

test('admin creates a category; key, reserved keys, duplicates and permissions are enforced', async () => {
  assert.equal((await save({ creating: true, category: 'Bad Key', label: 'X' })).status, 400);
  assert.equal((await save({ creating: true, category: 'service_plan', label: 'X' })).status, 400);
  assert.equal((await save({ creating: true, category: 'seo_services' })).status, 400, 'name is required');
  assert.equal((await save({ creating: true, category: 'standard_websites', label: 'Again' })).status, 409);
  assert.equal((await save({ category: 'unknown_key', basePrice: 10 })).status, 404);
  assert.equal((await save({ creating: true, category: 'seo_services', label: 'SEO', basePrice: 10.555 })).status, 400);
  assert.equal((await call('/admin/category-base-prices', { user: customer, body: { creating: true, category: 'seo_services', label: 'SEO' } })).status, 403);

  const created = await save({ creating: true, category: 'seo_services', label: '  SEO Services ', basePrice: 5000, sortOrder: 4 });
  assert.equal(created.status, 200, created.message);
  assert.deepEqual([created.data.label, created.data.status, created.data.customerSelectable, created.data.configured], ['SEO Services', 'active', false, true]);
  assert.equal((await save({ creating: true, category: 'seo_services', label: 'Twice' })).status, 409);
  const stored = await CategoryModel.findOne({ category: 'seo_services' }).lean();
  assert.equal(String(stored.updatedBy), String(admin._id));
  const listed = await call('/admin/category-base-prices');
  assert.equal(listed.data.at(-1).category, 'seo_services');
  assert.deepEqual(listed.data.at(-1).usage, { projects: 0, features: 0, packages: 0 });
});

test('the old page save (price/description/node only) still works and keeps the other fields', async () => {
  await save({ creating: true, category: 'seo_services', label: 'SEO Services', basePrice: 5000 });
  const result = await save({ category: 'seo_services', basePrice: 6000, description: 'Search work', startingNodeTitle: 'Audit' });
  assert.equal(result.status, 200, result.message);
  assert.deepEqual([result.data.label, result.data.basePrice, result.data.startingNodeTitle], ['SEO Services', 6000, 'Audit']);
  const builtIn = await save({ category: 'cloud_software_development', basePrice: 25000, description: '', startingNodeTitle: '' });
  assert.equal(builtIn.status, 200, builtIn.message);
  assert.equal(builtIn.data.label, 'Cloud Software');
});

test('locked questionnaire categories stay active, customer-facing and priced; others can be archived', async () => {
  await save({ category: 'standard_websites', basePrice: 2500 });
  for (const patch of [{ status: 'archived' }, { customerSelectable: false }, { basePrice: null }]) {
    assert.equal((await save({ category: 'standard_websites', ...patch })).status, 400, JSON.stringify(patch));
  }
  assert.equal((await save({ category: 'standard_websites', label: 'Static Website' })).status, 200, 'renaming is allowed');
  assert.equal((await save({ category: 'app_development', status: 'archived' })).status, 200);
  await assert.rejects(requireCategoryForNewProject('app_development'), /unavailable/);
});

test('customer rule: only active, customer-selectable and priced categories', async () => {
  await save({ category: 'standard_websites', basePrice: 2500 });
  await save({ creating: true, category: 'seo_services', label: 'SEO Services', basePrice: 5000 });
  const list = await call('/customer/project-categories', { user: customer });
  assert.deepEqual(list.data.map(row => row.category), ['standard_websites'], 'unpriced built-ins and admin-only categories are hidden');
  assert.equal((await call('/customer/category-base-price?category=seo_services', { user: customer })).status, 400);
  assert.equal((await call('/customer/category-base-price?category=dynamic_websites', { user: customer })).status, 400, 'not configured');
  const priced = await call('/customer/category-base-price?category=standard_websites', { user: customer });
  assert.deepEqual(priced.data, { category: 'standard_websites', basePrice: 2500 });
  const refused = await call('/customer/custom-project-order', { user: customer, body: { category: 'seo_services', paymentType: 'decide_later' } });
  assert.equal(refused.status, 400);
  assert.equal(await orderModel.countDocuments(), 0);

  const ordered = await call('/customer/custom-project-order', { user: customer, body: { category: 'standard_websites', paymentType: 'decide_later' } });
  assert.equal(ordered.status, 201, ordered.message);
  const order = await orderModel.findOne().lean();
  assert.deepEqual([order.projectSnapshot.categoryLabel, order.projectSnapshot.displayName], ['Standard Website', 'Standard Website']);
});

test('admin project in a new category freezes its label and starting node; archived is refused', async () => {
  await save({ creating: true, category: 'seo_services', label: 'SEO Services', startingNodeTitle: 'SEO audit started' });
  const created = await call(`/admin/clients/${customer._id}/create-project`, { body: { category: 'seo_services', sellingPrice: 4000, paymentType: 'full' } });
  assert.equal(created.status, 201, created.message);
  const order = await orderModel.findById(created.data._id).lean();
  assert.equal(order.isWebsiteProject, true, 'a new category is still recognised as a project');
  assert.deepEqual([order.projectSnapshot.categoryLabel, order.projectSnapshot.displayName, order.projectSnapshot.startingNodeTitle, order.projectSnapshot.basePrice],
    ['SEO Services', 'SEO Services', 'SEO audit started', 0]);
  // A typed node title still wins over the category default.
  const typed = await call(`/admin/clients/${customer._id}/create-project`, { body: { category: 'seo_services', sellingPrice: 4000, paymentType: 'full', startingNodeTitle: 'Kickoff' } });
  assert.equal((await orderModel.findById(typed.data._id).lean()).projectSnapshot.startingNodeTitle, 'Kickoff');

  await save({ category: 'seo_services', label: 'Search Services' });
  assert.equal((await orderModel.findById(order._id).lean()).projectSnapshot.categoryLabel, 'SEO Services', 'a rename never relabels old work');
  await save({ category: 'seo_services', status: 'archived' });
  const refused = await call(`/admin/clients/${customer._id}/create-project`, { body: { category: 'seo_services', sellingPrice: 4000, paymentType: 'full' } });
  assert.equal(refused.status, 400);
  const listed = await call('/admin/category-base-prices');
  assert.equal(listed.data.find(row => row.category === 'seo_services').usage.projects, 2);
});

test('packages need an active category; an archived package may stay in an archived one', async () => {
  await save({ creating: true, category: 'seo_services', label: 'SEO Services' });
  const item = { ...DEFAULT_PACKAGES[0], id: 'seo-pack', category: 'seo_services', offerSlug: '' };
  await savePackage(item, true, []);
  await save({ category: 'seo_services', status: 'archived' });
  await assert.rejects(savePackage({ ...item, name: 'Renamed' }, false, []), /active project category/);
  await savePackage({ ...item, status: 'archived' }, false, []);
  await assert.rejects(savePackage({ ...item, id: 'unknown-cat', category: 'not_a_category' }, true, []), /active project category/);
});

test('label backfill: dry run writes nothing; apply fills only missing labels and keeps updatedAt', async () => {
  const script = path.join(__dirname, '../scripts/backfillProjectCategoryLabels.js');
  const run = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [script, ...args], { env: { ...process.env, MONGODB_URI: `${db.getUri()}project-categories-isolated-test` } }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
  const stamp = new Date('2026-01-01T00:00:00Z');
  await orderModel.collection.insertMany([
    { projectSnapshot: { category: 'standard_websites' }, updatedAt: stamp },
    { projectSnapshot: { category: 'dynamic_websites', categoryLabel: 'Kept' }, updatedAt: stamp },
    { projectSnapshot: { category: 'not_a_category' }, updatedAt: stamp },
    { isServicePlan: true, updatedAt: stamp },
  ]);
  const dry = await run();
  assert.match(dry, /DRY RUN/);
  assert.match(dry, /missing a category label: 2/);
  assert.equal(await orderModel.countDocuments({ 'projectSnapshot.categoryLabel': 'Standard Website' }), 0);
  const applied = await run('--apply');
  assert.match(applied, /Labels written: 1/);
  const rows = await orderModel.collection.find({}).toArray();
  assert.deepEqual(rows.map(row => row.projectSnapshot?.categoryLabel ?? null), ['Standard Website', 'Kept', null, null]);
  assert(rows.every(row => row.updatedAt.getTime() === stamp.getTime()));
});
