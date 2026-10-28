const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Product = require('../models/productModel');
const Category = require('../models/servicePlanCategoryModel');
const User = require('../models/userModel');
const auth = require('../middleware/authToken');
const controller = require('../controller/order/servicePlanQuote');
let db, server, origin, customer, admin;
const secret = 'isolated-customer-plan-catalogue';
async function call(path, user = customer, body) {
  const response = await fetch(origin + path, {
    method: body ? 'POST' : 'GET', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${secret.repeat(3)}`,
      ...(user ? { Cookie: `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, secret)}` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, ...await response.json() };
}
const plan = (extra = {}) => Product.create({ serviceName: 'Starter', category: 'service_plan', isServicePlan: true,
  price: 100, sellingPrice: 100, servicePlan: { categoryKey: 'updates', capability: 'upload_data', dependency: 'standalone_or_project',
    purchaseType: 'recurring', monthlyReferencePrice: 100, limitScope: 'per_month', portalAccessCount: 1, filesLimit: 20,
    billingOptions: [{ billingCycle: 'monthly', pricePerCycle: 100, discountPercent: 0 }] }, ...extra });
before(async () => {
  process.env.TOKEN_SECRET_KEY = secret; process.env.PORTFOLIO_INTEGRATION_SECRET = secret.repeat(3);
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(db.getUri());
  [customer, admin] = await User.create([{ name: 'Customer', email: 'customer@example.test', roles: ['customer'] }, { name: 'Admin', email: 'admin@example.test', roles: ['admin'] }]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.get('/customer/service-plan-catalogue', auth, controller.customerCatalogue);
  app.post('/customer/service-plan-quote', auth, controller.customerQuote);
  app.get('/integration/plan-catalogue', controller.integrationCatalogue);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { await Promise.all([Product.deleteMany({}), Category.deleteMany({})]); });
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });

test('catalogue needs a signed-in customer role', async () => {
  assert.equal((await call('/customer/service-plan-catalogue', null)).status, 401);
  assert.equal((await call('/customer/service-plan-catalogue', admin)).status, 403);
  assert.equal((await call('/customer/service-plan-catalogue')).status, 200);
});

test('portal and website share on-sale eligibility and public category metadata without changing portal shape', async () => {
  await Category.create([{ key: 'updates', label: 'Updates', description: 'Send your work', sortOrder: 2 }, { key: 'features', label: 'Features', sortOrder: 1 }, { key: 'archived', label: 'Old', status: 'archived' }]);
  const live = await plan();
  const fallback = await plan({ serviceName: 'Old category plan', servicePlan: { capability: 'send_reminders', purchaseType: 'one_time', categoryKey: 'archived' } });
  await plan({ isHidden: true }); await plan({ retiredAt: new Date() }); await plan({ archivedAt: new Date() });
  await Product.create({ category: 'feature_upgrades', serviceName: 'Feature', price: 100 });
  const portal = await call('/customer/service-plan-catalogue');
  const web = await call('/integration/plan-catalogue');
  assert.deepEqual(portal.data.plans.map(row => row._id).sort(), [String(live._id), String(fallback._id)].sort());
  assert.deepEqual(web.data.plans.map(row => row._id).sort(), portal.data.plans.map(row => row._id).sort());
  assert.deepEqual(portal.data.categories, web.data.categories);
  assert.deepEqual(portal.data.categories.map(row => row.key), ['features', 'updates']);
  assert.equal(portal.data.categories[1].description, 'Send your work');
  assert.equal(portal.data.categories[1].usage, undefined);
  const nested = portal.data.plans.find(row => row._id === String(live._id));
  assert.equal(nested.servicePlan.filesLimit, 20); assert.equal(nested.priceRange.from, 100);
  const quote = await call('/customer/service-plan-quote', customer, { planId: nested._id, purchase: 'monthly', tenureMonths: 1 });
  assert.equal(quote.data.quote.firstPayment, 100);
});

test('withdrawn IDs cannot quote even when a client still holds an earlier catalogue', async () => {
  const row = await plan(); const current = await call('/customer/service-plan-catalogue');
  assert.equal(current.data.plans.length, 1);
  await Product.updateOne({ _id: row._id }, { isHidden: true });
  assert.equal((await call('/customer/service-plan-quote', customer, { planId: String(row._id), purchase: 'monthly', tenureMonths: 1 })).status, 404);
  assert.equal((await call('/customer/service-plan-catalogue')).data.plans.length, 0);
});
