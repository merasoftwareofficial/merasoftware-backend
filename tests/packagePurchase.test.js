// A customer buys a package project on the website and pays its first payment in the same request
// (helpers/packagePurchase.js, owner decisions 9 Nov 2026). Isolated MongoDB, fake email provider; nothing live.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const Catalogue = require('../models/salesCatalogueModel');
const StartRequest = require('../models/packageStartRequestModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const Category = require('../models/categoryBasePriceModel');
const { EmailDraft, EmailHistory, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { savePackage, quotePackage } = require('../helpers/salesPackages');
const { purchasePackage, paymentInfo } = require('../helpers/packagePurchase');
const { approveProjectPayment, rejectProjectPayment } = require('../helpers/projectPaymentSettlement');
const start = require('../helpers/packageStart');

const base = { name: 'Business Starter', description: 'A business website.', status: 'published', category: 'standard_websites', billing: 'one_time', portalUploads: true,
  paymentOptions: ['full', 'installments_2'], regularPrice: 15000, discountedPrice: 10000, offerExtraPrice: 0, offerSlug: '', inclusions: ['Website'], terms: [],
  linkedPlanIds: [], order: 0, pages: [] };
const CYCLES = [{ billingCycle: 'monthly', discountPercent: 0 }, { billingCycle: 'quarterly', discountPercent: 10 }];
const MONTHLY = { ...base, name: 'Monthly Care', paymentOptions: undefined, billing: 'monthly', regularPrice: 1500, discountedPrice: 1000,
  monthly: { pricing: 'fixed', billingOptions: CYCLES, maxTenureMonths: 12 } };
let database, member, customer, admin, saved, key = 0, emails;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Lead, Catalogue, StartRequest, Order, Invoice, Transaction, Category, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate].map(model => model.init()));
  Object.assign(process.env, {
    PORTFOLIO_WEBSITE_URL: 'https://website.example.test', FORNTEND_URL: 'https://portal.example.test', ADMIN_DASHBOARD_URL: 'https://portal.example.test',
    PORTFOLIO_INTEGRATION_SECRET: 'isolated-test-secret-32-characters-long', RESEND_API_KEY: 'isolated-test', FROM_EMAIL: 'sender@example.test',
    PACKAGE_START_REQUESTS_ENABLED: 'true',
  });
  global.fetch = async url => {
    if (String(url).includes('/api/offers/live')) return { ok: true, json: async () => ({ offers: [], catalogueOffers: [], packagePages: [] }) };
    if (String(url).includes('api.resend.com')) { emails++; return { ok: true, json: async () => ({ id: `provider-${emails}` }) }; }
    throw new Error(`Unexpected external request ${url}`);
  };
});
after(async () => { global.fetch = realFetch; await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [member, customer, admin] = await User.create([
    { name: 'Member', email: 'member@example.test', roles: ['member'], phone: '+919876500001', password: 'member-own-hash', walletBalance: 20000 },
    { name: 'Client', email: 'client@example.test', roles: ['customer'], phone: '+919876500002', walletBalance: 0 },
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
  ]);
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
  saved = await savePackage({ ...base, id: '' }, true, []);
  emails = 0; key = 0;
  process.env.PACKAGE_START_REQUESTS_ENABLED = 'true';
});
const quoteKey = pkg => quotePackage(pkg, []).quoteKey;
const buy = (user, extra = {}) => purchasePackage({ userId: user._id, packageId: saved.id, choice: { paymentOption: 'full' }, quoteKey: quoteKey(saved),
  creationKey: `purchase-key-${++key}-abcdefghij`, ...extra });
const wallet = async user => (await User.findById(user._id).lean()).walletBalance;

test('switched off by its flag; a stale price, an unknown package or no UPI reference writes nothing', async () => {
  process.env.PACKAGE_START_REQUESTS_ENABLED = 'false';
  await assert.rejects(buy(member), /not enabled yet/);
  process.env.PACKAGE_START_REQUESTS_ENABLED = 'true';
  await assert.rejects(buy(member, { quoteKey: 'old-key' }), /Review the new price/);
  await assert.rejects(buy(member, { dueNow: 1 }), /Review the new price/);
  await assert.rejects(buy(member, { packageId: 'nothing-here' }), /not available/);
  await assert.rejects(buy(customer), /UPI transaction ID is required/);
  assert.equal(await Order.countDocuments(), 0);
  assert.equal(await Invoice.countDocuments(), 0);
  assert.equal(await wallet(member), 20000);
  assert.equal((await User.findById(member._id).lean()).roles[0], 'member', 'a refused purchase never upgrades the account');
});

test('a member pays in full from the wallet: a client keeps their own password, the project is live and the team is told', async () => {
  const before = await User.findById(member._id).lean();
  await start.requestPackageStart({ userId: member._id, packageId: saved.id, choice: { paymentOption: 'full' } });
  const result = await buy(member);
  assert.equal(result.approved, true);
  assert.equal(result.promoted, true);
  assert.equal(result.walletPaid, 10000);
  assert.equal(result.upiPending, 0);
  const after = await User.findById(member._id).lean();
  assert.deepEqual(after.roles, ['customer']);
  assert.equal(after.password, before.password, 'the password the member chose stays');
  assert.equal(after.mustResetPassword, before.mustResetPassword);
  assert.equal(after.walletBalance, 10000);
  const order = await Order.findById(result.orderId).lean();
  assert.equal(order.orderVisibility, 'approved');
  assert.equal(order.status, 'in_progress');
  assert.equal(order.isWebsiteProject, true);
  assert.equal(order.paidAmount, 10000);
  assert.equal(order.paymentComplete, true);
  assert.equal(String(order.userId), String(member._id));
  assert.equal(order.projectSnapshot.salesAgreement.package.id, saved.id);
  const invoice = await Invoice.findById(result.invoiceId).lean();
  assert.equal(invoice.status, 'paid');
  assert.equal(await Transaction.countDocuments({ orderId: order._id, status: 'completed', paymentMethod: 'wallet' }), 1);
  const [request] = await StartRequest.find().lean();
  assert.equal(request.closedReason, 'project_created', 'the start request closes itself');
  assert.equal(String(request.projectId), String(order._id));
  assert.ok(await Lead.findOne({ convertedToUserId: member._id, status: 'Won' }), 'the new client has a Won lead');
  assert.equal(await EmailHistory.countDocuments({ event: 'package.purchase.admin' }), 1, 'one team notice');
});

test('a client with no wallet money pays by UPI: the project waits for the admin, who approves it', async () => {
  await assert.rejects(buy(customer, { upiTransactionId: '123' }), /at least 12 digits/);
  const result = await buy(customer, { upiTransactionId: '123456789012' });
  assert.equal(result.approved, false);
  assert.equal(result.promoted, false);
  assert.equal(result.upiPending, 10000);
  let order = await Order.findById(result.orderId).lean();
  assert.equal(order.orderVisibility, 'pending-approval');
  assert.equal(order.paidAmount, 0);
  const pending = await Transaction.findOne({ orderId: order._id });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.paymentMethod, 'upi');
  assert.equal(pending.amount, 10000);
  assert.equal(String(pending.invoiceId), result.invoiceId);
  assert.equal((await Invoice.findById(result.invoiceId).lean()).status, 'unpaid');
  await assert.rejects(buy(customer, { upiTransactionId: '123456789012' }), /already recorded/, 'one UPI reference pays once');
  await approveProjectPayment(pending.transactionId, admin._id);
  order = await Order.findById(result.orderId).lean();
  assert.equal(order.orderVisibility, 'approved');
  assert.equal(order.status, 'in_progress');
  assert.equal(order.paidAmount, 10000);
  assert.equal((await Invoice.findById(result.invoiceId).lean()).status, 'paid');
});

test('a wallet that covers only part pays that part at once; a rejected UPI part gives it back', async () => {
  await User.updateOne({ _id: customer._id }, { walletBalance: 4000 });
  const result = await buy(customer, { upiTransactionId: '123456789012' });
  assert.equal(result.walletPaid, 4000);
  assert.equal(result.upiPending, 6000);
  assert.equal(await wallet(customer), 0);
  assert.equal((await Invoice.findById(result.invoiceId).lean()).status, 'partially_paid');
  const pending = await Transaction.findOne({ orderId: result.orderId, status: 'pending' });
  assert.equal(pending.amount, 6000);
  await rejectProjectPayment(pending.transactionId, admin._id, 'Payment not received');
  assert.equal(await wallet(customer), 4000, 'the wallet part comes back');
  assert.equal((await Order.findById(result.orderId).lean()).orderVisibility, 'payment-rejected');
});

test('an installment package: the first payment starts the project, the rest follow in the portal', async () => {
  const result = await buy(member, { choice: { paymentOption: 'installments_2' } });
  assert.equal(result.dueNow, 5000);
  assert.equal(result.approved, true);
  const order = await Order.findById(result.orderId).lean();
  assert.equal(order.isPartialPayment, true);
  assert.equal(order.installments.length, 2);
  assert.equal(order.installments[0].paid, true);
  assert.equal(order.installments[1].paid, false);
  assert.equal(order.currentInstallment, 2);
  assert.equal(order.paidAmount, 5000);
  assert.equal(await wallet(member), 15000);
});

test('a monthly package: the first cycle is paid and the cycles follow', async () => {
  const care = await savePackage({ ...MONTHLY, id: '' }, true, []);
  const choice = { billingCycle: 'quarterly', tenureMonths: 6 };
  const result = await purchasePackage({ userId: customer._id, packageId: care.id, choice, quoteKey: quoteKey(care), creationKey: 'monthly-key-abcdefghijk', upiTransactionId: '210987654321' });
  const order = await Order.findById(result.orderId).lean();
  assert.equal(order.isPartialPayment, true);
  assert.equal(order.installments.length, 2, 'two quarterly cycles in six months');
  assert.equal(result.upiPending, order.installments[0].amount);
  assert.equal(order.projectSnapshot.salesAgreement.package.billing, 'monthly');
});

test('the same purchase sent twice makes one project and one payment', async () => {
  const same = { creationKey: 'same-click-abcdefghijklm' };
  const [first, second] = await Promise.all([buy(member, same), buy(member, same).catch(error => ({ error }))]);
  const again = await buy(member, same);
  assert.equal(again.reused, true);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await Transaction.countDocuments({ type: 'payment' }), 1);
  assert.equal(await wallet(member), 10000, 'debited once');
  assert.ok(first.orderId || second.orderId);
});

test('payment info: the wallet balance and the UPI payee, for an active account only', async () => {
  const info = await paymentInfo(member._id);
  assert.equal(info.walletBalance, 20000);
  assert.match(info.upiId, /@/);
  await User.updateOne({ _id: member._id }, { isActive: false });
  await assert.rejects(paymentInfo(member._id), /active permanent account/);
});

test('staff without a client or member role cannot buy', async () => {
  await assert.rejects(buy(admin), /client account/);
});
