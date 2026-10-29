// Plan categories SSOT (helpers/planCategories.js), Flexible Plans Phase 1 step P2a
// (merasoftware/src/docs/plan.md): admin create/edit/archive through the website's GET/PATCH route,
// permanent keys, optional project-category link, usage counts, the active-only rule.
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
const PlanCategory = require('../models/servicePlanCategoryModel');
const authToken = require('../middleware/authToken');
const { requireActivePlanCategory } = require('../helpers/planCategories');
const { listPlanCategoriesController, savePlanCategoryController } = require('../controller/admin/planCategories');

let db, server, base, admin, customer;
const cookie = (user) => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function call({ user = admin, body } = {}) {
  const response = await fetch(`${base}/admin/plan-categories`, {
    method: body ? 'PATCH' : 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie(user) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, ...await response.json() };
}
const save = (body) => call({ body });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-plan-categories-secret';
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60000 }] });
  await mongoose.connect(db.getUri(), { dbName: 'plan-categories-isolated-test' });
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
  ]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.get('/admin/plan-categories', authToken, listPlanCategoriesController);
  app.patch('/admin/plan-categories', authToken, savePlanCategoryController);
  await PlanCategory.syncIndexes();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { await Promise.all([PlanCategory.deleteMany({}), productModel.deleteMany({})]); });
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('admin creates a category, it is listed with its plan count', async () => {
  const created = await save({ creating: true, key: 'website_updates', label: 'Website Updates', sortOrder: 0 });
  assert.equal(created.status, 200, created.message);
  assert.deepEqual({ key: created.data.key, label: created.data.label, status: created.data.status }, { key: 'website_updates', label: 'Website Updates', status: 'active' });

  await productModel.collection.insertOne({ serviceName: 'Starter', category: 'service_plan', isServicePlan: true, servicePlan: { categoryKey: 'website_updates' } });
  const list = await call();
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.map((row) => [row.key, row.usage.plans]), [['website_updates', 1]]);
});

test('keys are permanent: invalid, duplicate and unknown keys are refused', async () => {
  assert.equal((await save({ creating: true, key: 'Bad Key', label: 'X' })).status, 400);
  assert.equal((await save({ creating: true, key: 'website_features', label: '' })).status, 400);
  assert.equal((await save({ creating: true, key: 'website_features', label: 'Website Features' })).status, 200);
  assert.equal((await save({ creating: true, key: 'website_features', label: 'Again' })).status, 409);
  assert.equal((await save({ key: 'never_created', label: 'X' })).status, 404);
});

test('partial update changes only the fields sent; archive instead of delete', async () => {
  await save({ creating: true, key: 'online_promotions', label: 'Online Promotions', description: 'Ads' });
  const renamed = await save({ key: 'online_promotions', label: 'Online Promotion' });
  assert.equal(renamed.data.label, 'Online Promotion');
  assert.equal(renamed.data.description, 'Ads');
  const archived = await save({ key: 'online_promotions', status: 'archived' });
  assert.equal(archived.data.status, 'archived');
  assert.equal((await call()).data.length, 1);
  assert.equal((await save({ key: 'online_promotions', status: 'deleted' })).status, 400);
});

test('project-category link must point to an existing project category', async () => {
  await save({ creating: true, key: 'website_updates', label: 'Website Updates' });
  assert.equal((await save({ key: 'website_updates', linkedProjectCategory: 'no_such_category' })).status, 400);
  const linked = await save({ key: 'website_updates', linkedProjectCategory: 'standard_websites' });
  assert.equal(linked.data.linkedProjectCategory, 'standard_websites');
  const unlinked = await save({ key: 'website_updates', linkedProjectCategory: null });
  assert.equal(unlinked.data.linkedProjectCategory, null);
});

test('only an active category can be chosen for a plan', async () => {
  await save({ creating: true, key: 'website_updates', label: 'Website Updates' });
  assert.equal((await requireActivePlanCategory('website_updates')).key, 'website_updates');
  await save({ key: 'website_updates', status: 'archived' });
  await assert.rejects(requireActivePlanCategory('website_updates'), /unavailable/);
  await assert.rejects(requireActivePlanCategory('missing_key'), /unavailable/);
});

test('non-admins cannot read or save', async () => {
  assert.equal((await call({ user: customer })).status, 403);
  assert.equal((await call({ user: customer, body: { creating: true, key: 'x_key', label: 'X' } })).status, 403);
  assert.equal(await PlanCategory.countDocuments(), 0);
});


test('project choice explicitly creates one linked category and repeated/concurrent confirms reuse it', async () => {
  const body = { action: 'use_project_category', projectCategoryKey: 'standard_websites' };
  const results = await Promise.all(Array.from({ length: 6 }, () => save(body)));
  results.forEach(row => assert.equal(row.status, 200, row.message));
  assert.equal(new Set(results.map(row => row.data.category.key)).size, 1);
  assert.equal(await PlanCategory.countDocuments({ linkedProjectCategory: 'standard_websites' }), 1);
  const category = results[0].data.category;
  assert.equal(category.label, 'Standard Website');
  assert.equal(category.linkedProjectCategory, 'standard_websites');
  await save({ key: category.key, label: 'My showcase label' });
  const reused = await save(body);
  assert.equal(reused.data.category.label, 'My showcase label');
});

test('multiple links and archived links require an explicit choice or revision-checked restore', async () => {
  await save({ creating: true, key: 'first_link', label: 'First', linkedProjectCategory: 'standard_websites' });
  await save({ creating: true, key: 'second_link', label: 'Second', linkedProjectCategory: 'standard_websites' });
  const body = { action: 'use_project_category', projectCategoryKey: 'standard_websites' };
  const choose = await save(body);
  assert.equal(choose.data.status, 'choose');
  assert.equal(choose.data.categories.length, 2);
  for (const category of choose.data.categories) await save({ key: category.key, status: 'archived' });
  const archived = await save(body);
  assert.equal(archived.data.status, 'archived');
  assert.equal(await PlanCategory.countDocuments(), 2);
  const selected = archived.data.categories[0];
  const restored = await save({ key: selected.key, status: 'active', expectedUpdatedAt: selected.updatedAt });
  assert.equal(restored.status, 200);
  const stale = await save({ key: selected.key, label: 'Stale rename', expectedUpdatedAt: selected.updatedAt });
  assert.equal(stale.status, 409);
  assert.equal((await save(body)).data.category.key, selected.key);
});

test('project choice rejects invalid/archived links, wrong roles and unrelated deterministic-key collisions', async () => {
  const ProjectCategory = require('../models/categoryBasePriceModel');
  await ProjectCategory.create({ category: 'custom_archived', label: 'Archived project', status: 'archived' });
  for (const projectCategoryKey of ['no_such_project', 'Bad Key', 'custom_archived']) {
    assert.equal((await save({ action: 'use_project_category', projectCategoryKey })).status, 400);
  }
  const body = { action: 'use_project_category', projectCategoryKey: 'standard_websites' };
  assert.equal((await call({ user: customer, body })).status, 403);
  const { projectPlanCategoryKey } = require('../helpers/planCategories');
  const key = projectPlanCategoryKey('standard_websites');
  await save({ creating: true, key, label: 'Independent category', linkedProjectCategory: null });
  assert.equal((await save(body)).status, 409);
  assert.equal((await PlanCategory.findOne({ key }).lean()).linkedProjectCategory, null);
  assert.equal(await PlanCategory.countDocuments(), 1);
});

test('custom project labels remain references; independent categories remain unlinked', async () => {
  const ProjectCategory = require('../models/categoryBasePriceModel');
  await ProjectCategory.create({ category: 'custom_active', label: 'Custom Project', status: 'active', sortOrder: 7 });
  const linked = await save({ action: 'use_project_category', projectCategoryKey: 'custom_active' });
  assert.equal(linked.data.category.linkedProjectCategory, 'custom_active');
  assert.equal(linked.data.category.label, 'Custom Project');
  assert.equal(linked.data.category.sortOrder, 7);
  const independent = await save({ creating: true, key: 'showcase_only', label: 'Showcase only', linkedProjectCategory: null });
  assert.equal(independent.data.linkedProjectCategory, null);
});

test('plan dialog creates a main category through shared validation and role checks', async () => {
  const Category = require('../models/categoryBasePriceModel');
  const body = { action: 'save_project_category', creating: true, category: 'digital_campaigns', label: 'Digital Campaigns' };
  try {
    assert.equal((await call({ user: customer, body })).status, 403);
    const results = await Promise.all([save(body), save(body)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(await Category.countDocuments({ category: body.category }), 1);
    assert.equal(await PlanCategory.countDocuments({ key: body.category }), 0);
    const main = await require('../helpers/projectCategories').getProjectCategory(body.category);
    assert.equal(main.customerSelectable, false);
    assert.equal(main.basePrice, null);
    assert.equal((await save({ ...body, category: 'service_plan' })).status, 400);
  } finally { await Category.deleteOne({ category: body.category }); }
});
