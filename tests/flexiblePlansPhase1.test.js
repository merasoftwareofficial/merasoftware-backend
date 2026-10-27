// Flexible Plans Phase 1 end to end (merasoftware/src/docs/plan.md §0): quote → purchase with the
// customer's choices, frozen snapshot, stale-quote refusal, the pre-builder portal body, one-time
// validity, the website's public catalogue, admin "start plan for client", upload status with the
// rejected update given back, release mode, the plan step mails, and the live-plan settings script.
// Isolated: in-memory MongoDB; the mail provider is mocked and every other network call is blocked.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const express = require('express');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Product = require('../models/productModel');
const User = require('../models/userModel');
const Request = require('../models/updateRequestModel');
const PlanCategory = require('../models/servicePlanCategoryModel');
const { EmailDraft, EmailHistory, EmailPolicy } = require('../models/emailControlModel');
const { getOrderUploadHistory } = require('../helpers/orderUploadHistory');
const { markInProgressOnDownload } = require('../helpers/uploadStatus');
const { uploadAllowanceNow } = require('../helpers/serviceAllowance');

const nativeFetch = global.fetch;
const SECRET = 'isolated-phase1-secret'.repeat(3);
let database, server, origin, admin, client, sent;

async function call(path, { body, method = body ? 'POST' : 'GET', bearer } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) };
  const response = await nativeFetch(origin + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
// System mail goes out after the action (setImmediate); wait until it has been sent.
async function mailFor(dedupeKey) {
  for (let i = 0; i < 150; i += 1) {
    const row = await EmailHistory.findOne({ dedupeKey }).lean();
    if (row && ['sent', 'failed', 'skipped'].includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return EmailHistory.findOne({ dedupeKey }).lean();
}

const flexiblePlan = () => Product.create({
  serviceName: 'Website Update · Flexible', category: 'service_plan', isServicePlan: true, price: 500, sellingPrice: 500,
  servicePlan: {
    categoryKey: 'website_updates', pricingMode: 'flexible', capability: 'upload_data', serviceBehavior: 'portal_access_control',
    dependency: 'standalone_or_project', timing: 'during_and_after', purchaseType: 'recurring', limitScope: 'per_month',
    files: { min: 5, max: 100, step: 5 }, ratePerFile: 100, slabs: [{ fromFile: 11, ratePerFile: 50 }, { fromFile: 21, ratePerFile: 35 }],
    updatesPerMonth: { min: 1, max: 4 }, allowOneTime: true, customerCanChooseRelease: true,
    billingOptions: [{ billingCycle: 'monthly', discountPercent: 0 }, { billingCycle: 'quarterly', discountPercent: 5 }],
  },
});
const starterPlan = () => Product.create({
  serviceName: 'Starter Update Plan', category: 'service_plan', isServicePlan: true, price: 1490, sellingPrice: 1490,
  servicePlan: {
    capability: 'upload_data', serviceBehavior: 'portal_access_control', dependency: 'standalone_or_project', timing: 'during_and_after',
    purchaseType: 'recurring', limitScope: 'per_month', portalAccessCount: 1, filesLimit: 20, monthlyReferencePrice: 1490,
    billingOptions: [
      { billingCycle: 'monthly', discountPercent: 0, pricePerCycle: 1490 },
      { billingCycle: 'quarterly', discountPercent: 3, pricePerCycle: 4335.9 },
      { billingCycle: 'yearly', discountPercent: 8, pricePerCycle: 16449.600000000002 },
    ],
  },
});
const singlePagePlan = () => Product.create({
  serviceName: 'Single Page Adition', category: 'service_plan', isServicePlan: true, price: 1500, sellingPrice: 1500,
  servicePlan: { capability: 'upload_data', serviceBehavior: 'portal_access_control', dependency: 'standalone_or_project', timing: 'during_and_after', purchaseType: 'one_time', limitScope: 'per_plan', portalAccessCount: 5, filesLimit: 20 },
});
const liveChatPlan = () => Product.create({
  serviceName: 'Live Chat Feature', category: 'service_plan', isServicePlan: true, price: 2500, sellingPrice: 2500,
  servicePlan: { capability: 'send_reminders', serviceBehavior: 'reminder_only', dependency: 'standalone_or_project', timing: 'during_and_after', purchaseType: 'one_time' },
});
const walletBuy = (body) => call('/customer/service-plan-order', { body: { paymentDetails: { transactionId: `T${Date.now()}${Math.random()}` }, ...body } });

before(async () => {
  process.env.RESEND_API_KEY = 'isolated-no-real-key'; process.env.FROM_EMAIL = 'sender@example.test';
  process.env.PORTFOLIO_INTEGRATION_SECRET = SECRET;
  process.env.ADMIN_DASHBOARD_URL = 'https://portal.example.test';
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Order.init(), Invoice.init(), Request.init(), PlanCategory.init(), EmailDraft.init(), EmailHistory.init(), EmailPolicy.init()]);
  global.fetch = async (url, options) => {
    if (String(url) === 'https://api.resend.com/emails') { sent.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: 'isolated' }), { status: 200 }); }
    if (String(url).includes('/api/offers/live')) return new Response(JSON.stringify({ offers: [], catalogueOffers: [] }), { status: 200 });
    throw new Error(`External network blocked: ${url}`);
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const isAdmin = req.path.startsWith('/admin');
    req.userId = String(isAdmin ? admin._id : client._id); req.userRole = isAdmin ? 'admin' : 'customer'; next();
  });
  const quotes = require('../controller/order/servicePlanQuote');
  const adminActions = require('../controller/admin/servicePlanAdmin');
  app.post('/customer/service-plan-quote', quotes.customerQuote);
  app.post('/customer/service-plan-order', require('../controller/order/customerCreateServicePlanOrder'));
  app.get('/integration/plan-catalogue', quotes.integrationCatalogue);
  app.patch('/integration/plan-catalogue/quote', quotes.integrationQuote);
  app.post('/admin/clients/:customerId/service-plans', adminActions.startPlanForClient);
  app.patch('/admin/service-plans/:orderId/release-mode', adminActions.setReleaseMode);
  app.post('/admin/uploads/:requestId/status', adminActions.setUploadStatusController);
  app.patch('/admin/plan-catalogue/quote', require('../controller/admin/planCatalogue').quotePlanController);
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [admin, client] = await User.create([
    { name: 'Plan Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Plan Client', email: 'client@example.test', roles: ['customer'], walletBalance: 100000 },
  ]);
  await PlanCategory.create({ key: 'website_updates', label: 'Website Updates' });
  sent = [];
});
after(async () => {
  global.fetch = nativeFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect(); await database?.stop();
});

test('flexible plan: quote, buy with the quote, choices frozen on the order, client told', async () => {
  const plan = await flexiblePlan();
  const choice = { planId: String(plan._id), purchase: 'quarterly', tenureMonths: 6, files: 20, updates: 2 };
  const quoted = await call('/customer/service-plan-quote', { body: choice });
  assert.equal(quoted.status, 200, quoted.message);
  assert.equal(quoted.data.quote.cyclePrice, 8550);

  const bought = await walletBuy({ ...choice, quoteKey: quoted.data.quoteKey });
  assert.equal(bought.status, 201, bought.message);
  assert.equal(bought.data.finalPrice, 8550);
  const order = await Order.findById(bought.data.orderId).lean();
  const s = order.servicePlanSnapshot;
  assert.deepEqual([s.chosenFiles, s.chosenUpdates, s.updatesPerMonth, s.filesLimit, s.portalAccessCount, s.releaseMode, s.categoryKey],
    [20, 2, 2, 20, 6, 'all_at_once', 'website_updates']);
  assert.deepEqual([s.priceBreakdown.subtotal, s.priceBreakdown.discount, s.priceBreakdown.totalPrice], [9000, 450, 17100]);
  assert.deepEqual([order.serviceCyclePrice, order.serviceTotalCycles, order.servicePlanStatus, order.orderVisibility], [8550, 2, 'active', 'approved']);
  assert.equal((await User.findById(client._id).lean()).walletBalance, 100000 - 8550);

  const mail = await mailFor(`plan-started:${order._id}`);
  assert.deepEqual([mail?.event, mail?.status], ['plan.started', 'sent']);
  assert.ok(sent.some((m) => m.subject === 'Your plan Website Update · Flexible has started'));
  assert.equal(sent.filter((m) => /has started|Payment received/.test(m.subject)).length, 1); // one message, not two
});

test('stale or missing quote is refused; nothing is bought', async () => {
  const plan = await flexiblePlan();
  const choice = { planId: String(plan._id), purchase: 'monthly', tenureMonths: 1, files: 10, updates: 1 };
  const quoted = await call('/customer/service-plan-quote', { body: choice });
  assert.equal((await walletBuy(choice)).status, 400); // flexible needs a quote
  assert.equal((await walletBuy({ ...choice, files: 15, quoteKey: quoted.data.quoteKey })).status, 409);
  await Product.updateOne({ _id: plan._id }, { $set: { 'servicePlan.ratePerFile': 120 } });
  const afterChange = await walletBuy({ ...choice, quoteKey: quoted.data.quoteKey });
  assert.equal(afterChange.status, 409);
  assert.match(afterChange.message, /changed/);
  assert.equal(await Order.countDocuments(), 0);
});

test('pre-builder portal body still buys a fixed plan; per-month allowance covers the period', async () => {
  const plan = await starterPlan();
  const bought = await walletBuy({ planId: String(plan._id), selectedBillingCycle: 'quarterly', tenureMonths: 6 });
  assert.equal(bought.status, 201, bought.message);
  const order = await Order.findById(bought.data.orderId).lean();
  assert.deepEqual([bought.data.finalPrice, order.serviceCyclePrice], [4336, 4336]);
  assert.deepEqual([order.servicePlanSnapshot.portalAccessCount, order.servicePlanSnapshot.updatesPerMonth], [3, 1]);
  assert.equal(uploadAllowanceNow(order).remaining, 3);
  assert.equal((await walletBuy({ planId: String(plan._id), selectedBillingCycle: 'quarterly', tenureMonths: 24 })).status, 400);
});

test('one-time upload plan runs 90 days; reminder-only plan keeps no end date', async () => {
  const page = await singlePagePlan();
  const chat = await liveChatPlan();
  const pageOrder = await Order.findById((await walletBuy({ planId: String(page._id) })).data.orderId).lean();
  const days = Math.round((new Date(pageOrder.servicePlanEndDate) - new Date(pageOrder.servicePlanStartDate)) / 86400000);
  assert.equal(days, 90);
  assert.equal(pageOrder.servicePlanSnapshot.portalAccessCount, 5);
  const chatOrder = await Order.findById((await walletBuy({ planId: String(chat._id) })).data.orderId).lean();
  assert.equal(chatOrder.servicePlanEndDate, null);
});

test('website reads the public catalogue and quotes with its key only', async () => {
  const plan = await flexiblePlan();
  await Product.create({ serviceName: 'Hidden', category: 'service_plan', isServicePlan: true, isHidden: true, price: 1, sellingPrice: 1, servicePlan: { capability: 'send_reminders', purchaseType: 'one_time' } });
  assert.equal((await call('/integration/plan-catalogue')).status, 401);
  const catalogue = await call('/integration/plan-catalogue', { bearer: SECRET });
  assert.equal(catalogue.status, 200, catalogue.message);
  assert.deepEqual(catalogue.data.plans.map((p) => p.serviceName), ['Website Update · Flexible']);
  assert.deepEqual(catalogue.data.plans[0].priceRange, { unit: 'update', from: 500, to: 4300 });
  assert.equal(catalogue.data.categories[0].key, 'website_updates');
  const quoted = await call('/integration/plan-catalogue/quote', { method: 'PATCH', bearer: SECRET, body: { planId: String(plan._id), purchase: 'one_time', files: 20, updates: 2 } });
  assert.equal(quoted.data.quote.totalPrice, 3000);
});

test('admin starts a plan for a client from the wallet; recorded payment needs valid evidence', async () => {
  const plan = await starterPlan();
  const started = await call(`/admin/clients/${client._id}/service-plans`, { body: { planId: String(plan._id), purchase: 'monthly', tenureMonths: 3, payment: { mode: 'wallet' } } });
  assert.equal(started.status, 201, started.message);
  const order = await Order.findById(started.data.orderId).lean();
  assert.deepEqual([order.servicePlanStatus, order.orderVisibility, order.paymentComplete], ['active', 'approved', true]);
  assert.equal((await Invoice.findById(started.data.invoiceId).lean()).status, 'paid');
  assert.equal((await User.findById(client._id).lean()).walletBalance, 100000 - 1490);
  assert.equal((await mailFor(`plan-started:${order._id}`))?.event, 'plan.started');

  const badEvidence = await call(`/admin/clients/${client._id}/service-plans`, { body: { planId: String(plan._id), purchase: 'monthly', tenureMonths: 1, payment: { mode: 'record', paymentMethod: 'upi', transactionReference: '' } } });
  assert.equal(badEvidence.status, 400);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await call(`/admin/clients/${client._id}/service-plans`, { body: { planId: String(plan._id), purchase: 'monthly', tenureMonths: 1 } })).status, 400);
});

test('upload status: in progress on download, done, rejected gives the update back once', async () => {
  const plan = await starterPlan();
  const order = await Order.findById((await walletBuy({ planId: String(plan._id), selectedBillingCycle: 'monthly', tenureMonths: 1 })).data.orderId);
  await Order.updateOne({ _id: order._id }, { $set: { serviceAccessUsedInCycle: 1, serviceAccessUsedTotal: 1 } });
  const [first, second] = await Request.create([
    { userId: client._id, updatePlanId: order._id, files: [], instructions: [{ text: 'Change banner' }] },
    { userId: client._id, updatePlanId: order._id, files: [], instructions: [{ text: 'Wrong file' }] },
  ]);

  await markInProgressOnDownload(first._id, admin._id);
  assert.equal((await Request.findById(first._id).lean()).status, 'in_progress');
  assert.equal(await markInProgressOnDownload(first._id, admin._id), null); // already moved: quiet
  const done = await call(`/admin/uploads/${first._id}/status`, { body: { status: 'completed', note: 'Banner changed.' } });
  assert.equal(done.status, 200, done.message);
  assert.equal((await call(`/admin/uploads/${first._id}/status`, { body: { status: 'rejected', note: 'x' } })).status, 409);
  assert.equal((await mailFor(`plan-upload:${first._id}:2`))?.event, 'plan.upload.completed');

  assert.equal((await call(`/admin/uploads/${second._id}/status`, { body: { status: 'rejected' } })).status, 400); // reason required
  const rejected = await call(`/admin/uploads/${second._id}/status`, { body: { status: 'rejected', note: 'The file is empty, please send it again.' } });
  assert.equal(rejected.data.allowanceReturned, true);
  assert.equal((await Order.findById(order._id).lean()).serviceAccessUsedInCycle, 0);
  assert.equal((await mailFor(`plan-upload:${second._id}:1`))?.event, 'plan.upload.rejected');

  const history = await getOrderUploadHistory(order._id);
  const shown = history.find((row) => row.id === String(first._id));
  assert.equal(shown.isPlanUpload, true);
  assert.deepEqual(shown.statusHistory.map((h) => [h.status, h.note, h.auto]), [['in_progress', '', true], ['completed', 'Banner changed.', false]]);
  assert.equal(history.find((row) => row.id === String(second._id)).allowanceReturned, true);
});

test('release mode: monthly only for a per-month plan longer than one month', async () => {
  const plan = await flexiblePlan();
  const choice = { planId: String(plan._id), purchase: 'quarterly', tenureMonths: 3, files: 5, updates: 2 };
  const quoted = await call('/customer/service-plan-quote', { body: choice });
  const order = (await walletBuy({ ...choice, quoteKey: quoted.data.quoteKey })).data;
  const changed = await call(`/admin/service-plans/${order.orderId}/release-mode`, { method: 'PATCH', body: { releaseMode: 'monthly' } });
  assert.equal(changed.status, 200, changed.message);
  assert.deepEqual([changed.data.allowance.limit, changed.data.allowance.cycleLimit], [2, 6]);

  const monthly = await call('/customer/service-plan-quote', { body: { ...choice, purchase: 'monthly', tenureMonths: 1 } });
  const oneMonth = (await walletBuy({ ...choice, purchase: 'monthly', tenureMonths: 1, quoteKey: monthly.data.quoteKey })).data;
  assert.equal((await call(`/admin/service-plans/${oneMonth.orderId}/release-mode`, { method: 'PATCH', body: { releaseMode: 'monthly' } })).status, 400);
});

test('live-plan settings script: dry run plans the Q4 changes, apply writes them with a backup', async () => {
  await Promise.all([starterPlan(), singlePagePlan(), liveChatPlan()]);
  await PlanCategory.deleteMany({});
  const { planChanges, apply } = require('../scripts/applyLivePlanSettings');
  const db = mongoose.connection.db;
  const changes = await planChanges(db);
  assert.deepEqual(changes.categories.map((c) => c.key), ['website_updates', 'website_features']);
  const starter = changes.plans.find((p) => p.serviceName === 'Starter Update Plan');
  assert.deepEqual(starter.set['servicePlan.billingOptions'].map((o) => o.pricePerCycle), [1490, 4336, 16450]);
  assert.equal(await PlanCategory.countDocuments(), 0); // planning wrote nothing

  const file = await apply(db, changes);
  assert.ok(require('fs').existsSync(file));
  require('fs').rmSync(file);
  assert.equal((await Product.findOne({ serviceName: 'Single Page Adition' }).lean()).servicePlan.oneTimeValidityDays, 90);
  assert.equal((await Product.findOne({ serviceName: 'Live Chat Feature' }).lean()).servicePlan.categoryKey, 'website_features');
  assert.deepEqual((await PlanCategory.find().sort({ sortOrder: 1 }).lean()).map((c) => c.key), ['website_updates', 'website_features']);
  const again = await planChanges(db);
  assert.equal(again.categories.length, 0);
  assert.ok(again.plans.every((p) => Object.keys(p.set).length === 0)); // second run: nothing left to do
});

// Phase 2a (plan.md §0): the admin quote feeds "start plan for client", also for a hidden plan.
test('admin quotes a hidden flexible plan and starts it for a client with that key', async () => {
  const plan = await flexiblePlan();
  await Product.updateOne({ _id: plan._id }, { $set: { isHidden: true } });
  const choice = { planId: String(plan._id), purchase: 'monthly', tenureMonths: 2, files: 10, updates: 1 };
  assert.equal((await call('/customer/service-plan-quote', { body: choice })).status, 404); // customers see plans on sale only
  const quoted = await call('/admin/plan-catalogue/quote', { method: 'PATCH', body: choice });
  assert.equal(quoted.status, 200, quoted.message);
  const started = await call(`/admin/clients/${client._id}/service-plans`, { body: { ...choice, quoteKey: quoted.data.quoteKey, payment: { mode: 'wallet' } } });
  assert.equal(started.status, 201, started.message);
  assert.equal(started.data.finalPrice, quoted.data.quote.firstPayment);
});

test('upload status is for plan uploads only; downloading a project upload changes nothing', async () => {
  const project = await Order.collection.insertOne({ userId: client._id, isWebsiteProject: true });
  const upload = await Request.create({ userId: client._id, updatePlanId: project.insertedId, files: [], instructions: [{ text: 'Project data' }] });
  const refused = await call(`/admin/uploads/${upload._id}/status`, { body: { status: 'completed', note: 'x' } });
  assert.equal(refused.status, 422);
  assert.equal(await markInProgressOnDownload(upload._id, admin._id), null);
  const stored = await Request.findById(upload._id).lean();
  assert.deepEqual([stored.status, stored.statusHistory.length], ['pending', 0]);
});

test('order payloads carry the plan allowance from serviceAllowance.js', async () => {
  const { applyOrderSummary } = require('../helpers/orderSummary');
  require('../models/developerModel'); // the summary populates assignedDeveloper
  const plan = await flexiblePlan();
  const choice = { planId: String(plan._id), purchase: 'quarterly', tenureMonths: 3, files: 5, updates: 2 };
  const quoted = await call('/customer/service-plan-quote', { body: choice });
  const { orderId } = (await walletBuy({ ...choice, quoteKey: quoted.data.quoteKey })).data;
  await call(`/admin/service-plans/${orderId}/release-mode`, { method: 'PATCH', body: { releaseMode: 'monthly' } });
  const [row] = await applyOrderSummary(Order.find({ _id: orderId }));
  assert.deepEqual([row.uploadAllowance.limit, row.uploadAllowance.cycleLimit, row.uploadAllowance.remaining], [2, 6, 2]);
});
