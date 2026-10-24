const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const express = require('express');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Product = require('../models/productModel');
const User = require('../models/userModel');
const Submission = require('../models/uploadSubmissionModel');
const Request = require('../models/updateRequestModel');
const { EmailDraft, EmailHistory, EmailPolicy } = require('../models/emailControlModel');
const { freezePaymentPolicy, getPaymentAccess, paymentDueDate } = require('../helpers/offerPaymentPolicy');
const { assertUploadOrder } = require('../helpers/uploadOrderPolicy');
const { claimSubmission, commitSubmission } = require('../helpers/uploadSubmission');
const nativeFetch = global.fetch;
let database, server, origin, admin, client, plan, offers, sent;
const rawPolicy = (mode = 'pay_later', extra = {}) => ({ mode, dueDays: 7, uploadAllowance: 2, cycleScope: 'first_purchase', reminderOffsets: [-1, 0, 3], ...extra });
const offer = (mode, extra = {}) => ({ slug: 'test-offer', title: 'Verified payment offer', status: 'published', endsAt: '2099-11-02T23:59:59+05:30',
  targets: ['projects', 'service_plans'], applicableCategories: ['standard_websites'], planIds: [String(plan._id)], packageIds: [],
  pricingRule: 'fixed_price', mainPrice: 10000, offerPrice: 699, inclusions: ['Website work'], resolvedTerms: ['Agreed terms'], quoteKey: 'offer-v1', paymentPolicy: rawPolicy(mode, extra) });
async function api(path, body) {
  const response = await nativeFetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
async function project(mode = 'pay_later', extra = {}) {
  offers = [offer(mode, extra)];
  const result = await api(`/admin/clients/${client._id}/create-project`, { category: 'standard_websites', sellingPrice: 699, offerSlug: 'test-offer', offerQuoteKey: 'offer-v1' });
  assert.equal(result.status, 201, result.message);
  return Order.findById(result.data._id);
}
async function buy(mode = 'pay_later', extra = {}, fields = {}) {
  offers = [offer(mode, extra)];
  const listing = await api(`/offers/${plan._id}`); assert.equal(listing.status, 200, listing.message);
  const body = { planId: String(plan._id), offerSlug: 'test-offer', offerQuoteKey: listing.data[0].quoteKey, deferPayment: mode !== 'advance', purchaseKey: randomUUID(), ...fields };
  return { body, result: await api('/buy', body) };
}
async function upload(order) {
  const req = { userId: String(client._id), query: { uploadId: randomUUID() }, body: { planId: String(order._id), serviceOrderId: String(order._id), instructions: '[]' }, files: [] };
  req.uploadAttempt = await claimSubmission(req);
  const result = await commitSubmission(req, { instructions: [{ text: 'Successful instruction submission', timestamp: new Date() }], files: [] });
  return { req, result };
}
before(async () => {
  process.env.PORTFOLIO_WEBSITE_URL = 'https://website.example.test';
  process.env.PORTFOLIO_INTEGRATION_SECRET = 'isolated-policy-secret'.repeat(3);
  process.env.RESEND_API_KEY = 'isolated-no-real-key'; process.env.FROM_EMAIL = 'sender@example.test';
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Order.init(), Invoice.init(), Submission.init(), Request.init(), EmailDraft.init(), EmailHistory.init(), EmailPolicy.init()]);
  global.fetch = async (url, options) => {
    if (String(url) === 'https://website.example.test/api/offers/live') return new Response(JSON.stringify({ offers, catalogueOffers: offers }), { status: 200 });
    if (String(url) === 'https://api.resend.com/emails') { sent.push({ body: JSON.parse(options.body), key: options.headers['Idempotency-Key'] }); return new Response(JSON.stringify({ id: 'isolated-provider-result' }), { status: 200 }); }
    throw new Error(`External network blocked: ${url}`);
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.userId = String(req.path.startsWith('/admin') ? admin._id : client._id); req.userRole = req.path.startsWith('/admin') ? 'admin' : 'customer'; next(); });
  app.get('/offers/:planId', require('../controller/order/servicePlanOffers'));
  app.post('/buy', require('../controller/order/customerCreateServicePlanOrder'));
  app.post('/admin/clients/:customerId/create-project', require('../controller/order/adminCreateProjectOrder'));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [admin, client] = await User.create([{ name: 'Policy Admin', email: 'admin@example.test', roles: ['admin'] }, { name: 'Policy Client', email: 'client@example.test', roles: ['customer'], walletBalance: 0 }]);
  plan = await Product.create({ serviceName: 'Upload plan', category: 'service_plan', isServicePlan: true, sellingPrice: 1000,
    servicePlan: { purchaseType: 'one_time', capability: 'upload_data', serviceBehavior: 'portal_access_control', dependency: 'standalone_or_project', timing: 'during', limitScope: 'per_plan', portalAccessCount: 5, filesLimit: 10 } });
  offers = []; sent = [];
});
after(async () => { global.fetch = nativeFetch; if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); if (database) await database.stop(); });

test('policy validates limits, freezes independent values and keeps payment due dates exact', () => {
  const source = offer('limited_uploads'); const snapshot = freezePaymentPolicy(source, new Date('2026-10-22T00:00:00Z'));
  source.paymentPolicy.uploadAllowance = 99; assert.equal(snapshot.uploadAllowance, 2);
  assert.equal(paymentDueDate(snapshot, snapshot.appliedAt).toISOString(), '2026-10-29T00:00:00.000Z');
  assert.throws(() => freezePaymentPolicy(offer('limited_uploads', { uploadAllowance: 0 })));
  assert.equal(freezePaymentPolicy(offer('current')), null);
});
test('pay-later project starts work with unpaid bill and frozen agreement; advance remains locked', async () => {
  const order = await project(); assert.equal(order.orderVisibility, 'approved'); assert.equal(order.paidAmount, 0); assert.equal(order.paymentComplete, false);
  const bill = await Invoice.findOne({ orderId: order._id, invoiceType: 'project' }); assert.equal(bill.status, 'unpaid');
  assert.equal(new Date(bill.dueDate).getTime() - new Date(order.paymentPolicy.appliedAt).getTime() < 7 * 86400000 + 1000, true);
  await Invoice.updateOne({ _id: bill._id }, { $set: { dueDate: new Date('2020-01-01') } });
  assert.equal((await getPaymentAccess(order)).allowed, true); assert.equal((await getPaymentAccess(order)).overdue, true);
  await assertUploadOrder(order, { fileCount: 0 });
  const advance = await project('advance'); assert.equal(advance.orderVisibility, 'pending-approval');
  await assert.rejects(assertUploadOrder(advance, { fileCount: 0 }), /approval/);
});
test('last project pre-payment allowance is atomic; replay and rejected submissions spend nothing', async () => {
  const order = await project('limited_uploads', { uploadAllowance: 1 });
  const results = await Promise.allSettled([upload(order), upload(order)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await Order.findById(order._id)).paymentPolicyUploads, 1); assert.equal(await Request.countDocuments(), 1);
  const success = results.find(result => result.status === 'fulfilled').value;
  assert.equal((await claimSubmission(success.req)).replay.success, true);
  assert.equal((await getPaymentAccess(await Order.findById(order._id))).allowed, false);
  await Invoice.updateMany({ orderId: order._id, invoiceType: 'project' }, { $set: { status: 'paid', amountPaid: 699 } });
  assert.equal((await getPaymentAccess(await Order.findById(order._id))).allowed, true);
});
test('eligible self-purchase keeps plan price and invoice unpaid, does not debit wallet, and retries return same order', async () => {
  await User.updateOne({ _id: client._id }, { $set: { walletBalance: 2000 } });
  const { body, result } = await buy(); assert.equal(result.status, 201, result.message);
  const order = await Order.findById(result.data.orderId); assert.equal(order.totalAmount, 1000); assert.equal(order.orderVisibility, 'approved'); assert.equal(order.paymentComplete, false);
  assert.equal((await User.findById(client._id)).walletBalance, 2000);
  assert.equal((await Invoice.findById(result.data.invoiceId)).status, 'unpaid');
  const repeated = await api('/buy', body); assert.equal(repeated.status, 200, repeated.message); assert.equal(String(repeated.data.orderId), String(order._id)); assert.equal(await Order.countDocuments(), 1);
});
test('stale, expired, ineligible and no-offer deferred purchases refuse before any writes', async () => {
  offers = [offer('pay_later')];
  const bad = await api('/buy', { planId: String(plan._id), offerSlug: 'test-offer', offerQuoteKey: 'stale', deferPayment: true }); assert.equal(bad.status, 400);
  const noOffer = await api('/buy', { planId: String(plan._id), deferPayment: true }); assert.equal(noOffer.status, 400);
  offers[0].endsAt = '2000-01-01T00:00:00Z'; assert.equal((await api(`/offers/${plan._id}`)).data.length, 0);
  offers = [offer('limited_uploads')]; plan.servicePlan.capability = 'send_reminders'; await plan.save(); assert.equal((await api(`/offers/${plan._id}`)).data.length, 0);
  assert.equal(await Order.countDocuments(), 0); assert.equal(await Invoice.countDocuments(), 0);
});
test('service original quota, cancellation and after-project activation remain authoritative', async () => {
  const { result } = await buy('pay_later'); assert.equal(result.status, 201, result.message);
  const order = await Order.findById(result.data.orderId);
  order.serviceAccessUsedInCycle = 5; await order.save(); await assert.rejects(assertUploadOrder(order, { fileCount: 0, serviceOrderId: order._id }), /limit/);
  order.serviceAccessUsedInCycle = 0; order.servicePlanStatus = 'pending_activation'; await order.save(); await assert.rejects(assertUploadOrder(order, { fileCount: 0, serviceOrderId: order._id }), /not active/);
  order.servicePlanStatus = 'active'; order.orderVisibility = 'cancelled'; await order.save(); await assert.rejects(assertUploadOrder(order, { fileCount: 0, serviceOrderId: order._id }), /cannot accept/);
});
test('late cycle payment preserves used uploads and never rewinds the active cycle', async () => {
  const { result } = await buy('limited_uploads'); assert.equal(result.status, 201, result.message);
  let order = await Order.findById(result.data.orderId); await upload(order); order = await Order.findById(order._id); assert.equal(order.serviceAccessUsedInCycle, 1);
  const bill = await Invoice.findById(result.data.invoiceId); bill.status = 'paid'; bill.amountPaid = 1000; await bill.save();
  await require('../helpers/serviceCycleSettlement').settleServiceCycle({ orderId: order._id, invoice: bill });
  order = await Order.findById(order._id); assert.equal(order.serviceAccessUsedInCycle, 1);
  order.serviceCurrentCycleNumber = 2; order.serviceAccessUsedInCycle = 2; order.servicePlanStatus = 'paused'; await order.save();
  await require('../helpers/serviceCycleSettlement').settleServiceCycle({ orderId: order._id, invoice: bill });
  order = await Order.findById(order._id); assert.equal(order.serviceCurrentCycleNumber, 2); assert.equal(order.serviceAccessUsedInCycle, 2); assert.equal(order.servicePlanStatus, 'paused');
});
test('recurring pay-later advances without losing old unpaid debt; first-only terms make renewal advance', async () => {
  plan.servicePlan.purchaseType = 'recurring'; plan.servicePlan.billingOptions = [{ billingCycle: 'monthly', pricePerCycle: 1000, discountPercent: 0 }]; await plan.save();
  for (const scope of ['every_cycle', 'first_purchase']) {
    const { result } = await buy('pay_later', { cycleScope: scope }, { selectedBillingCycle: 'monthly', tenureMonths: 2 }); assert.equal(result.status, 201, result.message);
    let order = await Order.findById(result.data.orderId); const end = new Date(order.serviceCurrentCycleEnd); order.serviceAccessUsedInCycle = 2; await order.save();
    await require('../helpers/offerServiceRenewal').advanceOfferServiceCycle(order._id, new Date(end.getTime() + 1));
    await require('../helpers/offerServiceRenewal').advanceOfferServiceCycle(order._id, new Date(end.getTime() + 1));
    order = await Order.findById(order._id); assert.equal(order.serviceCurrentCycleNumber, 2); assert.equal(order.serviceAccessUsedInCycle, 0); assert.equal(order.servicePlanStatus, scope === 'every_cycle' ? 'active' : 'paused');
    assert.equal(await Invoice.countDocuments({ orderId: order._id, invoiceType: { $in: ['project', 'plan_renewal'] }, status: 'unpaid' }), 2);
  }
});
test('automatic reminders reuse one durable send, stop after payment, and respect global Off', async () => {
  const order = await project('pay_later', { dueDays: 0, reminderOffsets: [0] });
  const { processOfferPaymentReminders } = require('../cron/offerPaymentReminderCron');
  await processOfferPaymentReminders(new Date(Date.now() + 1000)); await processOfferPaymentReminders(new Date(Date.now() + 1000));
  assert.equal(sent.length, 1); assert.equal(await EmailHistory.countDocuments({ event: 'offer.payment.reminder', status: 'sent' }), 1);
  await Invoice.updateMany({ orderId: order._id, invoiceType: 'project' }, { $set: { status: 'paid', amountPaid: 699 } });
  await processOfferPaymentReminders(); assert.equal(sent.length, 1);
  await EmailPolicy.create({ event: 'offer.payment.reminder', mode: 'off' }); await project('pay_later', { dueDays: 0, reminderOffsets: [0] }); await processOfferPaymentReminders(new Date(Date.now() + 1000)); assert.equal(sent.length, 1);
});
test('later due installment locks even before its invoice exists; final statements do not count as bills', async () => {
  const order = await project('advance');
  order.orderVisibility = 'approved'; order.isPartialPayment = true; order.currentInstallment = 2; order.projectProgress = 90;
  order.installments = [{ installmentNumber: 1, percentage: 50, amount: 349.5, paid: true }, { installmentNumber: 2, percentage: 50, amount: 349.5, paid: false, progressThreshold: 90 }]; await order.save();
  await Invoice.deleteMany({ orderId: order._id, invoiceType: 'project' });
  assert.equal((await getPaymentAccess(order)).allowed, false);
  order.projectProgress = 50; await order.save(); assert.equal((await getPaymentAccess(order)).allowed, true);
});
