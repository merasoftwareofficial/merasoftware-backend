// Package phases 2 and 3 (merasoftware/src/docs/package.md §7): the customer's choice (one-time payment option,
// or a monthly cycle, length, files and updates), its one quote, the request that carries it, and the monthly
// package project: cycle installments due by date, its term, its upload limits and no 100% before the end.
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
const { isInstallmentDue } = require('../helpers/projectDuePayment');
const { assertProjectAcceptsUpload, projectUploadLimits } = require('../helpers/projectUploadGate');
const { assertUploadOrder } = require('../helpers/uploadOrderPolicy');
const { modeForCycle } = require('../helpers/offerPaymentPolicy');
const { appendProjectNode } = require('../helpers/projectNodeService');
const { buildCycleInstallments, addMonths } = require('../helpers/projectInstallments');
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
  monthly: { pricing: 'fixed', billingOptions: CYCLES, maxTenureMonths: 12 } };
const PER_FILE = { ...FIXED, name: 'Data Entry', regularPrice: 15, discountedPrice: 10,
  monthly: { pricing: 'per_file', billingOptions: CYCLES, maxTenureMonths: 12, files: { min: 10, max: 50, step: 10 }, updatesPerMonth: { min: 1, max: 4 } } };
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
async function monthlyProject(pkg, monthlyChoice, total) {
  const saved = await savePackage({ ...pkg, id: '' }, true, []);
  const res = await create({ sellingPrice: total, paymentType: 'monthly', monthlyChoice, packageId: saved.id, packageQuoteKey: quotePackage(saved, []).quoteKey, recordPayment: cash });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body).slice(0, 300));
  return { saved, order: await Order.findById(res.body.data._id) };
}
// Moves a project's term back in time, as if it had been created `days` ago.
async function age(order, days) {
  const term = order.projectSnapshot.salesAgreement.package.monthly;
  const shift = date => new Date(new Date(date).getTime() - days * DAY);
  await Order.updateOne({ _id: order._id }, { $set: {
    'projectSnapshot.salesAgreement.package.monthly.startsAt': shift(term.startsAt), 'projectSnapshot.salesAgreement.package.monthly.endsAt': shift(term.endsAt),
    installments: order.installments.map(row => ({ ...row.toObject(), dueDate: shift(row.dueDate) })) } });
  return Order.findById(order._id);
}

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
  await assert.rejects(start.requestPackageStart({ userId: customer._id, packageId: saved.id }), /Choose how you want to buy/);
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

// --- Phase 3: monthly packages -------------------------------------------------------------------------------
test('monthly settings follow the plan rules; no payment options, no offer extras, per file needs uploads', () => {
  assert.equal(validatePackage({ ...FIXED, id: 'care' }).monthly.pricing, 'fixed');
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', paymentOptions: ['full'] }), /without payment options/);
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', offerExtraPrice: 100 }), /offer extras/);
  assert.throws(() => validatePackage({ ...PER_FILE, id: 'data', portalUploads: false }), /needs portal uploads/);
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', monthly: { ...FIXED.monthly, billingOptions: [{ billingCycle: 'monthly', discountPercent: 100 }] } }), /discount/);
  assert.throws(() => validatePackage({ ...FIXED, id: 'care', monthly: { ...FIXED.monthly, maxTenureMonths: 13 } }), /Maximum length/);
  assert.throws(() => validatePackage({ ...PER_FILE, id: 'data', monthly: { ...PER_FILE.monthly, files: { min: 10, max: 200, step: 10 } } }), /at most 100/);
  assert.throws(() => validatePackage({ ...ONE_TIME, id: 'starter', monthly: FIXED.monthly }), /belong to a monthly package/);
});

test('a monthly choice is priced by the plan engine: cycle discount on the charged price, per file = files × rate × updates', async () => {
  const fixed = await savePackage({ ...FIXED, id: '' }, true, []);
  const quarter = quotePackageChoice(fixed, [], { billingCycle: 'quarterly', tenureMonths: 12 });
  assert.deepEqual([quarter.monthly.cyclePrice, quarter.monthly.totalCycles, quarter.finalPrice, quarter.dueNow], [2700, 4, 10800, 2700]);
  assert.equal(quarter.regularPrice, 10800, 'without an offer the normal price is the base');
  assert.throws(() => quotePackageChoice(fixed, [], { billingCycle: 'quarterly', tenureMonths: 4 }), /whole number of billing periods/);
  assert.throws(() => quotePackageChoice(fixed, [], { billingCycle: 'yearly', tenureMonths: 12 }), /not available/);
  const perFile = await savePackage({ ...PER_FILE, id: '' }, true, []);
  const month = quotePackageChoice(perFile, [], { billingCycle: 'monthly', tenureMonths: 3, files: 20, updates: 4 });
  assert.deepEqual([month.monthly.perMonthPrice, month.monthly.cyclePrice, month.finalPrice, month.monthly.files, month.monthly.updatesPerMonth], [800, 800, 2400, 20, 4]);
  assert.throws(() => quotePackageChoice(perFile, [], { billingCycle: 'monthly', tenureMonths: 3, files: 15, updates: 4 }), /files per update/);
});

test('cycle installments: same amount, due by date, the last one takes the rounding', () => {
  const start = new Date('2026-11-08T10:00:00Z');
  const rows = buildCycleInstallments(800, 3, 1, start);
  assert.deepEqual(rows.map(row => [row.installmentNumber, row.amount, row.percentage, row.dueBy, row.progressThreshold]),
    [[1, 800, 33.33, 'date', null], [2, 800, 33.33, 'date', null], [3, 800, 33.34, 'date', null]]);
  assert.deepEqual(rows.map(row => row.dueDate.toISOString()), [start, addMonths(start, 1), addMonths(start, 2)].map(date => date.toISOString()));
});

test('a monthly project: paid per cycle only, its term frozen, extras refused', async () => {
  const saved = await savePackage({ ...FIXED, id: '' }, true, []);
  const key = quotePackage(saved, []).quoteKey;
  const choice = { billingCycle: 'quarterly', tenureMonths: 12 };
  assert.equal((await create({ sellingPrice: 10800, paymentType: 'full', monthlyChoice: choice, packageId: saved.id, packageQuoteKey: key })).statusCode, 400);
  assert.equal((await create({ sellingPrice: 10800, paymentType: 'monthly', monthlyChoice: choice, packageId: saved.id, packageQuoteKey: key, priceAdjustment: 100, adjustmentLabel: 'Extra' })).statusCode, 400);
  assert.equal((await create({ sellingPrice: 9999, paymentType: 'monthly', monthlyChoice: choice, packageId: saved.id, packageQuoteKey: key })).statusCode, 409, 'price must match the quote');
  const one = await savePackage({ ...ONE_TIME, id: '' }, true, []);
  assert.equal((await create({ sellingPrice: 9999, paymentType: 'monthly', packageId: one.id, packageQuoteKey: quotePackage(one, []).quoteKey })).statusCode, 400, 'one-time package');
  const { order } = await monthlyProject(FIXED, choice, 10800);
  const agreement = order.projectSnapshot.salesAgreement;
  assert.deepEqual([order.totalAmount, order.installments.length, agreement.finalPrice, agreement.package.monthly.cyclePrice], [10800, 4, 10800, 2700]);
  assert.ok(order.installments.every(row => row.dueBy === 'date' && row.amount === 2700));
  assert.equal(new Date(agreement.package.monthly.endsAt).getTime(), addMonths(agreement.package.monthly.startsAt, 12).getTime());
  assert.equal(order.installments[0].paid, true, 'cycle 1 paid at creation');
});

test('a cycle is due by its date, never by progress; due and unpaid closes uploads; the offer cycle rule applies', async () => {
  const { order: fresh } = await monthlyProject(FIXED, { billingCycle: 'monthly', tenureMonths: 3 }, 3000);
  const second = fresh.installments[1];
  assert.equal(isInstallmentDue({ projectProgress: 80 }, second), false, 'not the legacy 40% rule');
  assert.equal(await assertProjectAcceptsUpload(fresh), null);
  const order = await age(fresh, 35);
  assert.equal(isInstallmentDue(order, order.installments[1]), true);
  assert.match(await assertProjectAcceptsUpload(order), /payment is due/i);
  assert.equal(modeForCycle({ ...order.toObject(), paymentPolicy: { mode: 'pay_later', cycleScope: 'first_purchase' }, currentInstallment: 2 }), 'advance');
  assert.equal(modeForCycle({ ...order.toObject(), paymentPolicy: { mode: 'pay_later', cycleScope: 'every_cycle' }, currentInstallment: 2 }), 'pay_later');
});

test('per file: files per update and updates per month (month by month, rejected ones given back); the end closes uploads', async () => {
  const { order } = await monthlyProject(PER_FILE, { billingCycle: 'monthly', tenureMonths: 2, files: 20, updates: 2 }, 800);
  const limits = await projectUploadLimits(order);
  assert.deepEqual([limits.maxFiles, limits.allowance.limit, limits.allowance.remaining, limits.cycle.number, limits.cycle.of], [20, 2, 2, 1, 2]);
  await assert.rejects(assertUploadOrder(order, { fileCount: 21 }), /allows 20 files/);
  const upload = status => UpdateRequest.create({ userId: customer._id, updatePlanId: order._id, files: [], status });
  await upload('pending'); await upload('rejected');
  assert.equal((await projectUploadLimits(order)).allowance.remaining, 1, 'a rejected upload does not count');
  await upload('completed');
  assert.match(await assertProjectAcceptsUpload(order), /updates are used/);
  const ended = await age(order, 70);
  await Order.updateOne({ _id: ended._id }, { $set: { 'installments.1.paid': true } });
  assert.match(await assertProjectAcceptsUpload(await Order.findById(order._id)), /package has ended/);
});

test('a monthly project reaches 100% only after its end date', async () => {
  const { order } = await monthlyProject(FIXED, { billingCycle: 'monthly', tenureMonths: 1 }, 1000);
  assert.throws(() => appendProjectNode({ order, title: 'Done', cumulativeProgress: 100, actorId: admin._id }), /can reach 100% only after/);
  const fresh = await Order.findById(order._id);
  appendProjectNode({ order: fresh, title: 'Halfway', cumulativeProgress: 50, actorId: admin._id });
  const ended = await age(order, 40);
  appendProjectNode({ order: ended, title: 'Done', cumulativeProgress: 100, actorId: admin._id });
  assert.equal(ended.projectProgress, 100);
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
