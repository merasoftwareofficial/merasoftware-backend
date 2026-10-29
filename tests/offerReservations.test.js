const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const Reservation = require('../models/offerReservationModel');
const { EmailDraft, EmailHistory, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { reserveOffer, listReservations } = require('../helpers/offerReservations');
const { drainReservationConfirmations } = require('../helpers/offerReservationConfirmation');
const convertLead = require('../controller/lead/convertLead');
const createProject = require('../controller/order/adminCreateProjectOrder');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const Category = require('../models/categoryBasePriceModel');
const { payProjectWallet, approveProjectPayment, rejectProjectPayment } = require('../helpers/projectPaymentSettlement');
const { appendProjectNode, editProjectNode, resetProjectTimeline } = require('../helpers/projectNodeService');
const nodeController = require('../controller/order/projectNodeController');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
let database, member, customer, offer, deliveries, apiServer, apiOrigin;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Lead, Reservation, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate, Order, Invoice, Transaction, Category].map(model => model.init()));
  process.env.PORTFOLIO_WEBSITE_URL = 'https://website.example.test';
  process.env.PORTFOLIO_INTEGRATION_SECRET = 'isolated-test-secret-32-characters-long';
  process.env.RESEND_API_KEY = 'isolated-test';
  process.env.FROM_EMAIL = 'sender@example.test';
  process.env.ENABLE_WHATSAPP = 'false';
  process.env.OFFER_RESERVATIONS_ENABLED = 'true';
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'true';
  global.fetch = async url => {
    if (String(url).includes('/api/offers/live')) return { ok: true, json: async () => ({ offers: [offer], catalogueOffers: [offer] }) };
    if (String(url).includes('api.resend.com')) { deliveries++; return { ok: true, json: async () => ({ id: 'isolated-provider-id' }) }; }
    throw new Error('Unexpected external request');
  };
  process.env.TOKEN_SECRET_KEY = 'reservation-isolated-session-secret';
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/offer-reservations', require('../middleware/authToken'), require('../routes/offerReservations'));
  await new Promise(resolve => { apiServer = app.listen(0, '127.0.0.1', resolve); });
  apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
});
after(async () => { global.fetch = realFetch; await new Promise(resolve => apiServer.close(resolve)); await mongoose.disconnect(); if (database) await database.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  // Signup now always saves a phone (Step 2); phoneless legacy members are tested separately.
  [member, customer] = await User.create([
    { name: 'Member', email: 'member@example.test', roles: ['member'], phone: '+919876500001' },
    { name: 'Client', email: 'client@example.test', roles: ['customer'], phone: '+919876500002' },
  ]);
  deliveries = 0;
  process.env.OFFER_RESERVATIONS_ENABLED = 'true';
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'true';
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
  offer = { slug: 'test-offer', title: 'Reserved website', status: 'published', endsAt: new Date(Date.now() + 3600000).toISOString(),
    mainPrice: 10000, offerPrice: 5000, pricingRule: 'fixed_price', quoteKey: 'current-server-quote', resolvedTerms: ['Agreed scope'], targets: ['projects'], applicableCategories: ['standard_websites'], inclusions: ['Website'] };
});
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
async function project(body = {}) {
  // Keep this suite's financial fixtures free from asynchronous dispatch races.
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'false';
  const admin = await User.findOneAndUpdate({ email: 'admin@example.test' }, { $setOnInsert: { name: 'Admin', roles: ['admin'] } }, { upsert: true, new: true });
  const res = response();
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) },
    body: { category: 'standard_websites', sellingPrice: 5000, paymentType: 'full', offerSlug: offer.slug, offerQuoteKey: offer.quoteKey, ...body } }, res);
  return res;
}
const reserve = (user = member, overrides = {}) => reserveOffer({ userId: user._id, offerSlug: offer.slug, quoteKey: offer.quoteKey, ...overrides });
test('member reservation creates one linked lead without promoting the account', async () => {
  const result = await reserve();
  assert.equal(result.reservation.status, 'reserved');
  assert.equal(new Date(result.reservation.expiresAt) - new Date(result.reservation.reservedAt), 72 * 3600000);
  const lead = await Lead.findOne({ reservationUserId: member._id });
  assert.ok(lead); assert.equal(lead.convertedToUserId, null);
  assert.deepEqual((await User.findById(member._id)).roles, ['member']);
  assert.equal((await Reservation.findOne()).leadId.toString(), lead._id.toString());
});
test('existing customer reserves without creating a lead', async () => {
  await reserve(customer); assert.equal(await Lead.countDocuments(), 0);
});
test('concurrent reserve and replay preserve the original timer and create one lead', async () => {
  const results = await Promise.all([reserve(), reserve()]);
  assert.equal(results[0].reservation.id, results[1].reservation.id);
  assert.equal(await Reservation.countDocuments(), 1); assert.equal(await Lead.countDocuments(), 1);
  offer.endsAt = new Date(0).toISOString(); offer.quoteKey = 'changed';
  const retry = await reserve(); assert.equal(retry.reused, true);
  assert.equal(new Date(retry.reservation.expiresAt).getTime(), new Date(results[0].reservation.expiresAt).getTime());
});
test('too early, expired, archived, service-only and stale-quote requests do not write anything', async () => {
  for (const patch of [
    { endsAt: new Date(Date.now() + 25 * 3600000).toISOString() }, { endsAt: new Date(0).toISOString() },
    { status: 'archived' }, { targets: ['service_plans'] },
  ]) {
    const saved = { ...offer }; Object.assign(offer, patch);
    await assert.rejects(reserve(), error => error.statusCode === 409); offer = saved;
  }
  await assert.rejects(reserve(member, { quoteKey: 'stale' }), error => error.statusCode === 409);
  assert.equal(await Reservation.countDocuments(), 0); assert.equal(await Lead.countDocuments(), 0);
});
test('each offer sets when Reserve opens; refusals explain the real reason', async () => {
  const hours = value => new Date(Date.now() + value * 3600000).toISOString();
  const refused = async (patch, message) => {
    const saved = { ...offer }; Object.assign(offer, patch);
    try { await assert.rejects(reserve(), error => error.statusCode === 409 && message.test(error.message), JSON.stringify(patch)); } finally { offer = saved; }
  };
  // Without the field the original 24 hours apply.
  await refused({ endsAt: hours(25) }, /^Reservation opens on .+ IST\.$/);
  await refused({ endsAt: hours(30), reserveWindowHours: 24 }, /^Reservation opens on/);
  await refused({ endsAt: hours(50), reserveWindowHours: 48 }, /^Reservation opens on/);
  // Invalid stored values fall back to 24 hours instead of opening early.
  for (const reserveWindowHours of [0, 721, 2.5, '48']) await refused({ endsAt: hours(30), reserveWindowHours }, /^Reservation opens on/);
  await refused({ targets: ['service_plans'] }, /^This offer cannot be reserved\. Please enquire about it instead\.$/);
  await refused({ endsAt: new Date(0).toISOString() }, /^This offer has ended\.$/);
  await refused({ status: 'draft' }, /^This offer is not available\.$/);
  assert.equal(await Reservation.countDocuments(), 0);
  // A 48-hour window accepts 30 hours before the end; the hold is still 72 hours.
  Object.assign(offer, { endsAt: hours(30), reserveWindowHours: 48 });
  const result = await reserve();
  assert.equal(new Date(result.reservation.expiresAt) - new Date(result.reservation.reservedAt), 72 * 3600000);
});
test('guest, disabled and deleted accounts cannot reserve or read history', async () => {
  for (const patch of [{ isGuest: true }, { isActive: false }, { deletedAt: new Date() }]) {
    await User.updateOne({ _id: member._id }, { $set: { isGuest: false, isActive: true, deletedAt: null, ...patch } });
    await assert.rejects(reserve(), error => error.statusCode === 403);
    await assert.rejects(listReservations(member._id), error => error.statusCode === 403);
  }
});
test('expired records remain visible and histories are owner-scoped', async () => {
  await reserve();
  // Raw storage simulates elapsed time without weakening immutable deadline fields.
  await Reservation.collection.updateOne({}, { $set: { expiresAt: new Date(0) } });
  const own = await listReservations(member._id);
  assert.equal(own.reservations.length, 1); assert.equal(own.reservations[0].status, 'expired');
  assert.equal((await listReservations(customer._id)).reservations.length, 0);
});
test('reservation save failure rolls back the new lead', async () => {
  const create = Reservation.create;
  Reservation.create = async () => { throw new Error('Injected reservation failure'); };
  try { await assert.rejects(reserve(), /Injected/); } finally { Reservation.create = create; }
  assert.equal(await Lead.countDocuments(), 0); assert.equal(await Reservation.countDocuments(), 0);
});
test('confirmation uses existing mail controls and durable dedupe', async () => {
  await reserve(); await drainReservationConfirmations();
  assert.equal(deliveries, 1);
  assert.equal((await Reservation.findOne()).confirmationStatus, 'sent');
  await Reservation.updateOne({}, { $set: { confirmationStatus: 'pending', confirmationNextAttemptAt: new Date(0) } });
  await drainReservationConfirmations(); assert.equal(deliveries, 1);
  assert.equal(await EmailDraft.countDocuments({ event: 'offer.reserved' }), 1);
});
test('confirmation off pauses delivery and retries after enabling', async () => {
  await EmailPolicy.create({ event: 'offer.reserved', mode: 'off' });
  await reserve(); await drainReservationConfirmations();
  assert.equal(deliveries, 0); assert.equal((await Reservation.findOne()).confirmationStatus, 'paused');
  await EmailPolicy.updateOne({}, { $set: { mode: 'auto' } });
  await Reservation.updateOne({}, { $set: { confirmationNextAttemptAt: new Date(0) } });
  await drainReservationConfirmations(); assert.equal(deliveries, 1);
});
test('conversion rejects an edited lead email that would detach reservation identity', async () => {
  const admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
  await reserve(); const lead = await Lead.findOne(); lead.phone = '9999999999'; lead.email = 'someoneelse@example.test'; await lead.save();
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await convertLead({ userId: admin._id, userRole: 'admin', params: { leadId: lead._id }, body: { upgradeExisting: true } }, res);
  assert.equal(res.statusCode, 409); assert.deepEqual((await User.findById(member._id)).roles, ['member']);
  assert.equal(await User.countDocuments({ email: lead.email }), 0);
});
test('reservation account converts in place and retains the same My Offers history', async () => {
  const admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
  const first = await reserve(); const lead = await Lead.findOne(); lead.phone = '9999999999'; await lead.save();
  const res = response();
  await convertLead({ userId: admin._id, userRole: 'admin', params: { leadId: lead._id }, body: { upgradeExisting: true } }, res);
  assert.equal(res.statusCode, 200, res.body.message);
  assert.equal(String(res.body.data.userId), String(member._id));
  assert.deepEqual((await User.findById(member._id)).roles, ['customer']);
  assert.equal((await listReservations(member._id)).reservations[0].id, first.reservation.id);
});
test('admin project auto-reserves outside public final-24h window and creation retry keeps deadline', async () => {
  offer.endsAt = new Date(Date.now() + 5 * 86400000).toISOString();
  const body = { creationKey: 'reservation-auto-project-01' };
  const first = await project(body); assert.equal(first.statusCode, 201, first.body.message);
  const row = await Reservation.findOne(); assert.equal(row.origin, 'admin_project');
  assert.equal(String(first.body.data.offerReservationId), String(row._id));
  const invoice = await Invoice.findOne({ orderId: first.body.data._id, invoiceType: 'project' });
  assert.notEqual(invoice.dueDate.getTime(), row.expiresAt.getTime(), 'Existing invoice due rules stay separate from the reservation deadline');
  const retry = await project(body); assert.equal(retry.statusCode, 200, retry.body.message);
  assert.equal(await Reservation.countDocuments(), 1);
  assert.equal((await Reservation.findOne()).expiresAt.getTime(), row.expiresAt.getTime());
});
test('saved reservation survives public expiry/price change and is reused without resetting its clock', async () => {
  const first = await reserve(customer); const savedQuote = offer.quoteKey;
  // Public catalogue is now expired and edited; explicit reservation selection uses the saved snapshot.
  offer.endsAt = new Date(0).toISOString(); offer.offerPrice = 8000; offer.quoteKey = 'changed-public-quote';
  const created = await project({ offerReservationId: first.reservation.id, offerQuoteKey: savedQuote });
  assert.equal(created.statusCode, 201, created.body.message);
  assert.equal(created.body.data.totalAmount, 5000);
  const row = await Reservation.findOne();
  assert.equal(row.expiresAt.getTime(), new Date(first.reservation.expiresAt).getTime());
  assert.equal(created.body.data.projectSnapshot.salesAgreement.offer.offerPrice, 5000);
  const second = await project({ offerReservationId: first.reservation.id, offerQuoteKey: savedQuote });
  assert.equal(second.statusCode, 409); assert.equal(await Order.countDocuments(), 1);
});
test('admin creation failure rolls back its automatic reservation too', async () => {
  const save = Invoice.prototype.save;
  Invoice.prototype.save = async function (...args) { if (this.invoiceType === 'project_final') throw new Error('Injected final statement failure'); return save.apply(this, args); };
  let result; try { result = await project(); } finally { Invoice.prototype.save = save; }
  assert.equal(result.statusCode, 500); assert.equal(await Reservation.countDocuments(), 0); assert.equal(await Order.countDocuments(), 0);
});
test('only complete first invoice locks price, and later installment does not reset the milestone', async () => {
  const created = await project({ paymentType: 'partial', installmentCount: 2 });
  assert.equal(created.statusCode, 201, created.body.message);
  await User.updateOne({ _id: customer._id }, { $set: { walletBalance: 5000 } });
  const orderId = created.body.data._id;
  await payProjectWallet(customer._id, { orderId, amount: 1000 });
  assert.equal((await Reservation.findOne()).confirmedAt, null);
  await payProjectWallet(customer._id, { orderId, amount: 1500 });
  const row = await Reservation.findOne(); assert.ok(row.confirmedAt);
  assert.equal((await listReservations(customer._id)).reservations[0].status, 'confirmed');
  await Order.updateOne({ _id: orderId }, { $set: { projectProgress: 100 } });
  await payProjectWallet(customer._id, { orderId, amount: 2500 });
  assert.equal((await Reservation.findOne()).confirmedAt.getTime(), row.confirmedAt.getTime());
});
test('upfront first payment locks atomically and initial node does not activate reminder provision', async () => {
  const created = await project({ recordPayment: { paymentMethod: 'cash' } });
  assert.equal(created.statusCode, 201, created.body.message);
  assert.ok((await Reservation.findOne()).confirmedAt);
  let order = await Order.findById(created.body.data._id);
  assert.equal(order.offerFirstWorkUpdate, null);
  editProjectNode({ order, nodeId: order.projectNodes[0].nodeId, title: 'Renamed starting node', cumulativeProgress: 0, actorId: customer._id });
  await order.save(); assert.equal(order.offerFirstWorkUpdate, null);
  appendProjectNode({ order, title: 'First work', cumulativeProgress: 10, actorId: customer._id });
  await order.save(); const first = order.offerFirstWorkUpdate;
  assert.ok(first?.occurredAt);
  resetProjectTimeline({ order, startingNodeTitle: 'New run', actorId: customer._id }); await order.save();
  order = await Order.findById(order._id);
  appendProjectNode({ order, title: 'Next run', cumulativeProgress: 20, actorId: customer._id }); await order.save();
  assert.equal(order.offerFirstWorkUpdate.nodeId, first.nodeId);
  assert.equal(await EmailDraft.countDocuments({ event: 'offer.payment.reminder' }), 0);
});
test('expired reservation requires force protocol and cannot be renewed by project creation', async () => {
  await reserve(customer); await Reservation.collection.updateOne({}, { $set: { expiresAt: new Date(0) } });
  const created = await project(); assert.equal(created.statusCode, 409);
  assert.equal(await Order.countDocuments(), 0); assert.equal((await Reservation.findOne()).expiresAt.getTime(), 0);
});
test('reservation and confirmation activation switches default closed independently', async () => {
  delete process.env.OFFER_RESERVATIONS_ENABLED;
  await assert.rejects(reserve(), error => error.statusCode === 503);
  process.env.OFFER_RESERVATIONS_ENABLED = 'true'; await reserve();
  delete process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED;
  await drainReservationConfirmations(); assert.equal(deliveries, 0);
  assert.equal((await Reservation.findOne()).confirmationStatus, 'pending');
});
test('failed confirmation retries the same draft and provider idempotency key', async () => {
  await reserve();
  const normal = global.fetch; const keys = [];
  global.fetch = async (url, options) => {
    if (String(url).includes('api.resend.com')) {
      keys.push(options.headers['Idempotency-Key']);
      if (keys.length === 1) return { ok: false, json: async () => ({}) };
    }
    return normal(url, options);
  };
  try {
    await drainReservationConfirmations(); assert.equal((await Reservation.findOne()).confirmationStatus, 'failed');
    await Reservation.updateOne({}, { $set: { confirmationNextAttemptAt: new Date(0) } });
    await drainReservationConfirmations(); assert.equal((await Reservation.findOne()).confirmationStatus, 'sent');
    assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]); assert.equal(await EmailDraft.countDocuments(), 1);
  } finally { global.fetch = normal; }
});
test('failed linked-lead conversion rolls back the member upgrade', async () => {
  const admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
  await reserve(); const lead = await Lead.findOne(); lead.phone = '9999999999'; await lead.save();
  const save = Lead.prototype.save;
  Lead.prototype.save = async function (...args) { if (this.convertedToUserId) throw new Error('Injected conversion failure'); return save.apply(this, args); };
  const res = response();
  try { await convertLead({ userId: admin._id, userRole: 'admin', params: { leadId: lead._id }, body: { upgradeExisting: true } }, res); }
  finally { Lead.prototype.save = save; }
  assert.equal(res.statusCode, 400); assert.deepEqual((await User.findById(member._id)).roles, ['member']);
  assert.equal((await Lead.findById(lead._id)).convertedToUserId, null);
});
test('real node writes commit one first-work fact under concurrency and none on failed save', async () => {
  const created = await project(); assert.equal(created.statusCode, 201, created.body.message);
  const admin = await User.findOne({ roles: 'admin' });
  const req = { userId: admin._id, userRole: 'admin', params: { orderId: String(created.body.data._id) }, body: { title: 'Work started', cumulativeProgress: 10 } };
  const save = Order.prototype.save;
  Order.prototype.save = async () => { throw new Error('Injected node failure'); };
  const failed = response();
  try { await nodeController.createProjectNode(req, failed); } finally { Order.prototype.save = save; }
  assert.equal(failed.statusCode, 400); assert.equal((await Order.findById(created.body.data._id)).offerFirstWorkUpdate, null);
  const replies = [response(), response()]; await Promise.all(replies.map(res => nodeController.createProjectNode(req, res)));
  assert.equal(replies.filter(res => res.statusCode === 200).length, 1);
  const order = await Order.findById(created.body.data._id);
  assert.ok(order.offerFirstWorkUpdate); assert.equal(order.projectNodes.length, 2);
  assert.equal(await EmailDraft.countDocuments({ event: 'offer.payment.reminder' }), 0);
});
test('authenticated APIs scope ownership, reject forged admins/origins and ignore client-supplied owner/price', async () => {
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'false';
  const cookie = user => `token=${jwt.sign({ _id: user._id, role: 'member' }, process.env.TOKEN_SECRET_KEY)}`;
  let reply = await realFetch(apiOrigin + '/offer-reservations'); assert.equal(reply.status, 401);
  reply = await realFetch(apiOrigin + '/offer-reservations/user/' + customer._id, { headers: { Cookie: cookie(member) } }); assert.equal(reply.status, 403);
  reply = await realFetch(apiOrigin + '/offer-reservations/user/' + customer._id, { headers: { Cookie: `token=${jwt.sign({ _id: member._id, role: 'admin' }, process.env.TOKEN_SECRET_KEY)}` } }); assert.equal(reply.status, 403);
  const options = { method: 'POST', headers: { Cookie: cookie(member), 'Content-Type': 'application/json' },
    body: JSON.stringify({ offerSlug: offer.slug, quoteKey: offer.quoteKey, userId: String(customer._id), reservedPrice: 1 }) };
  reply = await realFetch(apiOrigin + '/offer-reservations', { ...options, headers: { ...options.headers, Origin: 'https://untrusted.example.test' } }); assert.equal(reply.status, 403);
  reply = await realFetch(apiOrigin + '/offer-reservations', options); assert.equal(reply.status, 200);
  const result = await reply.json(); assert.equal(result.data.reservation.reservedPrice, 5000);
  const stored = await Reservation.findOne(); assert.equal(String(stored.userId), String(member._id));
  reply = await realFetch(apiOrigin + '/offer-reservations', { headers: { Cookie: cookie(member) } });
  const history = await reply.json(); assert.equal(history.data.reservations.length, 1); assert.equal(history.data.reservations[0].offerSnapshot, undefined);
});
test('converted member session refreshes to its explicitly granted customer role', async () => {
  await User.updateOne({ _id: member._id }, { $set: { roles: ['customer'] } });
  const details = require('../controller/user/userDetails');
  const res = { ...response(), cookie(name, value) { this.token = value; return this; }, clearCookie() { return this; } };
  await details({ userId: member._id, userRole: 'member' }, res);
  assert.equal(res.body.data.role, 'customer');
  assert.equal(require('../helpers/sessionToken').verifySession(res.token).role, 'customer');
});

// Step 1 (owner rule): submission time inside the deadline locks; approval time does not matter.
async function expiredProjectWithUpi(parts) {
  const created = await project();
  assert.equal(created.statusCode, 201, created.body.message);
  const order = await Order.findById(created.body.data._id);
  const invoice = await Invoice.findOne({ orderId: order._id, invoiceType: 'project' });
  const now = Date.now(), deadline = new Date(now - 3600000);
  await Reservation.collection.updateOne({}, { $set: { reservedAt: new Date(deadline - 72 * 3600000), expiresAt: deadline } });
  const payments = [];
  for (const [amount, minutesFromDeadline] of parts) {
    const payment = await Transaction.create({ userId: customer._id, orderId: order._id, invoiceId: invoice._id,
      transactionId: new mongoose.Types.ObjectId().toString(), description: 'Isolated UPI', amount, status: 'pending',
      paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice' });
    const submittedAt = new Date(deadline.getTime() + minutesFromDeadline * 60000);
    await Transaction.collection.updateOne({ _id: payment._id }, { $set: { createdAt: submittedAt } });
    payments.push({ transactionId: payment.transactionId, submittedAt });
  }
  return { payments, deadline, admin: await User.findOne({ email: 'admin@example.test' }) };
}
const statusOf = async () => (await listReservations(customer._id)).reservations[0].status;
test('payment submitted before the deadline locks when approved after it, at the submission time', async () => {
  const { payments, admin } = await expiredProjectWithUpi([[5000, -30]]);
  assert.equal(await statusOf(), 'under_review', 'Pending in-time payment is not shown as expired');
  await approveProjectPayment(payments[0].transactionId, admin._id);
  const row = await Reservation.findOne();
  assert.equal(row.confirmedAt.getTime(), payments[0].submittedAt.getTime());
  assert.equal(await statusOf(), 'confirmed');
});
test('payment submitted after the deadline neither shows under review nor locks', async () => {
  const { payments, admin } = await expiredProjectWithUpi([[5000, 30]]);
  assert.equal(await statusOf(), 'expired');
  await approveProjectPayment(payments[0].transactionId, admin._id);
  assert.equal((await Reservation.findOne()).confirmedAt, null);
});
test('in-time payment rejected after the deadline loses the lock', async () => {
  const { payments, admin } = await expiredProjectWithUpi([[5000, -30]]);
  await rejectProjectPayment(payments[0].transactionId, admin._id, 'UTR not found');
  assert.equal(await statusOf(), 'expired');
  assert.equal((await Reservation.findOne()).confirmedAt, null);
});
test('split payment counts when its last part was submitted', async () => {
  let { payments, admin } = await expiredProjectWithUpi([[2000, -50], [3000, 20]]);
  for (const payment of payments) await approveProjectPayment(payment.transactionId, admin._id);
  assert.equal((await Invoice.findOne({ invoiceType: 'project' })).status, 'paid');
  assert.equal((await Reservation.findOne()).confirmedAt, null, 'Full amount was submitted only after the deadline');
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [member, customer] = await User.create([{ name: 'Member', email: 'member@example.test', roles: ['member'], phone: '+919876500001' }, { name: 'Client', email: 'client@example.test', roles: ['customer'], phone: '+919876500002' }]);
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
  ({ payments, admin } = await expiredProjectWithUpi([[2000, -50], [3000, -10]]));
  for (const payment of payments) await approveProjectPayment(payment.transactionId, admin._id);
  assert.equal((await Reservation.findOne()).confirmedAt.getTime(), payments[1].submittedAt.getTime());
});

// Step 2: phone is mandatory (owner rule — no lead or client without a phone).
const { parsePhone, PHONE_COUNTRIES } = require('../helpers/phoneNumber');
test('phone format: country code plus exact national length, one stored format', () => {
  assert.equal(PHONE_COUNTRIES[0].code, '+91');
  assert.equal(parsePhone({ countryCode: '+91', phone: '98765 43210' }), '+919876543210');
  assert.equal(parsePhone({ phone: '9876543210' }), '+919876543210', 'India is the default');
  assert.equal(parsePhone({ countryCode: '+971', phone: '501234567' }), '+971501234567');
  for (const input of [{ phone: '' }, { phone: '987654321' }, { phone: '98765432101' }, { phone: '5876543210' }, { countryCode: '+999', phone: '9876543210' }, { countryCode: '+971', phone: '9876543210' }]) {
    assert.throws(() => parsePhone(input), /mobile number|country code/);
  }
});
test('signup requires a valid phone, stores it unverified, and the OTP flag fails closed', async () => {
  const signup = require('../controller/user/userSignUp');
  const call = async body => { const res = response(); await signup({ body: { name: 'New', email: 'new@example.test', password: 'secret1', ...body } }, res); return res.body; };
  assert.match((await call({})).message, /mobile number/);
  assert.match((await call({ countryCode: '+91', phone: '12345' })).message, /10-digit/);
  assert.equal(await User.countDocuments({ email: 'new@example.test' }), 0);
  process.env.SIGNUP_PHONE_OTP_ENABLED = 'true';
  try { assert.match((await call({ countryCode: '+91', phone: '9876543210' })).message, /verification is not available/); }
  finally { delete process.env.SIGNUP_PHONE_OTP_ENABLED; }
  assert.equal(await User.countDocuments({ email: 'new@example.test' }), 0);
  const created = await call({ countryCode: '+91', phone: '98765 43210' });
  assert.equal(created.success, true, created.message);
  const saved = await User.findOne({ email: 'new@example.test' });
  assert.equal(saved.phone, '+919876543210'); assert.equal(saved.phoneVerified, false); assert.deepEqual([...saved.roles], ['member']);
});
test('phoneless legacy member must add a phone before any lead or reservation is written', async () => {
  await User.updateOne({ _id: member._id }, { $unset: { phone: 1 } });
  await assert.rejects(reserve(), error => error.statusCode === 428);
  await assert.rejects(reserve(member, { countryCode: '+91', phone: '123' }), /10-digit/);
  assert.equal(await Lead.countDocuments(), 0); assert.equal(await Reservation.countDocuments(), 0);
  assert.equal((await User.findById(member._id)).phone, undefined);
  await reserve(member, { countryCode: '+91', phone: '98765-00009' });
  assert.equal((await User.findById(member._id)).phone, '+919876500009');
  assert.equal((await Lead.findOne()).phone, '+919876500009');
});
test('a phone entered with a rejected reservation is not saved', async () => {
  await User.updateOne({ _id: member._id }, { $unset: { phone: 1 } });
  await assert.rejects(reserve(member, { quoteKey: 'stale', countryCode: '+91', phone: '9876500009' }), /changed/);
  assert.equal((await User.findById(member._id)).phone, undefined);
});

// Cancellation/deletion releases must preserve the commercial snapshot and original clock.
const { releaseProjectReservation, repairUserReservationLinks } = require('../helpers/reservationRelease');
async function releaseInTransaction(projectId, extra = {}) {
  return mongoose.connection.transaction(session => releaseProjectReservation({ projectId, session, ...extra }));
}
test('cancelled unpaid reservation is repaired, reused once and keeps its original clock', async () => {
  await reserve(customer);
  assert.equal((await project()).statusCode, 201);
  const old = await Order.findOne();
  const before = await Reservation.findOne();
  await Reservation.updateOne({ _id: before._id }, { $set: { resolution: { status: 'unchanged', closedAt: new Date(), at: new Date() } } });
  await Order.updateOne({ _id: old._id }, { $set: { orderVisibility: 'cancelled' } });
  await listReservations(customer._id);
  const released = await Reservation.findById(before._id);
  assert.equal(released.projectId, null);
  assert.equal(released.resolution, null);
  assert.equal(released.releases.length, 1);
  assert.equal(released.releases[0].resolution.status, 'unchanged');
  assert.equal(released.expiresAt.getTime(), before.expiresAt.getTime());
  assert.deepEqual(released.offerSnapshot, before.offerSnapshot);
  assert.equal((await Order.findById(old._id)).offerReservationId, null);
  await repairUserReservationLinks(customer._id);
  assert.equal((await Reservation.findById(before._id)).releases.length, 1);
  assert.equal((await project({ offerReservationId: String(before._id) })).statusCode, 201);
  const attached = await Reservation.findById(before._id);
  assert.notEqual(String(attached.projectId), String(old._id));
  assert.equal(attached.expiresAt.getTime(), before.expiresAt.getTime());
  assert.notEqual((await project({ offerReservationId: String(before._id) })).statusCode, 201);
});
test('release never detaches a running project and rolls back with deletion', async () => {
  await project();
  const row = await Reservation.findOne();
  await releaseInTransaction(row.projectId);
  assert.ok((await Reservation.findById(row._id)).projectId);
  await assert.rejects(mongoose.connection.transaction(async session => {
    await releaseProjectReservation({ projectId: row.projectId, deleting: true, session });
    await Order.deleteOne({ _id: row.projectId }).session(session);
    throw new Error('rollback');
  }), /rollback/);
  assert.ok((await Reservation.findById(row._id)).projectId);
  assert.ok(await Order.findById(row.projectId));
  await releaseInTransaction(row.projectId, { deleting: true });
  assert.equal((await Reservation.findById(row._id)).projectId, null);
});
test('historical missing project is repaired without renewing an expired reservation', async () => {
  await project();
  const row = await Reservation.findOne();
  // Immutable deadline represents a genuinely old reservation, not a fresh hold.
  await Reservation.collection.updateOne({ _id: row._id }, { $set: { expiresAt: new Date(0) } });
  await Order.deleteOne({ _id: row.projectId });
  await repairUserReservationLinks(customer._id);
  assert.equal((await Reservation.findById(row._id)).projectId, null);
  const result = await project({ offerReservationId: String(row._id) });
  assert.notEqual(result.statusCode, 200);
  assert.equal((await Reservation.findById(row._id)).expiresAt.getTime(), 0);
});
test('pending and completed payments prevent automatic reservation reuse', async () => {
  await project();
  const row = await Reservation.findOne();
  await Order.updateOne({ _id: row.projectId }, { $set: { orderVisibility: 'cancelled' } });
  for (const status of ['pending', 'completed']) {
    const payment = await Transaction.create({ userId: customer._id, orderId: row.projectId, amount: 100,
      type: 'payment', status, description: 'Release guard fixture', paymentMethod: 'upi', transactionId: 'release-' + status });
    await releaseInTransaction(row.projectId);
    assert.ok((await Reservation.findById(row._id)).projectId);
    await Transaction.deleteOne({ _id: payment._id });
  }
});
test('price lock and prior force-apply are never reset by release', async () => {
  await project();
  const row = await Reservation.findOne();
  await Order.updateOne({ _id: row.projectId }, { $set: { orderVisibility: 'cancelled' } });
  await Reservation.updateOne({ _id: row._id }, { $set: { confirmedAt: new Date() } });
  await releaseInTransaction(row.projectId);
  assert.ok((await Reservation.findById(row._id)).projectId);
  await Reservation.updateOne({ _id: row._id }, { $set: { confirmedAt: null, resolution: { status: 'force_applied', at: new Date() } } });
  await releaseInTransaction(row.projectId);
  assert.ok((await Reservation.findById(row._id)).projectId);
});

test('actual cancel and delete endpoints release unpaid offers', async () => {
  await project();
  const row = await Reservation.findOne();
  const admin = await User.findOne({ email: 'admin@example.test' });
  const cancelResponse = response();
  await require('../controller/order/cancelProjectOrder').cancelProjectOrder({ userId: admin._id, userRole: 'admin',
    params: { orderId: String(row.projectId) }, body: { reason: 'Client changed the scope' } }, cancelResponse);
  assert.equal(cancelResponse.statusCode, 200, JSON.stringify(cancelResponse.body));
  assert.equal((await Reservation.findById(row._id)).projectId, null);
  assert.equal((await Order.findById(row.projectId)).orderVisibility, 'cancelled');
  await project({ offerReservationId: String(row._id) });
  const linked = await Reservation.findById(row._id);
  const plan = await require('../helpers/orderDeletePlan')(linked.projectId);
  const deleteResponse = response();
  await require('../controller/order/deleteOrder')({ userId: admin._id, userRole: 'admin',
    params: { orderId: String(linked.projectId) }, body: { selectedSections: plan.requiredSectionKeys } }, deleteResponse);
  assert.equal(deleteResponse.statusCode, 200, JSON.stringify(deleteResponse.body));
  assert.equal(await Order.findById(linked.projectId), null);
  assert.equal((await Reservation.findById(row._id)).projectId, null);
  assert.equal((await Reservation.findById(row._id)).releases.length, 2);
});
test('concurrent repairs and project creation attach the released reservation only once', async () => {
  await project();
  const row = await Reservation.findOne();
  await Order.updateOne({ _id: row.projectId }, { $set: { orderVisibility: 'cancelled' } });
  await Promise.all([repairUserReservationLinks(customer._id), repairUserReservationLinks(customer._id)]);
  assert.equal((await Reservation.findById(row._id)).releases.length, 1);
  const results = await Promise.all([project({ offerReservationId: String(row._id) }), project({ offerReservationId: String(row._id) })]);
  assert.equal(results.filter(result => result.statusCode === 201).length, 1);
  assert.equal(await Order.countDocuments({ orderVisibility: { $ne: 'cancelled' } }), 1);
});

test('paid invoice evidence blocks reuse and is explained in the reservation list', async () => {
  await project();
  const row = await Reservation.findOne();
  await Order.updateOne({ _id: row.projectId }, { $set: { orderVisibility: 'cancelled' } });
  await Invoice.updateOne({ orderId: row.projectId, invoiceType: 'project' }, { $set: { amountPaid: 100 } });
  const list = await listReservations(customer._id);
  assert.equal(list.reservations[0].reuseNeedsReview, true);
  assert.equal(list.reservations[0].projectId, String(row.projectId));
});
test('failed release rolls back cancellation and leaves the original reservation attached', async () => {
  await project();
  const row = await Reservation.findOne();
  const admin = await User.findOne({ email: 'admin@example.test' });
  const release = require('../helpers/reservationRelease');
  const original = release.releaseProjectReservation;
  release.releaseProjectReservation = async () => { throw new Error('Injected release failure'); };
  const res = response();
  try {
    await require('../controller/order/cancelProjectOrder').cancelProjectOrder({ userId: admin._id, userRole: 'admin',
      params: { orderId: String(row.projectId) }, body: {} }, res);
  } finally { release.releaseProjectReservation = original; }
  assert.equal(res.statusCode, 500);
  assert.notEqual((await Order.findById(row.projectId)).orderVisibility, 'cancelled');
  assert.equal(String((await Reservation.findById(row._id)).projectId), String(row.projectId));
});
test('a reused reservation still reprices the new project after its original deadline', async () => {
  await project();
  const row = await Reservation.findOne();
  await Order.updateOne({ _id: row.projectId }, { $set: { orderVisibility: 'cancelled' } });
  await Reservation.updateOne({ _id: row._id }, { $set: { resolution: { status: 'unchanged', at: new Date(), closedAt: new Date() } } });
  const created = await project({ offerReservationId: String(row._id) });
  assert.equal(created.statusCode, 201);
  const fresh = await Reservation.findById(row._id);
  await Reservation.collection.updateOne({ _id: row._id }, { $set: { expiresAt: new Date(0) } });
  const enabled = process.env.OFFER_RESERVATION_REPRICING_ENABLED;
  process.env.OFFER_RESERVATION_REPRICING_ENABLED = 'true';
  try {
    const result = await require('../helpers/reservationRepricing').reconcileReservation(row._id, { catalogue: { offers: [] } });
    assert.equal(result.status, 'repriced');
    assert.equal((await Order.findById(fresh.projectId)).totalAmount, 10000);
  } finally {
    if (enabled === undefined) delete process.env.OFFER_RESERVATION_REPRICING_ENABLED;
    else process.env.OFFER_RESERVATION_REPRICING_ENABLED = enabled;
  }
});
