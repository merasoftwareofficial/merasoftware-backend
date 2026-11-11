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
  monthly: { billingOptions: CYCLES, maxTenureMonths: 12, uploadsPerMonth: 2 } };
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
const buy = (user, extra = {}, options) => purchasePackage({ userId: user._id, packageId: saved.id, choice: { paymentOption: 'full' }, quoteKey: quoteKey(saved),
  creationKey: `purchase-key-${++key}-abcdefghij`, ...extra }, options);
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
  assert.equal(await EmailHistory.countDocuments({ event: 'package.purchase.received' }), 1, 'the customer is told once their project is created');
  assert.equal(await EmailHistory.countDocuments({ event: 'sendProjectCreatedEmail' }), 0, 'not the admin form mail that says work has begun');
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
  await assert.rejects(buy(customer, { upiTransactionId: '123456789012', confirmRepeat: true }), /already recorded/, 'one UPI reference pays once');
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
  const told = await EmailDraft.findOne({ event: 'package.purchase.received' }).lean();
  assert.match(told.text, /Once it is approved, your work will start within 4 to 24 hours/);
  assert.match(told.text, /Paid from your wallet:\*\* ₹4,000/);
  assert.match(told.text, /Paid by UPI \(our team will verify it\):\*\* ₹6,000/);
  assert.match(told.text, /One-time payment of ₹10,000/);
  assert.match(told.text, /https:\/\/portal\.example\.test\/project-details\//);
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

test('a monthly package is bought as a plan: the first cycle is paid now, the plan engine bills the rest', async () => {
  const care = await savePackage({ ...MONTHLY, id: '' }, true, []);
  const choice = { billingCycle: 'quarterly', tenureMonths: 6 };
  const result = await purchasePackage({ userId: customer._id, packageId: care.id, choice, quoteKey: quoteKey(care), creationKey: 'monthly-key-abcdefghijk', upiTransactionId: '210987654321' });
  assert.equal(result.plan, true);
  const order = await Order.findById(result.orderId).lean();
  assert.deepEqual([order.isServicePlan, order.isWebsiteProject, order.serviceTotalCycles, order.serviceCyclePrice], [true, false, 2, 2700]);
  assert.equal(result.upiPending + result.walletPaid, 2700, 'cycle 1 only');
  assert.equal(order.salesPackage.package.billing, 'monthly');
  // A member pays wallet-only: the plan is live at once.
  const memberPlan = await purchasePackage({ userId: member._id, packageId: care.id, choice: { billingCycle: 'monthly', tenureMonths: 3 }, quoteKey: quoteKey(care), creationKey: 'monthly-member-abcdefghij' });
  const live = await Order.findById(memberPlan.orderId).lean();
  assert.deepEqual([live.orderVisibility, live.servicePlanStatus, memberPlan.walletPaid], ['approved', 'active', 1000]);
  await assert.rejects(purchasePackage({ userId: member._id, packageId: care.id, choice: { billingCycle: 'monthly', tenureMonths: 3 }, quoteKey: quoteKey(care), creationKey: 'monthly-member-second-abc' }),
    error => error.code === 'package_already_bought');
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

// The portal's "Start a Project" list and choice quote (owner decision 10 Nov 2026): the same prices the purchase charges.
test('catalogue: published one-time and monthly packages with the purchase price, nothing internal; empty while the system is off', async () => {
  const care = await savePackage({ ...MONTHLY, id: '' }, true, []);
  await savePackage({ ...base, name: 'Hidden Draft', status: 'draft', id: '' }, true, []);
  const { catalogueForCustomer } = require('../helpers/packagePurchase');
  const list = await catalogueForCustomer(customer._id);
  assert.equal(list.enabled, true);
  assert.deepEqual(list.packages.map(row => row.id).sort(), [saved.id, care.id].sort(), 'the published packages, monthly too');
  const monthly = list.packages.find(row => row.id === care.id);
  assert.deepEqual([monthly.billing, monthly.monthly.uploadsPerMonth, monthly.monthly.maxTenureMonths], ['monthly', 2, 12]);
  const row = list.packages.find(item => item.id === saved.id);
  assert.equal(row.price, 10000);
  assert.equal(row.mainPrice, 15000);
  assert.deepEqual(row.paymentOptions, ['full', 'installments_2']);
  for (const key of ['linkedPlanIds', 'pricing', 'design', 'pages', 'quoteKey']) assert.ok(!(key in row), `${key} is not sent`);
  process.env.PACKAGE_START_REQUESTS_ENABLED = 'false';
  assert.deepEqual(await catalogueForCustomer(customer._id), { enabled: false, packages: [] });
  await User.updateOne({ _id: customer._id }, { isActive: false });
  await assert.rejects(catalogueForCustomer(customer._id), /active permanent account/);
});

test('choice quote: the very quoteKey and dueNow the purchase accepts', async () => {
  const { quoteForCustomer } = require('../helpers/packagePurchase');
  const priced = await quoteForCustomer(member._id, saved.id, { paymentOption: 'installments_2' });
  assert.equal(priced.finalPrice, 10000);
  assert.equal(priced.dueNow, 5000);
  const result = await purchasePackage({ userId: member._id, packageId: saved.id, choice: { paymentOption: 'installments_2' }, quoteKey: priced.quoteKey,
    dueNow: priced.dueNow, creationKey: `purchase-key-${++key}-abcdefghij` });
  assert.equal(result.dueNow, 5000);
  await assert.rejects(quoteForCustomer(member._id, saved.id, { paymentOption: 'nope' }), /way to pay/);
  await assert.rejects(quoteForCustomer(member._id, 'nothing-here', {}), /not available/);
  process.env.PACKAGE_START_REQUESTS_ENABLED = 'false';
  await assert.rejects(quoteForCustomer(member._id, saved.id, { paymentOption: 'full' }), /not enabled yet/);
});

// The offer on a card (owner decision 10 Nov 2026): the list carries the offer's end and the server clock, and the
// offer leaves the list by itself when it ends, so a refreshed list shows the normal price.
test('catalogue: a running offer shows its price, end and the server clock; once it ends the list has the normal price', async () => {
  const { catalogueForCustomer } = require('../helpers/packagePurchase');
  const endsAt = new Date(Date.now() + 1500).toISOString();
  const offer = { slug: 'summer', title: 'Summer offer', status: 'published', endsAt, applicableCategories: ['standard_websites'], pricingRule: 'fixed_price',
    offerPrice: 7000, resolvedTerms: ['Offer terms'] };
  const withOffer = await savePackage({ ...base, name: 'Offer Pack', id: '', offerSlug: 'summer' }, true, [offer]);
  const live = global.fetch;
  global.fetch = async url => String(url).includes('/api/offers/live') ? { ok: true, json: async () => ({ offers: [offer], catalogueOffers: [offer], packagePages: [] }) } : live(url);
  try {
    const before = await catalogueForCustomer(customer._id);
    const running = before.packages.find(row => row.id === withOffer.id);
    assert.equal(running.price, 7000);
    assert.equal(running.mainPrice, 15000);
    assert.deepEqual(running.offer, { title: 'Summer offer', endsAt });
    assert.ok(Math.abs(Date.parse(before.serverNow) - Date.now()) < 5000, 'the server clock is sent');
    assert.equal(before.packages.find(row => row.id === saved.id).offer, null, 'a package without an offer has none');
    await new Promise(resolve => setTimeout(resolve, 1700));
    const after = (await catalogueForCustomer(customer._id)).packages.find(row => row.id === withOffer.id);
    assert.equal(after.offer, null, 'an ended offer is gone');
    assert.equal(after.price, 10000, 'the normal price again');
  } finally { global.fetch = live; }
});

// A member buys a package that has a running offer and pays by UPI (fix 11 Nov 2026). The offer's reservation lock
// bumps the account's version inside the purchase transaction; becoming a client must still work, with or without a
// phone already on the account ("No matching document found ... modifiedPaths roles" before the fix).
test('a member buys an offer package by UPI: becomes a client and the project is created, with or without a phone on the account', async () => {
  const offer = { slug: 'dhamaka', title: 'Dhamaka', status: 'published', endsAt: new Date(Date.now() + 48 * 3600e3).toISOString(), targets: ['projects'],
    applicableCategories: ['standard_websites'], pricingRule: 'fixed_price', offerPrice: 2099, resolvedTerms: [] };
  const withOffer = await savePackage({ ...base, name: 'Startup Offer', id: '', paymentOptions: ['full'], offerSlug: 'dhamaka' }, true, [offer]);
  const live = global.fetch;
  global.fetch = async url => String(url).includes('/api/offers/live') ? { ok: true, json: async () => ({ offers: [offer], catalogueOffers: [offer], packagePages: [] }) } : live(url);
  process.env.OFFER_RESERVATIONS_ENABLED = 'true';
  try {
    const noPhone = await User.create({ name: 'Member Two', email: 'member2@example.test', roles: ['member'], password: 'own-hash', walletBalance: 0 });
    await User.updateOne({ _id: member._id }, { walletBalance: 0 });
    const offerKey = quotePackage(withOffer, [offer]).quoteKey;
    for (const [user, upi, extra] of [[member, '100850359714', {}], [noPhone, '100850359715', { countryCode: '+91', phone: '9876500099' }]]) {
      const before = await User.findById(user._id).lean();
      const result = await purchasePackage({ userId: user._id, packageId: withOffer.id, choice: { paymentOption: 'full' }, quoteKey: offerKey,
        creationKey: `offer-key-${++key}-abcdefghij`, upiTransactionId: upi, ...extra });
      assert.equal(result.promoted, true);
      assert.equal(result.upiPending, 2099, 'the offer price is charged');
      assert.equal(result.approved, false, 'the UPI payment waits for the admin');
      const after = await User.findById(user._id).lean();
      assert.deepEqual(after.roles, ['customer']);
      assert.equal(after.password, before.password, 'the password the member chose stays');
      assert.equal(after.phone, before.phone || '+919876500099', 'a phone given at checkout is saved');
      const order = await Order.findById(result.orderId).lean();
      assert.equal(order.projectSnapshot.salesAgreement.offer.slug, 'dhamaka');
      assert.equal((await Transaction.findOne({ orderId: order._id }).lean()).status, 'pending');
    }
  } finally { global.fetch = live; delete process.env.OFFER_RESERVATIONS_ENABLED; }
});

// Buying a package again (owner decision 11 Nov 2026): while its project runs, a second purchase needs the customer's
// own "yes"; the same request sent again (a retry after a slow answer) is answered with its project, never refused.
test('a package bought already: asked before a second one, a retry of the same request is answered, a "yes" buys another', async () => {
  const first = await buy(customer, { upiTransactionId: '100850359714', creationKey: 'first-click-abcdefghijk' });
  const again = await buy(customer, { upiTransactionId: '100850359714', creationKey: 'first-click-abcdefghijk' });
  assert.equal(again.reused, true, 'the retry with the same UPI reference is the same purchase, not "already recorded"');
  assert.equal(again.orderId, first.orderId);
  const asked = await buy(customer, { upiTransactionId: '100850359799' }).catch(error => error);
  assert.equal(asked.statusCode, 409);
  assert.equal(asked.code, 'package_already_bought');
  assert.equal(asked.details.project.orderId, first.orderId);
  assert.equal(asked.details.project.packageId, saved.id);
  assert.equal(await Order.countDocuments(), 1, 'nothing more was made');
  assert.equal(await Transaction.countDocuments({ type: 'payment' }), 1);
  // "Proceed to pay" asks the same question and makes no new request.
  const startAsked = await start.requestPackageStart({ userId: customer._id, packageId: saved.id, choice: { paymentOption: 'full' }, kind: 'buy' }).catch(error => error);
  assert.equal(startAsked.code, 'package_already_bought');
  assert.equal(await StartRequest.countDocuments({ kind: 'buy' }), 0);
  const callback = await start.requestPackageStart({ userId: customer._id, packageId: saved.id, kind: 'callback' });
  assert.equal(callback.requested, true, 'a callback is never stopped');
  const list = await start.listPackageStarts(customer._id);
  assert.deepEqual(list.activeProjects.map(row => row.orderId), [first.orderId]);
  // The customer says yes: a second project.
  await start.requestPackageStart({ userId: customer._id, packageId: saved.id, choice: { paymentOption: 'full' }, kind: 'buy', confirmRepeat: true });
  const second = await buy(customer, { upiTransactionId: '100850359799', confirmRepeat: true });
  assert.notEqual(second.orderId, first.orderId);
  assert.equal(await Order.countDocuments({ userId: customer._id }), 2);
});

test('a cancelled, rejected or completed project does not stop buying the package again', async () => {
  for (const [field, value] of [['orderVisibility', 'cancelled'], ['orderVisibility', 'payment-rejected'], ['status', 'completed']]) {
    await Order.deleteMany({});
    await User.updateOne({ _id: member._id }, { walletBalance: 20000 });
    const first = await buy(member);
    await Order.updateOne({ _id: first.orderId }, { [field]: value });
    const next = await buy(member);
    assert.notEqual(next.orderId, first.orderId, `${field}=${value} lets the customer buy again`);
  }
});

test('the answer does not wait for the mails: the route runs them after it', async () => {
  let later = null;
  const result = await buy(customer, { upiTransactionId: '100850359714' }, { schedule: work => { later = work; } });
  assert.ok(result.orderId, 'the project is answered');
  assert.equal(await EmailHistory.countDocuments({ event: 'package.purchase.admin' }), 0, 'no mail yet');
  await later();
  assert.equal(await EmailHistory.countDocuments({ event: 'package.purchase.admin' }), 1, 'the team notice follows');
});
