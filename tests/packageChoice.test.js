// Package phases 2 and 3 (merasoftware/src/docs/package.md §7): the customer's choice (one-time payment option,
// or a monthly cycle and length), its one quote, the request that carries it, and the monthly package, which
// runs as a plan (src/docs/monthlypackage.md): plan order, plan uploads, renewal at the frozen price, stop.
// Isolated MongoDB; the website is never contacted.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Catalogue = require('../models/salesCatalogueModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Category = require('../models/categoryBasePriceModel');
const StartRequest = require('../models/packageStartRequestModel');
const UpdateRequest = require('../models/updateRequestModel');
const { savePackage, quotePackage, quotePackageChoice, validatePackage } = require('../helpers/salesPackages');
const { uploadAllowanceNow } = require('../helpers/serviceAllowance');
const { processServicePlanRenewals } = require('../cron/servicePlanRenewalCron');
const { stopServiceRenewal } = require('../helpers/serviceLifecycle');
const { activePackageProject } = require('../helpers/packagePurchase');
const { addMonths } = require('../helpers/projectInstallments');
const start = require('../helpers/packageStart');
const { integrationQuote } = require('../controller/order/salesPackagesController');
const createProject = require('../controller/order/adminCreateProjectOrder');

const DAY = 86400000;
const SECRET = 'isolated-test-secret-32-characters-long';
const ONE_TIME = { name: 'Business Starter', description: 'A business website.', status: 'published', category: 'standard_websites',
  billing: 'one_time', portalUploads: true, paymentOptions: ['full', 'installments_3'],
  regularPrice: 15000, discountedPrice: 9999, offerExtraPrice: 0, offerSlug: '', inclusions: ['Website'], terms: [], linkedPlanIds: [], order: 0, pages: [] };
const CYCLES = [{ billingCycle: 'monthly', discountPercent: 0 }, { billingCycle: 'quarterly', discountPercent: 10 }];
const FIXED = { ...ONE_TIME, name: 'Monthly Care', paymentOptions: undefined, billing: 'monthly', regularPrice: 1500, discountedPrice: 1000,
  monthly: { billingOptions: CYCLES, maxTenureMonths: 12, uploadsPerMonth: 2 } };
const UPDATES_ONLY = { ...FIXED, name: 'Care Updates', portalUploads: false, monthly: { billingOptions: CYCLES, maxTenureMonths: 12 } };
let database, customer, admin;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Catalogue, Order, Invoice, Category, StartRequest, UpdateRequest].map(model => model.init()));
  Object.assign(process.env, { PORTFOLIO_WEBSITE_URL: 'https://website.example.test', PORTFOLIO_INTEGRATION_SECRET: SECRET,
    RESEND_API_KEY: 'isolated-test', FROM_EMAIL: 'sender@example.test', PACKAGE_START_REQUESTS_ENABLED: 'true' });
  global.fetch = async url => {
    if (String(url).includes('/api/offers/live')) return { ok: true, json: async () => ({ offers: [], catalogueOffers: [], packagePages: [] }) };
    if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'provider-1' }) };
    throw new Error(`Unexpected external request ${url}`);
  };
});
after(async () => { global.fetch = realFetch; await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [customer, admin] = await User.create([
    { name: 'Client', email: 'client@example.test', roles: ['customer'], phone: '+919876500002' },
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
  ]);
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
});
const response = () => ({ statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
  status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const create = async body => {
  const res = response();
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) }, body: { category: 'standard_websites', ...body } }, res);
  return res;
};
const cash = { paymentMethod: 'cash', transactionReference: 'CASH-1' };

// --- Phase 2: one-time choice, quote and request -------------------------------------------------------------
test('a one-time choice is quoted with its installments; only offered options; older packages have none', async () => {
  const saved = await savePackage({ ...ONE_TIME, id: '' }, true, []);
  const full = quotePackageChoice(saved, [], { paymentOption: 'full' });
  assert.deepEqual([full.finalPrice, full.dueNow, full.installments.length], [9999, 9999, 0]);
  const three = quotePackageChoice(saved, [], { paymentOption: 'installments_3' });
  assert.deepEqual(three.installments.map(row => [row.percentage, row.amount, row.progressThreshold]), [[30, 2999.7, null], [30, 2999.7, 50], [40, 3999.6, 90]]);
  assert.equal(three.dueNow, 2999.7);
  assert.throws(() => quotePackageChoice(saved, [], { paymentOption: 'installments_2' }), /way to pay/);
  const { billing, portalUploads, paymentOptions, ...old } = ONE_TIME;
  assert.throws(() => quotePackageChoice({ ...old, id: 'legacy' }, [], {}), error => error.statusCode === 404);
});

test('an advance offer lets every one-time mode choose a token above the offer minimum', async () => {
  const offer = { slug: 'token', title: 'Token offer', status: 'published', endsAt: '2099-01-01T00:00:00Z',
    applicableCategories: ['standard_websites'], pricingRule: 'fixed_price', offerPrice: 9999, resolvedTerms: [],
    paymentPolicy: { mode: 'advance', minimumAdvance: { type: 'fixed', value: 2000 } } };
  const item = { ...ONE_TIME, id: 'token-pack', offerSlug: 'token', paymentOptions: ['full', 'installments_2', 'installments_3'] };
  for (const option of item.paymentOptions) {
    const quote = quotePackageChoice(item, [offer], { paymentOption: option, advanceAmount: 2500 });
    assert.equal(quote.dueNow, 2500);
    assert.equal(quote.advance.minimum, 2000);
    assert.deepEqual(quote.installments.map(row => row.progressThreshold), option === 'installments_3' ? [null, 50, 90] : [null, 90]);
    assert.equal(quote.installments.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), 999900);
  }
  assert.throws(() => quotePackageChoice(item, [offer], { paymentOption: 'full', advanceAmount: 1999 }), /Choose an advance/);
  assert.equal(quotePackageChoice(item, [offer], { paymentOption: 'full', advanceAmount: 9999 }).installments.length, 0);
});

test('the website quote route needs the integration key and answers the one choice quote', async () => {
  const saved = await savePackage({ ...ONE_TIME, id: '' }, true, []);
  const call = async (auth, body) => { const res = response(); await integrationQuote({ get: () => auth, body }, res); return res; };
  assert.equal((await call('Bearer wrong', { packageId: saved.id, choice: { paymentOption: 'full' } })).statusCode, 401);
  assert.equal((await call(`Bearer ${SECRET}`, { packageId: 'missing', choice: {} })).statusCode, 404);
  const ok = await call(`Bearer ${SECRET}`, { packageId: saved.id, choice: { paymentOption: 'installments_3' } });
  assert.equal(ok.body.data.quote.installments.length, 3);
});

test('a package request carries the choice and the quoted price; a package with settings needs a choice', async () => {
  const saved = await savePackage({ ...ONE_TIME, id: '' }, true, []);
  await assert.rejects(start.requestPackageStart({ userId: customer._id, packageId: saved.id, kind: 'buy' }), /Choose how you want to buy/);
  await assert.rejects(start.requestPackageStart({ userId: customer._id, packageId: saved.id, choice: { paymentOption: 'installments_2' } }), /way to pay/);
  const { request } = await start.requestPackageStart({ userId: customer._id, packageId: saved.id, choice: { paymentOption: 'installments_3' } });
  assert.deepEqual([request.price, request.category, request.choice], [9999, 'standard_websites', { paymentOption: 'installments_3' }]);
  assert.equal(request.quote.dueNow, 2999.7);
  const listed = (await start.listPackageStarts(customer._id)).requests[0];
  assert.deepEqual(listed.choice, { paymentOption: 'installments_3' });
  // Creating the project on that package closes the request (unchanged).
  const res = await create({ sellingPrice: 9999, paymentType: 'partial', installmentCount: 3, packageId: saved.id, packageQuoteKey: quotePackage(saved, []).quoteKey, recordPayment: cash });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body).slice(0, 300));
  assert.equal((await StartRequest.findById(request.id).lean()).closedReason, 'project_created');
});

// --- Phase 3: monthly packages run as plans -------------------------------------------------------------------
test('monthly settings follow the plan rules; one fixed price (no per file); updates a month need uploads', () => {
  assert.equal(validatePackage({ ...FIXED, id: 'care' }).monthly.uploadsPerMonth, 2);
  assert.equal(validatePackage({ ...FIXED, id: 'care', monthly: { ...FIXED.monthly, uploadsPerMonth: null } }).monthly.uploadsPerMonth, null, 'unlimited');
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', paymentOptions: ['full'] }), /without payment options/);
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', offerExtraPrice: 100 }), /offer extras/);
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', monthly: { ...FIXED.monthly, pricing: 'per_file' } }), /one fixed monthly price/);
  assert.throws(() => validatePackage({ ...UPDATES_ONLY, id: 'care', monthly: { ...UPDATES_ONLY.monthly, uploadsPerMonth: 2 } }), /portal uploads/);
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', monthly: { ...FIXED.monthly, uploadsPerMonth: 40 } }), /from 1 to 31/);
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', monthly: { ...FIXED.monthly, billingOptions: [{ billingCycle: 'monthly', discountPercent: 100 }] } }), /discount/);
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', monthly: { ...FIXED.monthly, maxTenureMonths: 13 } }), /Maximum length/);
  assert.throws(() => validatePackage({ ...ONE_TIME, id: 'starter', monthly: FIXED.monthly }), /belong to a monthly package/);
});

test('a monthly choice is priced by the plan engine: cycle discount on the monthly price', async () => {
  const fixed = await savePackage({ ...FIXED, id: '' }, true, []);
  const quarter = quotePackageChoice(fixed, [], { billingCycle: 'quarterly', tenureMonths: 12 });
  assert.deepEqual([quarter.monthly.cyclePrice, quarter.monthly.totalCycles, quarter.finalPrice, quarter.dueNow], [2700, 4, 10800, 2700]);
  assert.equal(quarter.regularPrice, 10800, 'without an offer the normal price is the base');
  assert.throws(() => quotePackageChoice(fixed, [], { billingCycle: 'quarterly', tenureMonths: 4 }), /whole number of billing periods/);
  assert.throws(() => quotePackageChoice(fixed, [], { billingCycle: 'yearly', tenureMonths: 12 }), /not available/);
});

async function monthlyPlan(pkg, monthlyChoice, total) {
  const saved = await savePackage({ ...pkg, id: '' }, true, []);
  const res = await create({ sellingPrice: total, paymentType: 'monthly', monthlyChoice, packageId: saved.id, packageQuoteKey: quotePackage(saved, []).quoteKey, recordPayment: cash });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body).slice(0, 300));
  return { saved, order: await Order.findById(res.body.data._id) };
}

test('a monthly package is made as a plan order: first cycle billed and paid, the agreement frozen, never a project', async () => {
  const saved = await savePackage({ ...FIXED, id: '' }, true, []);
  const key = quotePackage(saved, []).quoteKey;
  const choice = { billingCycle: 'quarterly', tenureMonths: 12 };
  assert.equal((await create({ sellingPrice: 10800, paymentType: 'full', monthlyChoice: choice, packageId: saved.id, packageQuoteKey: key })).statusCode, 400);
  assert.equal((await create({ sellingPrice: 10800, paymentType: 'monthly', monthlyChoice: choice, packageId: saved.id, packageQuoteKey: key, priceAdjustment: 100, adjustmentLabel: 'Extra' })).statusCode, 400);
  assert.equal((await create({ sellingPrice: 9999, paymentType: 'monthly', monthlyChoice: choice, packageId: saved.id, packageQuoteKey: key })).statusCode, 409, 'price must match the quote');
  const { order, saved: bought } = await monthlyPlan(FIXED, choice, 10800);
  assert.deepEqual([order.isServicePlan, order.isWebsiteProject, order.productId, order.projectSnapshot?.salesAgreement], [true, false, null, undefined]);
  assert.deepEqual([order.totalAmount, order.serviceCyclePrice, order.serviceTotalCycles, order.serviceBillingCycleMonths], [2700, 2700, 4, 3]);
  assert.deepEqual([order.orderVisibility, order.servicePlanStatus, order.paymentComplete], ['approved', 'active', true]);
  assert.equal(order.servicePlanSnapshot.serviceName, 'Monthly Care');
  assert.equal(order.salesPackage.package.id, bought.id);
  assert.equal(order.salesPackage.package.monthly.cyclePrice, 2700);
  assert.equal(new Date(order.servicePlanEndDate).getTime(), addMonths(order.servicePlanStartDate, 12).getTime());
  const bills = await Invoice.find({ orderId: order._id, invoiceType: 'project' }).lean();
  assert.deepEqual(bills.map(bill => [bill.serviceCycleNumber, bill.amount, bill.status]), [[1, 2700, 'paid']]);
  // The plan's billing statement for the whole length, as every plan with a fixed length has (serviceBillingStatement.js).
  const statement = await Invoice.findOne({ orderId: order._id, invoiceType: 'service_statement' }).lean();
  assert.deepEqual([statement.amount, statement.amountPaid], [10800, 2700]);
  assert.equal((await activePackageProject(customer._id, bought.id)).plan, true, 'a running monthly package asks before a second purchase');
});

test('uploads follow the plan: updates a month with a monthly reset, unlimited, or no uploads (work updates)', async () => {
  const { order } = await monthlyPlan(FIXED, { billingCycle: 'quarterly', tenureMonths: 6 }, 5400);
  const s = order.servicePlanSnapshot;
  assert.deepEqual([s.capability, s.limitScope, s.portalAccessCount, s.updatesPerMonth, s.releaseMode, s.filesLimit], ['upload_data', 'per_month', 6, 2, 'monthly', 100]);
  const now = uploadAllowanceNow(order);
  assert.deepEqual([now.unlimited, now.limit, now.remaining], [false, 2, 2], 'month 1 opens its 2 updates');
  const { order: unlimited } = await monthlyPlan({ ...FIXED, name: 'Unlimited Care', monthly: { ...FIXED.monthly, uploadsPerMonth: null } }, { billingCycle: 'monthly', tenureMonths: 3 }, 3000);
  assert.equal(uploadAllowanceNow(unlimited).unlimited, true);
  const { order: updates } = await monthlyPlan(UPDATES_ONLY, { billingCycle: 'monthly', tenureMonths: 3 }, 3000);
  assert.equal(updates.servicePlanSnapshot.capability, 'send_reminders');
});

test('every cycle renews at the frozen price; a stopped plan ends after its paid cycle', async () => {
  const { order } = await monthlyPlan(FIXED, { billingCycle: 'monthly', tenureMonths: 3 }, 3000);
  const later = new Date(Date.now() + 32 * DAY);
  await processServicePlanRenewals(later);
  const renewal = await Invoice.findOne({ orderId: order._id, invoiceType: 'plan_renewal' }).lean();
  assert.deepEqual([renewal.serviceCycleNumber, renewal.amount], [2, 1000]);
  const { order: other } = await monthlyPlan({ ...FIXED, name: 'Other Care' }, { billingCycle: 'monthly', tenureMonths: 3 }, 3000);
  await stopServiceRenewal({ serviceOrderId: other._id, userId: customer._id });
  await processServicePlanRenewals(later);
  const stopped = await Order.findById(other._id).lean();
  assert.deepEqual([stopped.servicePlanStatus, stopped.serviceNextBillingDate], ['expired', null]);
  assert.equal(await Invoice.countDocuments({ orderId: other._id, invoiceType: 'plan_renewal' }), 0);
});

test('the admin quote prices a monthly choice for the create form, with a reservation at its own package only', async () => {
  const { adminQuote } = require('../controller/order/salesPackagesController');
  const saved = await savePackage({ ...FIXED, id: '' }, true, []);
  const call = async body => { const res = response(); await adminQuote({ userId: admin._id, userRole: 'admin', body }, res); return res; };
  const ok = await call({ packageId: saved.id, choice: { billingCycle: 'quarterly', tenureMonths: 6 } });
  assert.deepEqual([ok.body.data.quote.finalPrice, ok.body.data.quote.monthly.totalCycles], [5400, 2]);
  const notAdmin = response();
  await adminQuote({ userId: customer._id, userRole: 'customer', body: { packageId: saved.id, choice: {} } }, notAdmin);
  assert.equal(notAdmin.statusCode, 403);
  assert.equal((await call({ packageId: saved.id, choice: {}, customerId: String(customer._id), offerReservationId: String(new mongoose.Types.ObjectId()) })).statusCode, 409);
});
