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
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { requestMiddleware } = require('../helpers/emailController');
const userModel = require('../models/userModel');
const orderModel = require('../models/orderProductModel');
const invoiceModel = require('../models/invoiceModel');
const CategoryModel = require('../models/categoryBasePriceModel');
const authToken = require('../middleware/authToken');
const { listProjectCategories, requireCategoryForNewProject } = require('../helpers/projectCategories');
const { savePackage } = require('../helpers/salesPackages');
const { STARTER_PACKAGES } = require('./fixtures/salesPackages');

let db, server, base, admin, customer, app;
const cookie = (user) => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function call(path, { user = admin, body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie(user) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const save = (body) => call('/admin/category-base-prices', { body });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-project-categories-secret';
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60000 }] });
  await mongoose.connect(db.getUri(), { dbName: 'project-categories-isolated-test' });
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
  ]);
  app = express(); app.use(express.json()); app.use(cookieParser()); app.use(requestMiddleware);
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
  const item = { ...STARTER_PACKAGES[0], id: 'seo-pack', category: 'seo_services', offerSlug: '' };
  await savePackage(item, true, []);
  await save({ category: 'seo_services', status: 'archived' });
  await assert.rejects(savePackage({ ...item, name: 'Renamed' }, false, []), /active project category/);
  await savePackage({ ...item, status: 'archived' }, false, []);
  await assert.rejects(savePackage({ ...item, id: 'unknown-cat', category: 'not_a_category' }, true, []), /active project category/);
});

// Opt-in like the sales browser test: the real Project Categories page against this isolated backend.
if (process.env.TEST_SALES_BROWSER === '1') test('Project Categories page: list, create, locked rules and archive in the browser', { timeout: 120000 }, async () => {
  const fs = require('node:fs'); const os = require('node:os');
  const { build } = require('../../merasoftware/node_modules/esbuild');
  const { chromium } = require('../../merasoftware/node_modules/playwright');
  const frontend = path.resolve(__dirname, '../../frontend/src');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mera-categories-browser-'));
  const fixtureApi = { categoryBasePrices: { url: `${base}/admin/category-base-prices`, method: 'get' }, updateCategoryBasePrice: { url: `${base}/admin/category-base-prices`, method: 'post' }, logout_user: { url: `${base}/logout`, method: 'get' } };
  // Only the app shell is stubbed (layout, redux, router, session utils); the page, hook and APIs are real.
  const stubs = {
    common: `export default ${JSON.stringify(fixtureApi)};`,
    layout: 'export default ({ children }) => children;',
    redux: 'export const useSelector = () => null; export const useDispatch = () => () => {};',
    router: 'export const useNavigate = () => () => {};',
    slice: 'export const logout = () => ({ type: "logout" });',
    util: 'export default { clearAll() {}, clearUserData() {} };',
  };
  const routes = [[/^\.\.\/common$/, 'common'], [/AdminLayout$/, 'layout'], [/^react-redux$/, 'redux'], [/^react-router-dom$/, 'router'], [/userSlice$/, 'slice'], [/(cookieManager|storageService)$/, 'util']];
  const shell = { name: 'shell-stubs', setup(b) {
    for (const [filter, name] of routes) b.onResolve({ filter }, () => ({ path: name, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: frontend }));
  } };
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import Page from './pages/AdminCategoryBasePricePage';createRoot(document.getElementById('app')).render(<Page/>);`;
  await build({ stdin: { contents: entry, loader: 'jsx', resolveDir: frontend }, bundle: true, loader: { '.js': 'jsx' }, outfile: path.join(folder, 'page.js'), platform: 'browser', jsx: 'automatic', plugins: [shell] });
  // The portal's own Tailwind (react-scripts' nested v3, same as the real build) so screenshots show the real layout.
  const tailwindBin = path.resolve(frontend, '../node_modules/react-scripts/node_modules/tailwindcss/lib/cli.js');
  await new Promise((resolve, reject) => execFile(process.execPath, [tailwindBin, '-c', path.resolve(frontend, '../tailwind.config.js'), '-i', path.join(frontend, 'index.css'), '--content', path.join(folder, 'page.js'), '-o', path.join(folder, 'page.css')], { cwd: path.resolve(frontend, '..') }, error => (error ? reject(error) : resolve())));
  // Served by the same isolated server as the API, so the admin cookie applies without CORS.
  app.get('/categories-page', (req, res) => res.send('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/categories-page.css"></head><body><main id="app"></main><script src="/categories-page.js"></script></body></html>'));
  app.get('/categories-page.css', (req, res) => res.sendFile(path.join(folder, 'page.css')));
  app.get('/categories-page.js', (req, res) => res.sendFile(path.join(folder, 'page.js')));
  await save({ category: 'standard_websites', basePrice: 2500 });
  await save({ category: 'dynamic_websites', basePrice: 15000 });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies([{ name: 'token', value: cookie(admin).slice(6), url: base }]);
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/categories-page`);
    await page.getByText('standard_websites', { exact: true }).waitFor();
    assert.equal(await page.getByText('Not configured', { exact: true }).count(), 2, 'cloud and app have no stored price');

    // Create: the key follows the name, and a new category starts admin-only.
    await page.getByRole('button', { name: 'Add Category' }).click();
    await page.getByLabel('Category name').fill('SEO Services');
    assert.equal(await page.getByLabel('Key').inputValue(), 'seo_services');
    await page.getByLabel('Base price (₹)').fill('5000');
    await page.getByLabel('Starting node title').fill('SEO audit started');
    await page.getByRole('button', { name: 'Create category' }).click();
    await page.getByText('seo_services', { exact: true }).waitFor();
    const created = await CategoryModel.findOne({ category: 'seo_services' }).lean();
    assert.deepEqual([created.label, created.basePrice, created.customerSelectable, created.status, created.startingNodeTitle], ['SEO Services', 5000, false, 'active', 'SEO audit started']);

    // Locked categories cannot be archived or hidden from customers; the key is read-only on edit.
    await page.getByText('standard_websites', { exact: true }).click();
    assert.equal(await page.getByLabel('Status').isDisabled(), true);
    assert.equal(await page.getByLabel('Key').isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Archive an unlocked category: it disappears until "Show archived" is ticked.
    await page.getByText('cloud_software_development', { exact: true }).click();
    await page.getByLabel('Status').selectOption('archived');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('cloud_software_development', { exact: true }).waitFor({ state: 'detached' });
    await page.getByText('Show archived (1)').click();
    await page.getByText('cloud_software_development', { exact: true }).waitFor();
    assert.equal((await CategoryModel.findOne({ category: 'cloud_software_development' }).lean()).status, 'archived');
    for (const width of [390, 1280]) { await page.setViewportSize({ width, height: 900 }); await page.screenshot({ path: path.join(folder, `categories-${width}.png`), fullPage: true }); }
    assert.deepEqual(errors, []);
    console.log(`Categories browser evidence: ${folder}`);
  } finally {
    if (browser) await browser.close();
  }
});

test('label backfill: dry run writes nothing; apply fills only missing labels and keeps updatedAt', async () => {
  const script = path.join(__dirname, '../scripts/backfillProjectCategoryLabels.js');
  const run = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [script, ...args], { env: { ...process.env, MONGODB_URI: db.getUri('project-categories-isolated-test') } }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
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
