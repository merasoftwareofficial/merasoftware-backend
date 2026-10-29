// Client buys a plan in the portal (merasoftware/src/docs/plan.md §4): only a client buys; one purchase
// key = one order and one charge; no upload before the UPI part is approved (wallet-only is active at
// once); the client is told at submit and rejection, the admin at every purchase; those mails are Off
// until turned On. Isolated: in-memory MongoDB, real controllers, mail provider mocked, network blocked.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const express = require('express');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Product = require('../models/productModel');
const User = require('../models/userModel');
const Transaction = require('../models/transactionModel');
const { EmailDraft, EmailHistory, EmailPolicy } = require('../models/emailControlModel');
const { requestMiddleware } = require('../helpers/emailController');
const { assertUploadOrder } = require('../helpers/uploadOrderPolicy');
const { getOrderState } = require('../helpers/orderStatusEngine');

const nativeFetch = global.fetch;
let database, server, origin, admin, client, staff, sent, actor;

async function call(path, { body, method = body ? 'POST' : 'GET', as } = {}) {
  actor = as;
  const response = await nativeFetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const pagePlan = () => Product.create({
  serviceName: 'Single Page Addition', category: 'service_plan', isServicePlan: true, price: 1500, sellingPrice: 1500,
  servicePlan: { capability: 'upload_data', serviceBehavior: 'portal_access_control', dependency: 'standalone_or_project', timing: 'during_and_after', purchaseType: 'one_time', limitScope: 'per_plan', portalAccessCount: 5, filesLimit: 20 },
});
const buy = (plan, { upi, key, as, ...rest } = {}) => call('/customer/service-plan-order', { as, body: {
  planId: String(plan._id), purchaseKey: key, ...rest,
  paymentDetails: { transactionId: `SVC${Date.now()}${crypto.randomInt(1e6)}`, ...(upi ? { upiTransactionId: upi } : {}) },
} });
const setWallet = (amount) => User.updateOne({ _id: client._id }, { $set: { walletBalance: amount } });
const wallet = async () => (await User.findById(client._id).lean()).walletBalance;
const upload = (order) => assertUploadOrder(order, { fileCount: 1, serviceOrderId: String(order._id) }).then(() => 'allowed', (error) => error.message);
const turnOn = (...events) => EmailPolicy.insertMany(events.map((event) => ({ event, mode: 'auto' })));
// Customer-started mail goes out after the response; wait for it.
async function mailsFor(event, count = 1) {
  for (let i = 0; i < 150; i += 1) {
    const rows = await EmailDraft.find({ event, status: 'sent' }).lean();
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return EmailDraft.find({ event, status: 'sent' }).lean();
}
const pendingUpi = async (orderId) => Transaction.findOne({ orderId, paymentMethod: 'upi', status: 'pending' }).lean();

before(async () => {
  process.env.RESEND_API_KEY = 'isolated-no-real-key'; process.env.FROM_EMAIL = 'sender@example.test';
  process.env.ADMIN_DASHBOARD_URL = 'https://portal.example.test';
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Order.init(), Invoice.init(), Transaction.init(), EmailDraft.init(), EmailHistory.init(), EmailPolicy.init()]);
  global.fetch = async (url, options) => {
    if (String(url) === 'https://api.resend.com/emails') { sent.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: 'isolated' }), { status: 200 }); }
    if (String(url).includes('/api/offers/live')) return new Response(JSON.stringify({ offers: [], catalogueOffers: [] }), { status: 200 });
    throw new Error(`External network blocked: ${url}`);
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const user = actor || (req.path.startsWith('/wallet/') ? admin : client);
    req.userId = String(user._id); req.userRole = user === staff ? 'admin' : user === admin ? 'admin' : 'customer'; next();
  });
  app.use(requestMiddleware);
  const approvals = require('../controller/user/transactionApprovalController');
  app.post('/customer/service-plan-order', require('../controller/order/customerCreateServicePlanOrder'));
  app.post('/wallet/approve-transaction', approvals.approveTransaction);
  app.post('/wallet/reject-transaction', approvals.rejectTransaction);
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [admin, client, staff] = await User.create([
    { name: 'Plan Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Plan Client', email: 'client@example.test', roles: ['customer'], walletBalance: 100000 },
    { name: 'Staff Client', email: 'staff@example.test', roles: ['admin', 'customer'], walletBalance: 100000 },
  ]);
  sent = []; actor = undefined;
});
after(async () => {
  global.fetch = nativeFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect(); await database?.stop();
});

test('only the customer role buys: a staff + client account signed in as staff gets 403 and nothing is created', async () => {
  const plan = await pagePlan();
  const refused = await buy(plan, { as: staff, key: crypto.randomUUID() });
  assert.equal(refused.status, 403);
  assert.equal(refused.message, 'Switch to your customer role to buy a plan.');
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await User.findById(staff._id).lean()).walletBalance, 100000);
});

test('wallet only: active at once and uploads open; the purchase mails stay Off until turned On', async () => {
  const plan = await pagePlan();
  const bought = await buy(plan, { key: crypto.randomUUID() });
  assert.equal(bought.status, 201, bought.message);
  assert.deepEqual([bought.data.walletPaid, bought.data.upiPending], [1500, 0]);
  const order = await Order.findById(bought.data.orderId).lean();
  assert.equal(order.orderVisibility, 'approved');
  assert.equal(getOrderState(order).label, 'Active');
  assert.equal(await upload(order), 'allowed');
  assert.equal(await wallet(), 98500);
  // Off by default: no admin copy and no "submitted" mail was even prepared.
  assert.equal(await EmailDraft.countDocuments({ event: { $in: ['plan.purchase.admin', 'plan.payment.submitted'] } }), 0);

  await turnOn('plan.purchase.admin', 'plan.payment.submitted');
  await buy(plan, { key: crypto.randomUUID() });
  const [adminMail] = await mailsFor('plan.purchase.admin');
  assert.deepEqual(adminMail.to, ['vacomputers.com@gmail.com', 'syncvap@gmail.com']);
  assert.match(adminMail.text, /Paid in full from the wallet\. The plan is active\./);
  assert.equal(await EmailDraft.countDocuments({ event: 'plan.payment.submitted' }), 0, 'wallet-only buyer gets "plan started", not "submitted"');
});

test('UPI only and wallet + UPI: Approval Pending, no uploads until approved; client and admin told', async () => {
  await turnOn('plan.purchase.admin', 'plan.payment.submitted');
  const plan = await pagePlan();

  await setWallet(0);
  const upiOnly = await buy(plan, { key: crypto.randomUUID(), upi: '412345678901' });
  assert.equal(upiOnly.status, 201, upiOnly.message);
  assert.deepEqual([upiOnly.data.walletPaid, upiOnly.data.upiPending], [0, 1500]);

  await setWallet(400);
  const mixed = await buy(plan, { key: crypto.randomUUID(), upi: '412345678902' });
  assert.deepEqual([mixed.data.walletPaid, mixed.data.upiPending], [400, 1100]);
  assert.equal(await wallet(), 0);

  for (const id of [upiOnly.data.orderId, mixed.data.orderId]) {
    const order = await Order.findById(id).lean();
    assert.equal(order.orderVisibility, 'pending-approval');
    assert.equal(getOrderState(order).label, 'Approval Pending');
    assert.equal(await upload(order), 'This service is awaiting payment approval');
  }

  const submitted = await mailsFor('plan.payment.submitted', 2);
  assert.deepEqual(submitted.map((mail) => mail.to[0]), ['client@example.test', 'client@example.test']);
  const mixedMail = submitted.find((mail) => /412345678902/.test(mail.text));
  assert.match(mixedMail.text, /Paid from wallet:\*\* ₹400/);
  assert.match(mixedMail.text, /Sent by UPI:\*\* ₹1,100/);
  const adminMails = await mailsFor('plan.purchase.admin', 2);
  assert.ok(adminMails.every((mail) => /Action needed: check the UPI payment and approve or reject it\./.test(mail.text)));

  // Admin approves the mixed one: the plan becomes active and uploads open.
  const approved = await call('/wallet/approve-transaction', { body: { transactionId: (await pendingUpi(mixed.data.orderId)).transactionId } });
  assert.equal(approved.status, 200, approved.message);
  const live = await Order.findById(mixed.data.orderId).lean();
  assert.equal(live.orderVisibility, 'approved');
  assert.equal(getOrderState(live).label, 'Active');
  assert.equal(await upload(live), 'allowed');
});

test('rejected UPI: Payment Rejected, uploads closed, wallet part returned, client told why', async () => {
  await turnOn('plan.payment.rejected');
  const plan = await pagePlan();
  await setWallet(400);
  const mixed = await buy(plan, { key: crypto.randomUUID(), upi: '412345678903' });
  await setWallet(0);
  const upiOnly = await buy(plan, { key: crypto.randomUUID(), upi: '412345678904' });

  for (const id of [mixed.data.orderId, upiOnly.data.orderId]) {
    const rejected = await call('/wallet/reject-transaction', { body: { transactionId: (await pendingUpi(id)).transactionId, rejectionReason: 'Payment not received' } });
    assert.equal(rejected.status, 200, rejected.message);
    const order = await Order.findById(id).lean();
    assert.equal(getOrderState(order).label, 'Payment Rejected');
    assert.notEqual(await upload(order), 'allowed');
  }
  assert.equal(await wallet(), 400, 'the wallet part of the mixed payment came back');

  const mails = await mailsFor('plan.payment.rejected', 2);
  const mixedMail = mails.find((mail) => /412345678903/.test(mail.text));
  assert.match(mixedMail.text, /Reason:\*\* Payment not received/);
  assert.match(mixedMail.text, /The ₹400 paid from your wallet has been returned to your wallet\./);
  assert.match(mixedMail.text, new RegExp(`https://portal.example.test/service-plan-detail/${plan._id}`));
  const upiMail = mails.find((mail) => /412345678904/.test(mail.text));
  assert.doesNotMatch(upiMail.text, /returned to your wallet/);
});

test('one purchase key = one order and one charge; another choice with the key is refused; no key still works', async () => {
  const plan = await pagePlan();
  const other = await pagePlan();
  const key = crypto.randomUUID();
  const first = await buy(plan, { key });
  const again = await buy(plan, { key });
  assert.equal(first.status, 201, first.message);
  assert.equal(again.status, 200, again.message);
  assert.equal(String(again.data.orderId), String(first.data.orderId));
  assert.equal(again.data.repeated, true);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await wallet(), 98500, 'charged once');

  const changed = await buy(other, { key });
  assert.equal(changed.status, 400);
  assert.equal(changed.message, 'This purchase identifier belongs to different selections');

  const keyless = await buy(plan);
  assert.equal(keyless.status, 201, keyless.message);
  assert.equal(await Order.countDocuments(), 2);
  assert.equal(await wallet(), 97000);
});

test('a double click (two requests at once with one key) makes one order and one wallet debit', async () => {
  const plan = await pagePlan();
  const key = crypto.randomUUID();
  const results = await Promise.all([buy(plan, { key }), buy(plan, { key })]);
  // The second one either waits behind the unique key (409), or arrives after and is answered with the
  // earlier order (200) or held for review (400). It never creates or charges a second time.
  assert.ok(results.some((r) => r.status === 201));
  assert.ok(results.every((r) => [200, 201, 400, 409].includes(r.status)), JSON.stringify(results.map((r) => [r.status, r.message])));
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await Transaction.countDocuments({ paymentMethod: 'wallet' }), 1);
  assert.equal(await wallet(), 98500);
});

test('a key whose earlier attempt left no payment record is not repeated blindly', async () => {
  const plan = await pagePlan();
  const key = crypto.randomUUID();
  const bought = await buy(plan, { key });
  await Transaction.deleteMany({ orderId: bought.data.orderId });
  const again = await buy(plan, { key });
  assert.equal(again.status, 400);
  assert.equal(again.message, 'Previous purchase needs review; no duplicate purchase was created');
  assert.equal(await Order.countDocuments(), 1);
});
