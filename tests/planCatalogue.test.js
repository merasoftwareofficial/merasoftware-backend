// Plan catalogue SSOT (helpers/servicePlanCatalogue.js), Flexible Plans Phase 1 step P2c
// (merasoftware/src/docs/plan.md): validated create/edit through the website route and the older
// portal create route, B5 (/update-product refuses service plans), edits never touch orders.
// Isolated: in-memory MongoDB; the website is never contacted.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const userModel = require('../models/userModel');
const productModel = require('../models/productModel');
const orderModel = require('../models/orderProductModel');
const PlanCategory = require('../models/servicePlanCategoryModel');
const authToken = require('../middleware/authToken');

let db, server, base, admin, customer;
const cookie = (user) => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function call(path, { user = admin, body, method = body ? 'PATCH' : 'GET' } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie(user) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const save = (body, user) => call('/admin/plan-catalogue', { body, user });

const flexibleBody = (extra = {}) => ({
  creating: true, serviceName: 'Website Update · Flexible', categoryKey: 'website_updates', pricingMode: 'flexible',
  dependency: 'standalone_or_project', timing: 'during_and_after', capability: 'upload_data',
  files: { min: 5, max: 100, step: 5 }, ratePerFile: 100, slabs: [{ fromFile: 11, ratePerFile: 50 }, { fromFile: 21, ratePerFile: 35 }],
  updatesPerMonth: { min: 1, max: 4 }, allowOneTime: true, oneTimeValidityDays: 90, maxTenureMonths: 12,
  billingOptions: [{ billingCycle: 'monthly', discountPercent: 0 }, { billingCycle: 'quarterly', discountPercent: 5 }],
  description: 'Choose files and updates', isHidden: true, ...extra,
});
// Exactly what the portal AdminCreateServicePage.js sends for the live Starter Update Plan.
const portalStarterBody = {
  serviceName: 'Starter Update Plan', planType: 'website_updates', timing: 'after', dependency: 'project_required',
  capability: 'upload_data', visibility: 'visible', purchaseType: 'recurring', monthlyReferencePrice: 1490,
  billingOptions: [{ billingCycle: 'monthly', discountPercent: 0 }, { billingCycle: 'quarterly', discountPercent: 3 }, { billingCycle: 'yearly', discountPercent: 8 }],
  limitScope: 'per_month', portalAccessCount: 1, filesLimit: 20,
};

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-plan-catalogue-secret';
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60000 }] });
  await mongoose.connect(db.getUri(), { dbName: 'plan-catalogue-isolated-test' });
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
  ]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const catalogue = require('../controller/admin/planCatalogue');
  app.get('/admin/plan-catalogue', authToken, catalogue.listPlanCatalogueController);
  app.patch('/admin/plan-catalogue', authToken, catalogue.savePlanController);
  app.patch('/admin/plan-catalogue/quote', authToken, catalogue.quotePlanController);
  app.post('/admin/plans/:planId/reactivate', authToken, require('../controller/product/reactivatePlan'));
  app.post('/unhide-product', authToken, require('../controller/product/unhideProduct'));
  app.post('/admin/services/create', authToken, require('../controller/product/createServicePlan'));
  app.post('/update-product', authToken, require('../controller/product/updateProduct'));
  await PlanCategory.syncIndexes();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await Promise.all([PlanCategory.deleteMany({}), productModel.deleteMany({}), orderModel.deleteMany({})]);
  await PlanCategory.create([{ key: 'website_updates', label: 'Website Updates' }, { key: 'old_category', label: 'Old', status: 'archived' }]);
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('website creates a flexible plan; list shows its card range', async () => {
  const created = await save(flexibleBody());
  assert.equal(created.status, 200, created.message);
  const sp = created.data.servicePlan;
  assert.equal(sp.pricingMode, 'flexible');
  assert.equal(sp.categoryKey, 'website_updates');
  assert.equal(sp.purchaseType, 'recurring');
  assert.equal(created.data.price, 500); // cheapest start: one update at 5 files
  assert.equal(sp.billingOptions[0].pricePerCycle, undefined);

  const list = await call('/admin/plan-catalogue');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.plans[0].priceRange, { unit: 'update', from: 500, to: 4300 });
  assert.deepEqual(list.data.categories.map((c) => c.key), ['old_category', 'website_updates']);
});

test('invalid settings are refused and nothing is saved', async () => {
  const refuse = async (extra, pattern) => {
    const result = await save(flexibleBody(extra));
    assert.equal(result.status, 400, JSON.stringify(extra));
    assert.match(result.message, pattern);
  };
  await refuse({ categoryKey: undefined }, /category/);
  await refuse({ categoryKey: 'old_category' }, /unavailable/);
  await refuse({ files: { min: 5, max: 150, step: 5 } }, /at most 100/);
  await refuse({ maxTenureMonths: 24 }, /1 to 12/);
  await refuse({ billingOptions: [{ billingCycle: 'every_2_years', discountPercent: 0 }] }, /monthly, quarterly/);
  await refuse({ capability: 'send_reminders' }, /collects data/);
  await refuse({ serviceName: '' }, /name/);
  assert.equal(await productModel.countDocuments(), 0);
});

test('only whitelisted fields are stored', async () => {
  const created = await save(flexibleBody({ isMonthlyLimitedPlan: true, category: 'feature_upgrades', retiredAt: new Date() }));
  const stored = await productModel.findById(created.data._id).lean();
  assert.equal(stored.category, 'service_plan');
  assert.notEqual(stored.isMonthlyLimitedPlan, true); // sent true; schema default false is kept
  assert.equal(stored.retiredAt ?? null, null);
});

test('portal create page still works (no category) and stores whole-rupee prices', async () => {
  const response = await fetch(`${base}/admin/services/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(admin) }, body: JSON.stringify(portalStarterBody) });
  const created = await response.json();
  assert.equal(response.status, 201, created.message);
  assert.deepEqual(created.data.servicePlan.billingOptions.map((o) => o.pricePerCycle), [1490, 4336, 16450]);
  assert.equal(created.data.servicePlan.pricingMode, 'fixed');
  assert.equal(created.data.price, 1490);
});

test('edit replaces settings, keeps old validity fields, never touches orders', async () => {
  const plan = await productModel.create({ serviceName: 'Old plan', category: 'service_plan', isServicePlan: true, price: 1490, sellingPrice: 1490,
    servicePlan: { ...portalStarterBody, billingOptions: [{ billingCycle: 'monthly', discountPercent: 0, pricePerCycle: 1490 }], validityInDays: 365, categoryKey: 'old_category' } });
  const order = await orderModel.collection.insertOne({ isServicePlan: true, productId: plan._id, servicePlanSnapshot: { serviceName: 'Old plan', portalAccessCount: 1 } });

  const edited = await save({ ...portalStarterBody, planId: String(plan._id), serviceName: 'Starter Update Plan', monthlyReferencePrice: 1590 });
  assert.equal(edited.status, 200, edited.message);
  assert.equal(edited.data.serviceName, 'Starter Update Plan');
  assert.equal(edited.data.servicePlan.validityInDays, 365);
  assert.equal(edited.data.servicePlan.categoryKey, 'old_category'); // archived since, kept because unchanged
  assert.deepEqual(edited.data.servicePlan.billingOptions.map((o) => o.pricePerCycle), [1590, 4627, 17554]);

  const snapshot = (await orderModel.collection.findOne({ _id: order.insertedId })).servicePlanSnapshot;
  assert.deepEqual(snapshot, { serviceName: 'Old plan', portalAccessCount: 1 });
});

test('retired, unknown and non-plan products cannot be edited here', async () => {
  const retired = await productModel.create({ serviceName: 'Gone', category: 'service_plan', isServicePlan: true, price: 1, sellingPrice: 1, retiredAt: new Date(), servicePlan: { capability: 'send_reminders', purchaseType: 'one_time' } });
  const feature = await productModel.create({ serviceName: 'Feature', category: 'feature_upgrades', price: 1, sellingPrice: 1 });
  assert.match((await save({ ...portalStarterBody, planId: String(retired._id) })).message, /retired/);
  assert.equal((await save({ ...portalStarterBody, planId: String(feature._id) })).status, 404);
  assert.equal((await save({ ...portalStarterBody, planId: 'not-an-id' })).status, 404);
});

test('B5: /update-product refuses service plans but still edits feature products', async () => {
  const plan = await productModel.create({ serviceName: 'Plan', category: 'service_plan', isServicePlan: true, price: 100, sellingPrice: 100, servicePlan: { capability: 'send_reminders', purchaseType: 'one_time' } });
  const feature = await productModel.create({ serviceName: 'Feature', category: 'feature_upgrades', price: 1, sellingPrice: 1 });
  const post = (body) => fetch(`${base}/update-product`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(admin) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...await r.json() }));

  const refused = await post({ _id: String(plan._id), price: 1, isServicePlan: false });
  assert.equal(refused.status, 400);
  const stored = await productModel.findById(plan._id).lean();
  assert.deepEqual([stored.price, stored.isServicePlan], [100, true]);

  const ok = await post({ _id: String(feature._id), serviceName: 'Feature 2' });
  assert.equal(ok.status, 200, ok.message);
  assert.equal((await productModel.findById(feature._id).lean()).serviceName, 'Feature 2');
});

test('non-admins cannot read, save, act or quote', async () => {
  assert.equal((await call('/admin/plan-catalogue', { user: customer })).status, 403);
  assert.equal((await save(flexibleBody(), customer)).status, 403);
  assert.equal(await productModel.countDocuments(), 0);
  const plan = await save(flexibleBody());
  assert.equal((await save({ action: 'retire', planId: String(plan.data._id) }, customer)).status, 403);
  assert.equal((await call('/admin/plan-catalogue/quote', { user: customer, body: { planId: String(plan.data._id), purchase: 'one_time', files: 5, updates: 1 } })).status, 403);
});

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(admin) }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, ...await r.json() }));

test('flexible plans stay hidden until the builder is live: save, unhide and restore', async () => {
  const visible = await save(flexibleBody({ isHidden: false }));
  assert.equal(visible.status, 409);
  assert.match(visible.message, /stays hidden/);
  assert.equal(await productModel.countDocuments(), 0);

  const plan = (await save(flexibleBody())).data;
  assert.equal(plan.isHidden, true);
  assert.equal((await call('/admin/plan-catalogue')).data.plans[0].canBeOnSale, false);
  assert.equal((await save({ action: 'unhide', planId: String(plan._id) })).status, 409);
  assert.equal((await post('/unhide-product', { _id: String(plan._id) })).status, 400);
  // An edit that does not send isHidden keeps it hidden.
  const { isHidden, creating, ...edit } = flexibleBody({ ratePerFile: 90 });
  assert.equal((await save({ ...edit, planId: String(plan._id) })).status, 200);

  await orderModel.collection.insertOne({ productId: new mongoose.Types.ObjectId(String(plan._id)), userId: customer._id, isServicePlan: true });
  assert.equal((await save({ action: 'retire', planId: String(plan._id) })).data.action, 'retired');
  const restored = await post(`/admin/plans/${plan._id}/reactivate`);
  assert.equal(restored.status, 200, restored.message);
  assert.equal(restored.data.isHidden, true);
  assert.equal((await productModel.findById(plan._id).lean()).isHidden, true);

  // Fixed plans still go on sale.
  const fixed = await save({ ...portalStarterBody, creating: true, categoryKey: 'website_updates', isHidden: true });
  assert.equal((await save({ action: 'unhide', planId: String(fixed.data._id) })).status, 200);
  assert.equal((await productModel.findById(fixed.data._id).lean()).isHidden, false);
});

test('website plan actions: retire (delete when unsold), restore, hide, delete forever', async () => {
  const fixed = (await save({ ...portalStarterBody, creating: true, categoryKey: 'website_updates' })).data;
  const unsold = (await save({ ...portalStarterBody, creating: true, categoryKey: 'website_updates', serviceName: 'Unsold' })).data;
  const feature = await productModel.create({ serviceName: 'Feature', category: 'feature_upgrades', price: 1, sellingPrice: 1 });

  assert.equal((await save({ action: 'retire', planId: String(unsold._id) })).data.action, 'deleted');
  assert.equal(await productModel.countDocuments({ _id: unsold._id }), 0);

  assert.equal((await save({ action: 'hide', planId: String(fixed._id) })).status, 200);
  assert.equal((await save({ action: 'unhide', planId: String(fixed._id) })).status, 200);
  assert.equal((await save({ action: 'purge', planId: String(fixed._id) })).status, 409); // retire first

  await orderModel.collection.insertOne({ productId: new mongoose.Types.ObjectId(String(fixed._id)), userId: customer._id, isServicePlan: true });
  assert.equal((await save({ action: 'retire', planId: String(fixed._id) })).data.action, 'retired');
  assert.equal((await save({ action: 'hide', planId: String(fixed._id) })).status, 400); // lifecycle owns it now
  assert.equal((await call('/admin/plan-catalogue')).data.plans.find((p) => p._id === String(fixed._id)).retired, true);
  assert.equal((await save({ action: 'restore', planId: String(fixed._id) })).data.isHidden, false);

  await save({ action: 'retire', planId: String(fixed._id) });
  assert.match((await save({ action: 'purge', planId: String(fixed._id), mode: 'hard', confirmName: 'wrong' })).message, /exact name/);
  assert.equal((await save({ action: 'purge', planId: String(fixed._id) })).data.action, 'archived');
  assert.equal((await call('/admin/plan-catalogue')).data.plans.length, 0);
  assert.equal(await orderModel.countDocuments(), 1); // orders never touched

  assert.equal((await save({ action: 'hide', planId: String(feature._id) })).status, 404); // plans only here
  assert.equal((await save({ action: 'fly', planId: String(feature._id) })).status, 400);
});

test('admin quote: saved hidden plan with a key, unsaved form settings without one', async () => {
  const plan = (await save(flexibleBody())).data; // hidden
  const quote = (body) => call('/admin/plan-catalogue/quote', { body });
  const saved = await quote({ planId: String(plan._id), purchase: 'quarterly', tenureMonths: 6, files: 20, updates: 2 });
  assert.equal(saved.status, 200, saved.message);
  assert.equal(saved.data.quote.cyclePrice, 8550);
  assert.match(saved.data.quoteKey, /^[0-9a-f]{64}$/);

  const { creating, ...settings } = flexibleBody({ ratePerFile: 200, categoryKey: undefined, serviceName: '' });
  const preview = await quote({ settings, purchase: 'one_time', files: 5, updates: 1 });
  assert.equal(preview.status, 200, preview.message);
  assert.deepEqual([preview.data.quote.totalPrice, preview.data.quoteKey, preview.data.planId], [1000, undefined, null]);
  assert.equal(await productModel.countDocuments(), 1); // nothing saved

  assert.equal((await quote({ settings: { ...settings, files: { min: 5, max: 500, step: 5 } }, purchase: 'one_time', files: 5, updates: 1 })).status, 400);
  assert.equal((await quote({ planId: String(plan._id), purchase: 'one_time', files: 7, updates: 1 })).status, 400);
  await productModel.updateOne({ _id: plan._id }, { $set: { retiredAt: new Date() } });
  assert.equal((await quote({ planId: String(plan._id), purchase: 'one_time', files: 5, updates: 1 })).status, 404);
});
