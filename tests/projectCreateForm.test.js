// Admin "Create Project" form + admin payment recording (work96):
//   ₹0 FREE project, optional website offer, "project created" review mail, and the
//   method-specific payment evidence rules (helpers/paymentEvidence.js).
// Isolated: in-memory MongoDB, the website and the mail provider are never contacted.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { requestMiddleware } = require('../helpers/emailController');
const { EmailDraft } = require('../models/emailControlModel');
const userModel = require('../models/userModel');
const orderModel = require('../models/orderProductModel');
const invoiceModel = require('../models/invoiceModel');
const transactionModel = require('../models/transactionModel');
const categoryBasePriceModel = require('../models/categoryBasePriceModel');
const authToken = require('../middleware/authToken');

const nativeFetch = global.fetch;
let db, server, base, admin, customer, websiteCalls;
const LIVE_OFFERS = [{ slug: 'diwali', title: 'Diwali Offer', endsAt: '2099-01-01T00:00:00.000Z' }];

const cookie = (user) => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function api(path, body, method = 'POST') {
  const response = await nativeFetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie(admin) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, ...await response.json() };
}
const create = (body) => api(`/admin/clients/${customer._id}/create-project`, { category: 'standard_websites', ...body });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-project-form-secret';
  process.env.PORTFOLIO_WEBSITE_URL = 'https://website.example.test';
  process.env.PORTFOLIO_INTEGRATION_SECRET = 'x'.repeat(40);
  db = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  await mongoose.connect(db.getUri(), { dbName: 'project-form-isolated-test' });
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
  ]);
  await categoryBasePriceModel.create({ category: 'standard_websites', basePrice: 10000 });
  // Only the website's live-offers endpoint is mocked; anything else is a test failure.
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://website.example.test/api/offers/live');
    assert.equal(options.headers.Authorization, `Bearer ${'x'.repeat(40)}`);
    websiteCalls += 1;
    return new Response(JSON.stringify({ offers: LIVE_OFFERS }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use(requestMiddleware);
  app.post('/admin/clients/:customerId/create-project', authToken, require('../controller/order/adminCreateProjectOrder'));
  app.get('/admin/website-offers', authToken, require('../controller/order/adminWebsiteOffers'));
  app.post('/admin/projects/:orderId/approval', authToken, require('../controller/order/approveProjectOrder'));
  app.post('/admin/clients/:customerId/recharge-wallet', authToken, require('../controller/user/adminRechargeWallet'));
  await transactionModel.syncIndexes();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  websiteCalls = 0;
  await Promise.all([orderModel.deleteMany({}), invoiceModel.deleteMany({}), transactionModel.deleteMany({}), EmailDraft.deleteMany({})]);
});
after(async () => {
  global.fetch = nativeFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('₹0 project: approved at birth, FREE paid invoice with discount line, final invoice paid, review mail queued', async () => {
  const result = await create({ sellingPrice: 0, paymentType: 'full', offerSlug: 'diwali' });
  assert.equal(result.status, 201, result.message);
  assert.equal(result.emailStatus, 'awaiting-review');
  assert.equal(result.emailDraftIds.length, 1);
  const draft = await EmailDraft.findById(result.emailDraftIds[0]).lean();
  assert.equal(draft.event, 'sendProjectCreatedEmail');
  assert.deepEqual(draft.to, ['customer@example.test']);
  assert.match(draft.text, /FREE/);
  assert.match(draft.text, /Diwali Offer/);

  const order = await orderModel.findById(result.data._id).lean();
  assert.equal(order.orderVisibility, 'approved');
  assert.equal(order.status, 'in_progress');
  assert.equal(order.paymentComplete, true);
  assert.deepEqual(order.projectSnapshot.offer, { slug: 'diwali', title: 'Diwali Offer' });

  const invoice = await invoiceModel.findOne({ orderId: order._id, invoiceType: 'project' }).lean();
  assert.equal(invoice.amount, 0);
  assert.equal(invoice.status, 'paid');
  assert.ok(invoice.paidDate);
  assert.deepEqual(invoice.lineItems.map((item) => [item.name, item.price]), [
    ['Standard Website (Base)', 10000],
    ['Discount (Diwali Offer)', -10000],
  ]);
  const finalInvoice = await invoiceModel.findOne({ orderId: order._id, invoiceType: 'project_final' }).lean();
  assert.equal(finalInvoice.status, 'paid');
  assert.equal(await transactionModel.countDocuments(), 0, 'a free project records no payment');
});

test('₹0 project cannot be split into installments; missing price is still refused', async () => {
  assert.equal((await create({ sellingPrice: 0, paymentType: 'partial', installmentCount: 2 })).status, 400);
  assert.equal((await create({ sellingPrice: '', paymentType: 'full' })).status, 400);
  assert.equal(await orderModel.countDocuments(), 0);
});

test('offer that is not live on the website is refused before anything is written', async () => {
  const result = await create({ sellingPrice: 5000, paymentType: 'full', offerSlug: 'expired-offer' });
  assert.equal(result.status, 400);
  assert.equal(await orderModel.countDocuments(), 0);
  assert.equal(await invoiceModel.countDocuments(), 0);
});

test('website offers endpoint lists the live offers', async () => {
  const result = await api('/admin/website-offers', null, 'GET');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, LIVE_OFFERS);
});

test('UPI: digits only, at least 12 — a bad reference leaves no half-made project', async () => {
  const bad = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'upi', transactionReference: '12345678901' } });
  assert.equal(bad.status, 400);
  assert.equal(await orderModel.countDocuments(), 0);
  assert.equal(await invoiceModel.countDocuments(), 0);

  const ok = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'upi', transactionReference: '412345678901' } });
  assert.equal(ok.status, 201, ok.message);
  const invoice = await invoiceModel.findOne({ invoiceType: 'project' }).lean();
  assert.equal(invoice.status, 'paid');
  assert.deepEqual(invoice.lineItems.at(-1), { name: 'Discount', price: -2000 });
});

test('bank transfer needs a mode and an alphanumeric UTR; a UTR is recorded once', async () => {
  const noMode = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'bank_transfer', transactionReference: 'HDFC12345' } });
  assert.equal(noMode.status, 400);
  const badRef = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'bank_transfer', transactionReference: 'HD-1', paymentDetails: { transferMode: 'neft' } } });
  assert.equal(badRef.status, 400);
  assert.equal(await orderModel.countDocuments(), 0);

  const ok = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'bank_transfer', transactionReference: 'hdfcn5202610161', paymentDetails: { transferMode: 'neft' } } });
  assert.equal(ok.status, 201, ok.message);
  const txn = await transactionModel.findOne({ paymentMethod: 'bank_transfer' }).lean();
  assert.equal(txn.paymentEvidence.bankTransferMode, 'neft');
  assert.equal(txn.paymentEvidence.bankReference, 'HDFCN5202610161');
  assert.equal(txn.upiTransactionId, 'HDFCN5202610161');

  const dup = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'bank_transfer', transactionReference: 'HDFCN5202610161', paymentDetails: { transferMode: 'imps' } } });
  assert.equal(dup.status, 409);
  assert.equal(await orderModel.countDocuments(), 1);
});

test('cheque needs a 6-digit number, bank name and date', async () => {
  const bad = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'cheque', transactionReference: '12345', paymentDetails: { chequeBankName: 'SBI', chequeDate: '2026-10-16' } } });
  assert.equal(bad.status, 400);
  const noBank = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'cheque', transactionReference: '123456', paymentDetails: { chequeDate: '2026-10-16' } } });
  assert.equal(noBank.status, 400);

  const ok = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'cheque', transactionReference: '123456', paymentDetails: { chequeBankName: 'State Bank of India', chequeDate: '2026-10-16' } } });
  assert.equal(ok.status, 201, ok.message);
  const txn = await transactionModel.findOne({ paymentMethod: 'cheque' }).lean();
  assert.equal(txn.paymentEvidence.chequeNumber, '123456');
  assert.equal(txn.paymentEvidence.chequeBankName, 'State Bank of India');
  const invoice = await invoiceModel.findOne({ invoiceType: 'project' }).lean();
  assert.equal(invoice.paymentMethod, 'cheque');
});

test('cash needs no reference and stores none', async () => {
  const ok = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'cash', transactionReference: 'anything typed' } });
  assert.equal(ok.status, 201, ok.message);
  const txn = await transactionModel.findOne({ paymentMethod: 'cash' }).lean();
  assert.equal(txn.upiTransactionId, null);
});

test('approve-with-payment and wallet recharge apply the same rules', async () => {
  const pending = await create({ sellingPrice: 8000, paymentType: 'full' });
  assert.equal(pending.status, 201);
  const badApprove = await api(`/admin/projects/${pending.data._id}/approval`, { mode: 'approve_with_payment', paymentMethod: 'bank_transfer', transactionReference: 'ABC123' });
  assert.equal(badApprove.status, 400);
  const approve = await api(`/admin/projects/${pending.data._id}/approval`, { mode: 'approve_with_payment', paymentMethod: 'bank_transfer', transactionReference: 'ABC123456', paymentDetails: { transferMode: 'rtgs' } });
  assert.equal(approve.status, 200, approve.message);
  assert.equal((await orderModel.findById(pending.data._id).lean()).orderVisibility, 'approved');

  const badRecharge = await api(`/admin/clients/${customer._id}/recharge-wallet`, { amount: 500, paymentMethod: 'cheque', reference: '123' });
  assert.equal(badRecharge.status, 400);
  const before = (await userModel.findById(customer._id).lean()).walletBalance || 0;
  assert.equal(before, 0, 'a refused recharge never credits the wallet');
  const recharge = await api(`/admin/clients/${customer._id}/recharge-wallet`, { amount: 500, paymentMethod: 'cheque', reference: '654321', paymentDetails: { chequeBankName: 'HDFC Bank', chequeDate: '2026-10-15' } });
  assert.equal(recharge.status, 201, recharge.message);
  assert.equal((await userModel.findById(customer._id).lean()).walletBalance, 500);
});
