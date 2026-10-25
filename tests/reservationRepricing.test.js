// Steps 3–4: reservation expiry repricing on a disposable replica set. External offer catalogue
// and mail are fixtures; nothing here reaches a real service.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const Reservation = require('../models/offerReservationModel');
const Revision = require('../models/projectPricingRevisionModel');
const Preview = require('../models/reservationActionPreviewModel');
const Notice = require('../models/reservationNoticeModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const Category = require('../models/categoryBasePriceModel');
const { EmailDraft, EmailHistory, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const createProject = require('../controller/order/adminCreateProjectOrder');
const { payProjectWallet, approveProjectPayment, rejectProjectPayment } = require('../helpers/projectPaymentSettlement');
const { reserveOffer, listReservations } = require('../helpers/offerReservations');
const repricing = require('../helpers/reservationRepricing');

const HOUR = 3600000;
let database, customer, admin, offer, catalogueDown;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Lead, Reservation, Revision, Preview, Notice, Order, Invoice, Transaction, Category, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate].map(model => model.init()));
  Object.assign(process.env, { PORTFOLIO_WEBSITE_URL: 'https://website.example.test', PORTFOLIO_INTEGRATION_SECRET: 'isolated-test-secret-32-characters-long',
    RESEND_API_KEY: 'isolated', FROM_EMAIL: 'sender@example.test', ENABLE_WHATSAPP: 'false', OFFER_RESERVATIONS_ENABLED: 'true',
    OFFER_RESERVATION_CONFIRMATIONS_ENABLED: 'false', OFFER_RESERVATION_REPRICING_ENABLED: 'true' });
  global.fetch = async url => {
    if (String(url).includes('/api/offers/live')) {
      if (catalogueDown) throw new Error('offline');
      return { ok: true, json: async () => ({ offers: [offer], catalogueOffers: [offer] }) };
    }
    if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'isolated' }) };
    throw new Error('Unexpected external request');
  };
});
after(async () => { global.fetch = realFetch; await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  catalogueDown = false;
  process.env.OFFER_RESERVATION_REPRICING_ENABLED = 'true';
  [customer, admin] = await User.create([
    { name: 'Client', email: 'client@example.test', roles: ['customer'], phone: '+919876500002', walletBalance: 20000 },
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
  ]);
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
  offer = { slug: 'test-offer', title: 'Reserved website', status: 'published', endsAt: new Date(Date.now() + HOUR).toISOString(),
    mainPrice: 10000, offerPrice: 5000, pricingRule: 'fixed_price', quoteKey: 'quote-1', resolvedTerms: ['Agreed scope'],
    targets: ['projects'], applicableCategories: ['standard_websites'], inclusions: ['Website'] };
});

function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
async function project(body = {}) {
  const res = response();
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) },
    body: { category: 'standard_websites', sellingPrice: 5000, paymentType: 'full', offerSlug: offer.slug, offerQuoteKey: offer.quoteKey, ...body } }, res);
  assert.equal(res.statusCode, 201, res.body?.message);
  return Order.findById(res.body.data._id);
}
// The reservation deadline passed an hour ago and the public offer has ended.
async function expire({ offerEnded = true } = {}) {
  const now = Date.now();
  await Reservation.collection.updateMany({}, { $set: { reservedAt: new Date(now - 73 * HOUR), expiresAt: new Date(now - HOUR) } });
  if (offerEnded) offer = { ...offer, endsAt: new Date(now - 2 * HOUR).toISOString() };
}
const firstBill = orderId => Invoice.findOne({ orderId, invoiceType: 'project' }).sort({ createdAt: 1 });
const reservation = () => Reservation.findOne();

test('expired unpaid project moves to the saved normal price with one immutable revision', async () => {
  const order = await project();
  await expire();
  const result = await repricing.reconcileOrderReservation(order._id);
  assert.equal(result.status, 'repriced'); assert.equal(result.source, 'normal_price');
  const saved = await Order.findById(order._id);
  assert.equal(saved.totalAmount, 10000); assert.equal(saved.remainingAmount, 10000); assert.equal(saved.pricingRevision, 1);
  assert.equal(saved.projectSnapshot.salesAgreement.offer, null);
  assert.equal(saved.projectSnapshot.salesAgreement.revision.previousFinalPrice, 5000);
  const bill = await firstBill(order._id);
  assert.equal(bill.amount, 10000); assert.equal(bill.status, 'unpaid');
  assert.equal(bill.lineItems.some(item => item.price < 0), false, 'No offer benefit line after normal pricing');
  assert.equal((await Invoice.findOne({ orderId: order._id, invoiceType: 'project_final' })).amount, 10000);
  const revision = await Revision.findOne();
  assert.equal(revision.before.finalPrice, 5000); assert.equal(revision.after.finalPrice, 10000); assert.equal(revision.before.invoice.amount, 5000);
  const row = await reservation();
  assert.equal(row.resolution.status, 'repriced'); assert.equal(String(row.resolution.revisionId), String(revision._id));
  assert.equal((await repricing.reconcileOrderReservation(order._id)).status, 'unchanged');
  assert.equal(await Revision.countDocuments(), 1, 'Same catalogue state never writes a second revision');
});

test('same offer extended with new terms applies its current price, then normal price after it ends', async () => {
  const order = await project();
  await expire({ offerEnded: false });
  offer = { ...offer, offerPrice: 6000, quoteKey: 'quote-2', endsAt: new Date(Date.now() + 48 * HOUR).toISOString() };
  const first = await repricing.reconcileOrderReservation(order._id);
  assert.equal(first.source, 'offer_extended'); assert.equal((await Order.findById(order._id)).totalAmount, 6000);
  assert.equal((await Revision.findOne()).offerQuoteKey, 'quote-2');
  offer = { ...offer, endsAt: new Date(Date.now() - HOUR).toISOString() };
  const second = await repricing.reconcileOrderReservation(order._id);
  assert.equal(second.source, 'normal_price'); assert.equal((await Order.findById(order._id)).totalAmount, 10000);
  assert.equal(await Revision.countDocuments(), 2);
});

test('installment project redistributes every installment in paise and bills the new first amount', async () => {
  const order = await project({ paymentType: 'partial', installmentCount: 3 });
  await expire();
  await repricing.reconcileOrderReservation(order._id);
  const saved = await Order.findById(order._id);
  assert.deepEqual(saved.installments.map(row => row.amount), [3000, 3000, 4000]);
  assert.equal((await firstBill(order._id)).amount, 3000);
});

test('payment submitted in time holds the price; after rejection the next check reprices', async () => {
  const order = await project();
  const bill = await firstBill(order._id);
  const payment = await Transaction.create({ userId: customer._id, orderId: order._id, invoiceId: bill._id, transactionId: 'in-time', amount: 5000,
    status: 'pending', paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice', description: 'UPI' });
  await expire();
  await Transaction.collection.updateOne({ _id: payment._id }, { $set: { createdAt: new Date(Date.now() - 2 * HOUR) } });
  assert.equal((await repricing.reconcileOrderReservation(order._id)).status, 'under_review');
  assert.equal((await Order.findById(order._id)).totalAmount, 5000);
  await rejectProjectPayment('in-time', admin._id, 'UTR not found');
  assert.equal((await repricing.reconcileOrderReservation(order._id)).status, 'repriced');
});

test('approval of an in-time payment after the deadline locks the reserved price', async () => {
  const order = await project();
  const bill = await firstBill(order._id);
  await Transaction.create({ userId: customer._id, orderId: order._id, invoiceId: bill._id, transactionId: 'in-time', amount: 5000,
    status: 'pending', paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice', description: 'UPI' });
  await Transaction.collection.updateOne({ transactionId: 'in-time' }, { $set: { createdAt: new Date(Date.now() - 2 * HOUR) } });
  await expire();
  assert.equal((await repricing.ensureReservationPriceCurrent(order._id)).status, 'under_review');
  await approveProjectPayment('in-time', admin._id);
  assert.ok((await reservation()).confirmedAt);
  assert.equal((await repricing.reconcileOrderReservation(order._id)).status, 'not_due');
  assert.equal((await Order.findById(order._id)).totalAmount, 5000);
});

test('late wallet payment is checked first and settles the revised price without a lock', async () => {
  const order = await project();
  await expire();
  await repricing.ensureReservationPriceCurrent(order._id);
  await payProjectWallet(customer._id, { orderId: order._id, amount: 10000 });
  const saved = await Order.findById(order._id);
  assert.equal(saved.paymentComplete, true); assert.equal(saved.paidAmount, 10000);
  assert.equal((await reservation()).confirmedAt, null);
  assert.equal((await repricing.reconcileOrderReservation(order._id)).status, 'closed');
  assert.ok((await reservation()).resolution.closedAt);
});

test('catalogue outage never changes a price and makes payment wait', async () => {
  const order = await project();
  await expire();
  catalogueDown = true;
  assert.equal((await repricing.reconcileOrderReservation(order._id)).status, 'unavailable');
  await assert.rejects(repricing.ensureReservationPriceCurrent(order._id), error => error.statusCode === 503);
  assert.equal((await Order.findById(order._id)).totalAmount, 5000);
  assert.equal(await Revision.countDocuments(), 0);
});

test('receipt above revised first installment carries to the next bill without wallet credit', async () => {
  const order = await project({ paymentType: 'partial', installmentCount: 2 });
  await payProjectWallet(customer._id, { orderId: order._id, amount: 2000 });
  await expire({ offerEnded: false });
  offer = { ...offer, offerPrice: 3000, quoteKey: 'quote-cheaper', endsAt: new Date(Date.now() + 48 * HOUR).toISOString() };
  const result = await repricing.reconcileOrderReservation(order._id);
  assert.equal(result.status, 'repriced');
  const updated = await Order.findById(order._id);
  assert.equal(updated.totalAmount, 3000); assert.equal(updated.paidAmount, 2000); assert.equal(updated.remainingAmount, 1000);
  assert.equal(updated.installments[0].paid, true); assert.equal(updated.currentInstallment, 2);
  assert.equal((await User.findById(customer._id)).walletBalance, 18000);
  const bills = await Invoice.find({ orderId: order._id, invoiceType: 'project' }).sort({ installmentNumber: 1 });
  assert.deepEqual(bills.map(bill => [bill.amount, bill.amountPaid, bill.status]), [[1500, 1500, 'paid'], [1500, 500, 'partially_paid']]);
});

test('price-locked, cancelled and switched-off cases are never repriced', async () => {
  const locked = await project({ recordPayment: { paymentMethod: 'cash' } });
  await expire();
  assert.equal((await repricing.reconcileOrderReservation(locked._id)).status, 'not_due');
  await Order.deleteMany({}); await Invoice.deleteMany({}); await Reservation.deleteMany({}); await Transaction.deleteMany({});
  offer = { ...offer, endsAt: new Date(Date.now() + HOUR).toISOString() };
  const cancelled = await project();
  await Order.updateOne({ _id: cancelled._id }, { $set: { orderVisibility: 'cancelled' } });
  await expire();
  assert.equal((await repricing.reconcileOrderReservation(cancelled._id)).status, 'closed');
  assert.equal((await Order.findById(cancelled._id)).totalAmount, 5000);
  process.env.OFFER_RESERVATION_REPRICING_ENABLED = 'false';
  assert.equal((await repricing.reconcileDueReservations()).length, 0);
});

test('concurrent checks write exactly one revision', async () => {
  const order = await project();
  await expire();
  const results = await Promise.all([1, 2, 3].map(() => repricing.reconcileOrderReservation(order._id)));
  assert.equal(results.filter(row => row.status === 'repriced').length, 1);
  assert.equal(await Revision.countDocuments(), 1);
  assert.equal((await Order.findById(order._id)).pricingRevision, 1);
});

test('scheduled batch reads the catalogue once and isolates each project', async () => {
  const one = await project();
  offer = { ...offer, quoteKey: 'quote-1' };
  customer = await User.create({ name: 'Second', email: 'second@example.test', roles: ['customer'], phone: '+919876500003' });
  const two = await project();
  await expire();
  let reads = 0; const fetchFixture = global.fetch;
  global.fetch = async (url, options) => { if (String(url).includes('/api/offers/live')) reads++; return fetchFixture(url, options); };
  try {
    const results = await repricing.reconcileDueReservations();
    assert.equal(results.length, 2); assert.ok(results.every(row => row.status === 'repriced'));
    assert.equal(reads, 1);
  } finally { global.fetch = fetchFixture; }
  assert.equal((await Order.findById(one._id)).totalAmount, 10000); assert.equal((await Order.findById(two._id)).totalAmount, 10000);
});

test('customer may reserve again in a new offer period; the expired reservation stays in history', async () => {
  const member = await User.create({ name: 'Member', email: 'member@example.test', roles: ['member'], phone: '+919876500004' });
  const first = await reserveOffer({ userId: member._id, offerSlug: offer.slug, quoteKey: offer.quoteKey });
  await Reservation.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.reservation.id) }, { $set: { expiresAt: new Date(Date.now() - HOUR) } });
  // Same period: the expired record is returned, no second reservation.
  assert.equal((await reserveOffer({ userId: member._id, offerSlug: offer.slug, quoteKey: offer.quoteKey })).reservation.id, first.reservation.id);
  offer = { ...offer, endsAt: new Date(Date.now() + 20 * HOUR).toISOString(), quoteKey: 'quote-period-2' };
  const second = await reserveOffer({ userId: member._id, offerSlug: offer.slug, quoteKey: offer.quoteKey });
  assert.equal(second.reused, false); assert.notEqual(second.reservation.id, first.reservation.id);
  const history = (await listReservations(member._id)).reservations;
  assert.deepEqual(history.map(row => row.status), ['reserved', 'expired']);
  assert.equal(await Lead.countDocuments(), 1, 'Same linked lead is reused');
});

// Step 7 (owner decision 6): repricing changes price only; the frozen payment policy and the
// upload counter carry on exactly as agreed.
const { getPaymentAccess } = require('../helpers/offerPaymentPolicy');
for (const [mode, expectAllowed] of [['advance', false], ['limited_uploads', true], ['pay_later', true]]) {
  test(`expiry repricing keeps the frozen ${mode} upload policy and its counter`, async () => {
    offer = { ...offer, paymentPolicy: { mode, cycleScope: 'first_purchase', dueDays: 3, uploadAllowance: 2, reminderOffsets: [] } };
    const order = await project();
    await Order.updateOne({ _id: order._id }, { $set: { paymentPolicyUploads: 1 } });
    const policyBefore = (await Order.findById(order._id)).paymentPolicy;
    await expire();
    assert.equal((await repricing.reconcileOrderReservation(order._id)).status, 'repriced');
    const saved = await Order.findById(order._id);
    assert.deepEqual(saved.paymentPolicy, policyBefore);
    assert.equal(saved.paymentPolicyUploads, 1, 'Counter is never reset');
    const access = await getPaymentAccess(saved);
    assert.equal(access.mode, mode); assert.equal(access.allowed, expectAllowed);
    if (mode === 'limited_uploads') assert.equal(access.uploadsRemaining, 1);
  });
}

// Step 5: admin extension.
const { extendReservation } = require('../helpers/offerReservations');
test('admin extension keeps history, moves the deadline forward, notifies with the exact date and blocks repricing', async () => {
  const order = await project();
  await expire();
  const row = await reservation();
  const until = new Date(Date.now() + 5 * 24 * HOUR);
  await assert.rejects(extendReservation({ reservationId: row._id, actorId: customer._id, until, reason: 'x' }), error => error.statusCode === 403);
  await assert.rejects(extendReservation({ reservationId: row._id, actorId: admin._id, until, reason: '' }), /reason/);
  await assert.rejects(extendReservation({ reservationId: row._id, actorId: admin._id, until: new Date(Date.now() - HOUR), reason: 'late' }), /future/);
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'true';
  try {
    const result = await extendReservation({ reservationId: row._id, actorId: admin._id, until, reason: 'Customer bank holiday' });
    assert.equal(result.reservation.status, 'reserved');
    assert.ok(['sent', 'paused'].includes(result.notice), result.notice);
    assert.ok(await EmailDraft.exists({ event: 'offer.reservation.extended' }));
  } finally { process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'false'; }
  const saved = await reservation();
  assert.equal(saved.expiresAt.getTime(), row.expiresAt.getTime(), 'Original deadline stays as history');
  assert.equal(saved.extendedUntil.getTime(), until.getTime());
  assert.equal(saved.extensions.length, 1); assert.equal(saved.extensions[0].reason, 'Customer bank holiday');
  assert.equal((await repricing.reconcileOrderReservation(order._id)).status, 'not_due');
  await assert.rejects(extendReservation({ reservationId: row._id, actorId: admin._id, until: new Date(until.getTime() - HOUR), reason: 'shorter' }), /later than the current/);
  // A payment inside the extended deadline locks the reserved price.
  await payProjectWallet(customer._id, { orderId: order._id, amount: 5000 });
  assert.ok((await reservation()).confirmedAt);
});
test('extension is refused once the price was revised; force-apply is the path then', async () => {
  const order = await project();
  await expire();
  await repricing.reconcileOrderReservation(order._id);
  await assert.rejects(extendReservation({ reservationId: (await reservation())._id, actorId: admin._id, until: new Date(Date.now() + 24 * HOUR), reason: 'late ask' }), /force-apply/);
});

// Step 6: admin force-apply.
test('force-apply restores the saved reserved price through a previewed, confirmed, single revision', async () => {
  const order = await project();
  await expire();
  await repricing.reconcileOrderReservation(order._id);
  const row = await reservation();
  await assert.rejects(repricing.forceApplyPreview({ reservationId: row._id, orderId: order._id, actorId: customer._id }), error => error.statusCode === 403);
  const preview = await repricing.forceApplyPreview({ reservationId: row._id, orderId: order._id, actorId: admin._id });
  assert.deepEqual([preview.before.finalPrice, preview.after.finalPrice, preview.pricingRevision], [10000, 5000, 1]);
  // The offer was edited and archived meanwhile; the saved terms are used regardless.
  offer = { ...offer, offerPrice: 9000, status: 'archived' };
  const base = { reservationId: row._id, orderId: order._id, actorId: admin._id, reason: 'Customer paid by cheque on time', expectedRevision: preview.pricingRevision, previewToken: preview.previewToken };
  await assert.rejects(repricing.forceApplyReservation({ ...base, confirmSlug: 'wrong' }), /offer code/);
  await assert.rejects(repricing.forceApplyReservation({ ...base, confirmSlug: row.offerSlug, expectedRevision: 0 }), /changed since the preview/);
  await assert.rejects(repricing.forceApplyReservation({ ...base, confirmSlug: row.offerSlug, reason: '' }), /reason/);
  const applied = await repricing.forceApplyReservation({ ...base, confirmSlug: row.offerSlug });
  assert.equal(applied.finalPrice, 5000);
  const saved = await Order.findById(order._id);
  assert.equal(saved.totalAmount, 5000); assert.equal(saved.pricingRevision, 2);
  assert.equal((await firstBill(order._id)).amount, 5000);
  const revision = await Revision.findOne({ revision: 2 });
  assert.equal(revision.reason, 'force_apply'); assert.equal(revision.source, 'reserved_terms'); assert.equal(String(revision.actorId), String(admin._id));
  const after = await reservation();
  assert.equal(after.resolution.status, 'force_applied'); assert.equal(after.confirmedAt, null, 'No implicit lock or new 72 hours');
  assert.equal(after.expiresAt.getTime(), row.expiresAt.getTime());
  assert.equal((await repricing.reconcileOrderReservation(order._id)).status, 'not_due', 'Automation leaves a forced price alone');
  await assert.rejects(repricing.forceApplyReservation({ ...base, confirmSlug: row.offerSlug, expectedRevision: 2 }), /already force-applied/);
});
test('force-apply attaches an unused expired customer reservation to a project created without an offer', async () => {
  const reserved = await reserveOffer({ userId: customer._id, offerSlug: offer.slug, quoteKey: offer.quoteKey });
  await expire();
  const res = response();
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) },
    body: { category: 'standard_websites', sellingPrice: 10000, paymentType: 'full' } }, res);
  assert.equal(res.statusCode, 201, res.body?.message);
  const orderId = res.body.data._id;
  const preview = await repricing.forceApplyPreview({ reservationId: reserved.reservation.id, orderId, actorId: admin._id });
  assert.deepEqual([preview.before.finalPrice, preview.after.finalPrice], [10000, 5000]);
  await repricing.forceApplyReservation({ reservationId: reserved.reservation.id, orderId, actorId: admin._id, reason: 'Reserved in time', confirmSlug: offer.slug, expectedRevision: 0, previewToken: preview.previewToken });
  const saved = await Order.findById(orderId);
  assert.equal(saved.totalAmount, 5000); assert.equal(String(saved.offerReservationId), reserved.reservation.id);
  assert.equal(saved.projectSnapshot.salesAgreement.offer.slug, offer.slug);
  assert.equal(String((await Reservation.findById(reserved.reservation.id)).projectId), String(orderId));
});
test('force-apply is refused for a locked price, another customer or another category', async () => {
  const paid = await project({ recordPayment: { paymentMethod: 'cash' } });
  await expire();
  const row = await reservation();
  await assert.rejects(repricing.forceApplyPreview({ reservationId: row._id, orderId: paid._id, actorId: admin._id }), /locked/);
  const stranger = await User.create({ name: 'Other', email: 'other@example.test', roles: ['customer'], phone: '+919876500009' });
  const res = response();
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(stranger._id) }, body: { category: 'standard_websites', sellingPrice: 10000, paymentType: 'full' } }, res);
  assert.equal(res.statusCode, 201, res.body?.message);
  await assert.rejects(repricing.forceApplyPreview({ reservationId: row._id, orderId: res.body.data._id, actorId: admin._id }), /different customer/);
  const unused = await reserveOffer({ userId: stranger._id, offerSlug: offer.slug, quoteKey: offer.quoteKey }).catch(() => null);
  await Category.create({ category: 'app_development', basePrice: 20000 });
  const app = response();
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(stranger._id) }, body: { category: 'app_development', sellingPrice: 20000, paymentType: 'full' } }, app);
  assert.equal(app.statusCode, 201, app.body?.message);
  if (unused) await assert.rejects(repricing.forceApplyPreview({ reservationId: unused.reservation.id, orderId: app.body.data._id, actorId: admin._id }), /category/);
  else {
    const snapshot = { ...offer, applicableCategories: ['standard_websites'] };
    const [manual] = await Reservation.create([{ userId: stranger._id, offerSlug: offer.slug, periodEndsAt: new Date(offer.endsAt), offerSnapshot: snapshot,
      regularPrice: 10000, reservedPrice: 5000, reservedAt: new Date(Date.now() - 80 * HOUR), expiresAt: new Date(Date.now() - 8 * HOUR), origin: 'customer' }]);
    await assert.rejects(repricing.forceApplyPreview({ reservationId: manual._id, orderId: app.body.data._id, actorId: admin._id }), /category/);
  }
});

test('deadline crossing during wallet submission retries price preparation and debits once', async () => {
  const order = await project();
  await Reservation.collection.updateOne({ _id: order.offerReservationId }, { $set: { expiresAt: new Date(Date.now() + 500) } });
  offer = { ...offer, endsAt: new Date(Date.now() - HOUR).toISOString() };
  const save = Transaction.prototype.save; let delayed = false;
  Transaction.prototype.save = async function (...args) {
    if (!delayed && this.type === 'payment' && this.paymentMethod === 'wallet') {
      delayed = true;
      assert.equal((await firstBill(order._id)).amount, 5000, 'Precheck happened while the reservation was running');
      await new Promise(resolve => setTimeout(resolve, 650));
    }
    return save.apply(this, args);
  };
  try { await payProjectWallet(customer._id, { orderId: order._id, amount: 5000 }); }
  finally { Transaction.prototype.save = save; }
  const updated = await Order.findById(order._id);
  assert.equal(updated.totalAmount, 10000); assert.equal(updated.paidAmount, 5000); assert.equal(updated.paymentComplete, false);
  assert.equal((await User.findById(customer._id)).walletBalance, 15000);
  assert.equal(await Transaction.countDocuments({ type: 'payment', status: 'completed' }), 1);
  assert.equal((await reservation()).confirmedAt, null);
});

test('force preview is mandatory, actor-bound, expires, and detects a new payment', async () => {
  const order = await project(); await expire(); await repricing.reconcileOrderReservation(order._id);
  const row = await reservation();
  const command = { reservationId: row._id, orderId: order._id, actorId: admin._id, reason: 'Review reserved agreement', confirmSlug: row.offerSlug, expectedRevision: 1 };
  await assert.rejects(repricing.forceApplyReservation(command), /fresh preview/);
  const first = await repricing.forceApplyPreview(command);
  const otherAdmin = await User.create({ name: 'Second admin', email: 'second-admin@example.test', roles: ['admin'] });
  await assert.rejects(repricing.forceApplyReservation({ ...command, actorId: otherAdmin._id, previewToken: first.previewToken }), /changed since the preview/);
  await payProjectWallet(customer._id, { orderId: order._id, amount: 1000 });
  await assert.rejects(repricing.forceApplyReservation({ ...command, previewToken: first.previewToken }), /changed since the preview/);
  const next = await repricing.forceApplyPreview(command);
  await Preview.updateOne({ _id: next.previewToken }, { $set: { expiresAt: new Date(0) } });
  await assert.rejects(repricing.forceApplyReservation({ ...command, previewToken: next.previewToken }), /changed since the preview/);
  const final = await repricing.forceApplyPreview(command);
  const applied = await repricing.forceApplyReservation({ ...command, previewToken: final.previewToken });
  assert.equal(applied.finalPrice, 5000); assert.ok((await Preview.findById(final.previewToken)).usedAt);
});

test('scheduler visits later due projects and revisits an extended offer on its next check', async () => {
  for (let i = 0; i < 3; i++) { offer = { ...offer, slug: `batch-${i}`, quoteKey: `batch-quote-${i}` }; await project(); }
  await expire();
  const one = await repricing.reconcileDueReservations({ limit: 2 });
  const two = await repricing.reconcileDueReservations({ limit: 2 });
  assert.equal(one.length, 2); assert.equal(two.length, 1);
  assert.equal(new Set([...one, ...two].map(row => row.id)).size, 3);
  assert.equal(await Revision.countDocuments(), 3);
  offer = { ...offer, endsAt: new Date(Date.now() + HOUR).toISOString(), offerPrice: 6000, quoteKey: 'new-batch-period' };
  await Reservation.updateMany({}, { $set: { pricingNextCheckAt: new Date(0) } });
  await repricing.reconcileDueReservations();
  assert.equal(await Revision.countDocuments(), 4);
});

test('offer terms-only revision updates printable terms and preserves frozen package terms', async () => {
  offer.resolvedTerms = ['Old offer terms']; const order = await project();
  await Order.updateOne({ _id: order._id }, { $set: { 'projectSnapshot.salesAgreement.baseTerms': ['Saved scope terms'], 'projectSnapshot.salesAgreement.terms': ['Saved scope terms', 'Old offer terms'] } });
  await expire({ offerEnded: false });
  offer = { ...offer, resolvedTerms: ['New offer terms'], quoteKey: 'terms-only-change' };
  await repricing.reconcileOrderReservation(order._id);
  const agreement = (await Order.findById(order._id)).projectSnapshot.salesAgreement;
  assert.deepEqual(agreement.terms, ['Saved scope terms', 'New offer terms']);
  assert.equal(agreement.finalPrice, 5000); assert.equal(await Revision.countDocuments(), 1);
  await repricing.reconcileOrderReservation(order._id); assert.equal(await Revision.countDocuments(), 1);
});

test('surplus credits wallet once, derives paid state, and rolls back on revision failure', async () => {
  const order = await project(); await payProjectWallet(customer._id, { orderId: order._id, amount: 4000 });
  await expire({ offerEnded: false }); offer = { ...offer, offerPrice: 2000, quoteKey: 'credit-price' };
  const create = Revision.create;
  Revision.create = async () => { throw new Error('Injected revision failure'); };
  try { await assert.rejects(repricing.reconcileOrderReservation(order._id), /Injected revision/); } finally { Revision.create = create; }
  assert.equal((await User.findById(customer._id)).walletBalance, 16000);
  assert.equal(await Transaction.countDocuments({ type: 'refund' }), 0);
  assert.equal((await Order.findById(order._id)).totalAmount, 5000);
  const result = await repricing.reconcileOrderReservation(order._id);
  assert.equal(result.walletCredit, 2000); assert.equal((await User.findById(customer._id)).walletBalance, 18000);
  const updated = await Order.findById(order._id);
  assert.equal(updated.paidAmount, 2000); assert.equal(updated.remainingAmount, 0); assert.equal(updated.paymentComplete, true);
  assert.equal((await firstBill(order._id)).status, 'paid');
  await repricing.reconcileOrderReservation(order._id); assert.equal(await Transaction.countDocuments({ type: 'refund' }), 1);
});

test('extension notice survives delivery failure and retries with the same dedupe key', async () => {
  const order = await project(); const row = await reservation();
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'true';
  const fetchFixture = global.fetch; let failDelivery = true; const keys = [];
  global.fetch = async (url, options) => {
    if (String(url).includes('api.resend.com')) {
      keys.push(options.headers['Idempotency-Key']);
      if (failDelivery) return { ok: false, json: async () => ({}) };
    }
    return fetchFixture(url, options);
  };
  try {
    const result = await extendReservation({ reservationId: row._id, actorId: admin._id, until: new Date(Date.now() + 100 * HOUR), reason: 'Bank delay' });
    assert.equal(result.notice, 'failed'); assert.equal((await Notice.findOne()).status, 'failed');
    failDelivery = false;
    await Notice.updateOne({}, { $set: { nextAttemptAt: new Date(0) } });
    // Isolate the extension delivery from the unrelated original confirmation.
    await Reservation.updateOne({ _id: row._id }, { $set: { confirmationStatus: 'sent' } });
    await require('../helpers/offerReservationConfirmation').drainReservationConfirmations();
    assert.equal((await Notice.findOne()).status, 'sent'); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
    await require('../helpers/offerReservationConfirmation').drainReservationConfirmations(); assert.equal(keys.length, 2);
    assert.equal((await Order.findById(order._id)).totalAmount, 5000);
  } finally { global.fetch = fetchFixture; process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'false'; }
});

test('migration previews without writes, backfills reservation period and replaces only the old unique index', async () => {
  await reserveOffer({ userId: customer._id, offerSlug: offer.slug, quoteKey: offer.quoteKey });
  const row = await reservation();
  await Reservation.collection.updateOne({ _id: row._id }, { $unset: { periodEndsAt: '' } });
  await Reservation.collection.createIndex({ userId: 1, offerSlug: 1 }, { unique: true });
  const { migrateReservationIndexes } = require('../scripts/migrateReservationIndexes');
  const preview = await migrateReservationIndexes({ db: mongoose.connection.db });
  assert.equal(preview.periodBackfills, 1); assert.equal(preview.applied, false);
  assert.equal((await Reservation.collection.findOne({ _id: row._id })).periodEndsAt, undefined);
  const result = await migrateReservationIndexes({ db: mongoose.connection.db, apply: true });
  assert.equal(result.applied, true); assert.equal((await reservation()).periodEndsAt.toISOString(), offer.endsAt);
  const indexes = await Reservation.collection.indexes();
  assert.equal(indexes.some(index => index.name === 'userId_1_offerSlug_1'), false);
  assert.ok(indexes.some(index => index.name === 'userId_1_offerSlug_1_periodEndsAt_1' && index.unique));
  assert.equal((await migrateReservationIndexes({ db: mongoose.connection.db, apply: true })).periodBackfills, 0);
});

test('combined rejection after repricing cannot refund a wallet surplus twice', async () => {
  const order = await project();
  await payProjectWallet(customer._id, { orderId: order._id, amount: 4000, parentTransactionId: 'combined-audit' });
  const bill = await firstBill(order._id);
  await expire({ offerEnded: false });
  offer = { ...offer, offerPrice: 2000, quoteKey: 'combined-cheaper' };
  await repricing.reconcileOrderReservation(order._id);
  assert.equal((await User.findById(customer._id)).walletBalance, 18000);
  await Transaction.create({ userId: customer._id, orderId: order._id, invoiceId: bill._id, transactionId: 'combined-audit', amount: 1000,
    status: 'pending', paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice', description: 'Late combined UPI' });
  await rejectProjectPayment('combined-audit', admin._id, 'Not received');
  assert.equal((await User.findById(customer._id)).walletBalance, 20000);
  assert.equal((await Order.findById(order._id)).paidAmount, 0);
});

for (const revisedPrice of [0, 1234.56]) test(`concurrent repricing to ${revisedPrice} credits every paise once`, async () => {
  const order = await project(); await payProjectWallet(customer._id, { orderId: order._id, amount: 2000 });
  await expire({ offerEnded: false }); offer = { ...offer, offerPrice: revisedPrice, quoteKey: 'credit-final' };
  await Promise.all([repricing.reconcileOrderReservation(order._id), repricing.reconcileOrderReservation(order._id)]);
  const updated = await Order.findById(order._id);
  assert.equal(updated.totalAmount, revisedPrice); assert.equal(updated.paidAmount, revisedPrice); assert.equal(updated.paymentComplete, true);
  assert.equal(Math.round((await User.findById(customer._id)).walletBalance * 100), 2000000 - Math.round(revisedPrice * 100));
  assert.equal(await Transaction.countDocuments({ type: 'refund' }), 1); assert.equal(await Revision.countDocuments(), 1);
});

test('combined rejection refunds carried receipts from both installment invoices exactly once', async () => {
  const order = await project({ paymentType: 'partial', installmentCount: 2 });
  await payProjectWallet(customer._id, { orderId: order._id, amount: 2000, parentTransactionId: 'carry-parent' });
  const bill = await firstBill(order._id);
  await expire({ offerEnded: false }); offer = { ...offer, offerPrice: 3000, quoteKey: 'carry-cheaper' };
  await repricing.reconcileOrderReservation(order._id);
  await Transaction.create({ userId: customer._id, orderId: order._id, invoiceId: bill._id, transactionId: 'carry-parent', amount: 500,
    status: 'pending', paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice', description: 'Late UPI' });
  await rejectProjectPayment('carry-parent', admin._id, 'Not received');
  assert.equal((await User.findById(customer._id)).walletBalance, 20000);
  const updated = await Order.findById(order._id);
  assert.equal(updated.paidAmount, 0); assert.equal(updated.currentInstallment, 1);
  const bills = await Invoice.find({ orderId: order._id, invoiceType: 'project' });
  assert.ok(bills.every(item => item.amountPaid === 0 && item.status === 'unpaid'));
});

test('extension and delivery event roll back together when the outbox cannot save', async () => {
  await project(); const row = await reservation();
  const create = Notice.create; Notice.create = async () => { throw new Error('Injected outbox failure'); };
  try { await assert.rejects(extendReservation({ reservationId: row._id, actorId: admin._id, until: new Date(Date.now() + 100 * HOUR), reason: 'Bank delay' }), /Injected outbox/); }
  finally { Notice.create = create; }
  const fresh = await reservation(); assert.equal(fresh.extendedUntil, null); assert.equal(fresh.extensions.length, 0);
  assert.equal(await Notice.countDocuments(), 0);
});

test('migration refuses invalid legacy reservation data without changing indexes', async () => {
  await Reservation.collection.insertOne({ userId: customer._id, offerSlug: 'invalid-legacy', offerSnapshot: { endsAt: 'invalid' } });
  const indexes = await Reservation.collection.indexes();
  const report = await require('../scripts/migrateReservationIndexes').migrateReservationIndexes({ db: mongoose.connection.db, apply: true });
  assert.equal(report.blocked, true); assert.equal(report.applied, false); assert.equal(report.invalid.length, 1);
  assert.deepEqual(await Reservation.collection.indexes(), indexes);
});
