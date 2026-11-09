// Package phase 1 (merasoftware/src/docs/package.md §7): one due rule for every installment, the
// package purchase settings, portal uploads frozen on the project, and a reservation used together
// with its own package. Isolated MongoDB; the website is never contacted.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Catalogue = require('../models/salesCatalogueModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Category = require('../models/categoryBasePriceModel');
const Reservation = require('../models/offerReservationModel');
const { savePackage, quotePackage, validatePackage } = require('../helpers/salesPackages');
const { isInstallmentDue, dueInstallment, getDueUnpaidInvoiceFilter, isProjectPaymentDue } = require('../helpers/projectDuePayment');
const { assertProjectAcceptsUpload } = require('../helpers/projectUploadGate');
const createProject = require('../controller/order/adminCreateProjectOrder');

const HOUR = 3600000;
const PURCHASE = { billing: 'one_time', portalUploads: true, paymentOptions: ['installments_2', 'full'] };
const item = { name: 'Business Starter', description: 'A business website.', status: 'published', category: 'standard_websites', ...PURCHASE,
  regularPrice: 15000, discountedPrice: 9999, offerExtraPrice: 0, offerSlug: '', inclusions: ['Website'], terms: [], linkedPlanIds: [], order: 0, pages: [] };
let database, customer, admin;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Catalogue, Order, Invoice, Category, Reservation].map(model => model.init()));
  Object.assign(process.env, { PORTFOLIO_WEBSITE_URL: 'https://website.example.test', PORTFOLIO_INTEGRATION_SECRET: 'isolated-test-secret-32-characters-long', RESEND_API_KEY: 'isolated-test', FROM_EMAIL: 'sender@example.test' });
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
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const create = async body => {
  const res = response();
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) }, body: { category: 'standard_websites', ...body } }, res);
  return res;
};
const project = (fields = {}) => ({ _id: new mongoose.Types.ObjectId(), orderVisibility: 'approved', status: 'in_progress', isWebsiteProject: true,
  projectProgress: 30, paymentPolicy: null, isPartialPayment: true, currentInstallment: 2,
  installments: [{ installmentNumber: 1, percentage: 50, amount: 500, paid: true, progressThreshold: null }, { installmentNumber: 2, percentage: 50, amount: 500, paid: false, progressThreshold: 90 }], ...fields });

// --- One due rule ------------------------------------------------------------------------------------------
test('an installment is due by its own threshold; older installments keep the 40% / 75% rule', () => {
  const order = project();
  assert.equal(isInstallmentDue(order, order.installments[1]), false, 'below its 90% threshold');
  assert.equal(isInstallmentDue({ ...order, projectProgress: 90 }, order.installments[1]), true);
  assert.equal(isInstallmentDue(order, order.installments[0]), false, 'a paid installment is never due');
  assert.equal(isInstallmentDue(order, { installmentNumber: 1, paid: false, progressThreshold: null }), true, 'the first is due at once');
  const legacy = { installmentNumber: 2, paid: false, progressThreshold: null };
  assert.equal(isInstallmentDue({ projectProgress: 39 }, legacy), false);
  assert.equal(isInstallmentDue({ projectProgress: 40 }, legacy), true);
  assert.equal(isInstallmentDue({ projectProgress: 74 }, { installmentNumber: 3, paid: false, progressThreshold: null }), false);
  assert.equal(getDueUnpaidInvoiceFilter(order).installmentNumber, -1);
  assert.equal(getDueUnpaidInvoiceFilter({ ...order, projectProgress: 95 }).installmentNumber, 2);
});

test('a due installment without an invoice closes uploads and counts as payment due (decision 17)', async () => {
  const notYet = project();
  assert.equal(dueInstallment(notYet), null);
  assert.equal(await assertProjectAcceptsUpload(notYet), null, 'not due yet: uploads open');
  const due = project({ projectProgress: 90 });
  assert.equal(await Invoice.countDocuments({ orderId: due._id }), 0, 'no invoice exists for installment #2');
  assert.equal(await isProjectPaymentDue(due), true);
  assert.match(await assertProjectAcceptsUpload(due), /payment is due/i);
  const paid = project({ projectProgress: 90, installments: project().installments.map(row => ({ ...row, paid: true })) });
  assert.equal(await assertProjectAcceptsUpload(paid), null);
});

// --- Package purchase settings ----------------------------------------------------------------------------
test('purchase settings: all or none, checked, kept in one order; old packages keep their quote key', () => {
  const { billing, portalUploads, paymentOptions, ...old } = item;
  const plain = validatePackage({ ...old, id: 'starter' });
  assert.equal('billing' in plain, false, 'an older package gets no settings filled in');
  assert.equal(quotePackage(plain, []).quoteKey, quotePackage(validatePackage({ ...old, id: 'starter' }), []).quoteKey);
  const chosen = validatePackage({ ...item, id: 'starter' });
  assert.deepEqual([chosen.billing, chosen.portalUploads, chosen.paymentOptions], ['one_time', true, ['full', 'installments_2']]);
  assert.notEqual(quotePackage(chosen, []).quoteKey, quotePackage(plain, []).quoteKey, 'what is sold is part of the quote key');
  assert.throws(() => validatePackage({ ...old, id: 'starter', billing: 'one_time' }), /together/);
  assert.throws(() => validatePackage({ ...item, id: 'starter', billing: 'monthly' }), /without payment options/);
  assert.throws(() => validatePackage({ ...item, id: 'starter', billing: 'yearly' }), /billed/);
  assert.throws(() => validatePackage({ ...item, id: 'starter', portalUploads: 'yes' }), /portal uploads/);
  for (const options of [[], ['full', 'full'], ['weekly']]) assert.throws(() => validatePackage({ ...item, id: 'starter', paymentOptions: options }), /payment option/);
});

test('a new package is published only with its settings, and settings once chosen stay', async () => {
  const { billing, portalUploads, paymentOptions, ...old } = item;
  await assert.rejects(savePackage({ ...old, id: '' }, true, []), /billing, portal uploads and payment options/);
  const draft = await savePackage({ ...old, id: '', status: 'draft' }, true, []);
  assert.equal(draft.billing, undefined, 'a draft may wait');
  const saved = await savePackage({ ...item, id: '', name: 'Second' }, true, []);
  await assert.rejects(savePackage({ ...old, id: saved.id, name: 'Second' }, false, []), /billing, portal uploads and payment options/);
  // An older package (seeded without settings) is still edited and saved as before.
  await Catalogue.updateOne({ _id: 'packages' }, { $set: { 'packages.legacy': { ...old, id: 'legacy' } } });
  assert.equal((await savePackage({ ...old, id: 'legacy', name: 'Legacy renamed' }, false, [])).name, 'Legacy renamed');
});

// --- Portal uploads frozen on the project -----------------------------------------------------------------
test('the project keeps how its package was sold; uploads No closes uploads', async () => {
  const off = await savePackage({ ...item, id: '', name: 'Profile setup', portalUploads: false }, true, []);
  const res = await create({ sellingPrice: 9999, paymentType: 'full', packageId: off.id, packageQuoteKey: quotePackage(off, []).quoteKey,
    recordPayment: { paymentMethod: 'cash', transactionReference: 'CASH-1' } });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body).slice(0, 300));
  const order = await Order.findById(res.body.data._id);
  assert.deepEqual(order.projectSnapshot.salesAgreement.package.paymentOptions, ['full', 'installments_2']);
  assert.equal(order.projectSnapshot.salesAgreement.package.portalUploads, false);
  assert.match(await assertProjectAcceptsUpload(order), /does not include portal uploads/);
  // A later change to the package never changes the running project.
  await savePackage({ ...item, id: off.id, name: 'Profile setup', portalUploads: true }, false, []);
  assert.match(await assertProjectAcceptsUpload(await Order.findById(order._id)), /does not include portal uploads/);
});

// --- Reservation with its own package ---------------------------------------------------------------------
test('a reservation goes with its own package, at the reserved price, even after the offer ended', async () => {
  process.env.OFFER_RESERVATIONS_ENABLED = 'true';
  try {
    const saved = await savePackage({ ...item, id: '' }, true, []);
    const now = Date.now();
    const offerSnapshot = { slug: 'dhamaka', title: 'Dhamaka', status: 'published', endsAt: new Date(now - HOUR).toISOString(), targets: ['projects'],
      applicableCategories: ['standard_websites'], pricingRule: 'fixed_price', mainPrice: 15000, offerPrice: 3499, packageId: saved.id, quoteKey: 'reserved-key', resolvedTerms: [] };
    const reservation = await Reservation.create({ userId: customer._id, offerSlug: 'dhamaka', periodEndsAt: new Date(now - HOUR), offerSnapshot,
      regularPrice: 15000, reservedPrice: 3499, reservedAt: new Date(now - 3 * HOUR), expiresAt: new Date(now + HOUR), origin: 'customer' });
    const body = { sellingPrice: 3499, paymentType: 'full', packageId: saved.id, offerSlug: 'dhamaka', offerReservationId: String(reservation._id), offerQuoteKey: 'reserved-key' };
    assert.equal((await create({ ...body, offerQuoteKey: 'changed' })).statusCode, 409);
    assert.equal((await create({ ...body, packageId: (await savePackage({ ...item, id: '', name: 'Other' }, true, [])).id })).statusCode, 409, 'another package');
    const res = await create(body);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body).slice(0, 300));
    const order = await Order.findById(res.body.data._id).lean();
    assert.equal(order.totalAmount, 3499);
    assert.equal(order.projectSnapshot.salesAgreement.package.id, saved.id, 'the agreement records the package (gap #6 closed)');
    assert.equal(order.projectSnapshot.salesAgreement.offer.slug, 'dhamaka');
    assert.equal(String((await Reservation.findById(reservation._id).lean()).projectId), String(order._id));
  } finally { delete process.env.OFFER_RESERVATIONS_ENABLED; }
});
