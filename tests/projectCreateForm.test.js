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
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { requestMiddleware } = require('../helpers/emailController');
const { EmailDraft } = require('../models/emailControlModel');
const userModel = require('../models/userModel');
const orderModel = require('../models/orderProductModel');
const invoiceModel = require('../models/invoiceModel');
const transactionModel = require('../models/transactionModel');
const categoryBasePriceModel = require('../models/categoryBasePriceModel');
const authToken = require('../middleware/authToken');
const { seedStarterPackages } = require('./fixtures/salesPackages');

test('a selected reservation cannot be silently discarded when its offer is missing', async () => {
  const { resolveProjectPricing } = require('../helpers/projectPricing');
  await assert.rejects(resolveProjectPricing({ body: { offerReservationId: new mongoose.Types.ObjectId().toString() }, category: 'standard_websites', basePrice: 10000, features: [], referenceTotal: 10000, userId: new mongoose.Types.ObjectId() }), /Select the reserved offer/);
});

const nativeFetch = global.fetch;
let db, server, base, admin, customer, websiteCalls, app;
const LIVE_OFFERS = [
  { slug: 'diwali', title: 'Diwali Offer', status: 'published', endsAt: '2099-01-01T00:00:00.000Z', mainPrice: 10000, offerPrice: 0, pricingRule: 'fixed_price', applicableCategories: ['standard_websites'], packageIds: [], inclusions: ['Free starter scope'], resolvedTerms: ['Agreed free setup'], quoteKey: 'diwali-v1' },
  { slug: 'page', title: 'Business Growth Starter', status: 'published', endsAt: '2099-01-01T00:00:00.000Z', mainPrice: 10000, offerPrice: 699, pricingRule: 'fixed_price', applicableCategories: ['standard_websites'], packageIds: [], inclusions: ['Starter scope'], resolvedTerms: ['Agreed starter terms'], quoteKey: 'starter-v1' },
];

const cookie = (user) => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function api(path, body, method = 'POST') {
  const response = await nativeFetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie(admin) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, ...await response.json() };
}
const create = (body) => api(`/admin/clients/${customer._id}/create-project`, { category: 'standard_websites', ...(body.offerSlug === 'diwali' ? { offerQuoteKey: 'diwali-v1' } : {}), ...body });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-project-form-secret';
  process.env.PORTFOLIO_WEBSITE_URL = 'https://website.example.test';
  process.env.PORTFOLIO_INTEGRATION_SECRET = 'x'.repeat(40);
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60000 }] });
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
  app = express(); app.use(express.json()); app.use(cookieParser()); app.use(requestMiddleware);
  app.post('/admin/clients/:customerId/create-project', authToken, require('../controller/order/adminCreateProjectOrder'));
  app.get('/admin/website-offers', authToken, require('../controller/order/adminWebsiteOffers'));
  const salesController = require('../controller/order/salesPackagesController');
  app.get('/admin/sales-packages', authToken, salesController.adminRead);
  app.patch('/admin/sales-packages', authToken, salesController.adminSave);
  app.patch('/admin/sales-packages/offer-links', authToken, salesController.adminLinkOffer);
  app.get('/integration/sales-packages', salesController.integrationRead);
  app.post('/admin/projects/:orderId/approval', authToken, require('../controller/order/approveProjectOrder'));
  app.post('/wallet/approve-transaction', authToken, require('../controller/user/transactionApprovalController').approveTransaction);
  app.post('/admin/clients/:customerId/recharge-wallet', authToken, require('../controller/user/adminRechargeWallet'));
  await transactionModel.syncIndexes();
  await orderModel.syncIndexes();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  websiteCalls = 0;
  await Promise.all([orderModel.deleteMany({}), invoiceModel.deleteMany({}), transactionModel.deleteMany({}), EmailDraft.deleteMany({}), require('../models/salesCatalogueModel').deleteMany({}), require('../models/productModel').deleteMany({})]);
  await seedStarterPackages(require('../models/salesCatalogueModel'));
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
    ['Diwali Offer', 10000],
    ['Offer benefit (Diwali Offer)', -10000],
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


test('package catalogue: three starter prices, category eligibility, immutable agreement, no service purchase', async () => {
  const catalog = await api('/admin/sales-packages', null, 'GET');
  assert.equal(catalog.status, 200, catalog.message);
  assert.deepEqual(catalog.data.packages.map(item => item.quote.finalPrice), [699, 2699, 4699]);
  const starter = catalog.data.packages[0];
  const created = await create({ sellingPrice: 699, paymentType: 'partial', installmentCount: 2, packageId: starter.id, packageQuoteKey: starter.quoteKey, offerSlug: 'page' });
  assert.equal(created.status, 201, created.message);
  const order = await orderModel.findById(created.data._id).lean();
  assert.equal(order.projectSnapshot.salesAgreement.package.id, 'starter');
  assert.equal(order.projectSnapshot.salesAgreement.finalPrice, 699);
  assert.equal(order.projectSnapshot.salesAgreement.offerDiscount, 9301);
  assert.equal(order.installments.reduce((sum, item) => sum + item.amount, 0), 699);
  assert.equal(await orderModel.countDocuments({ isServicePlan: true }), 0);
  const edited = { ...starter, name: 'Renamed Starter', inclusions: ['Changed scope'] };
  const saved = await api('/admin/sales-packages', { item: edited, creating: false }, 'PATCH');
  assert.equal(saved.status, 200, saved.message);
  const unchanged = await orderModel.findById(order._id).lean();
  assert.equal(unchanged.projectSnapshot.salesAgreement.package.name, 'Business Starter');
  assert.notDeepEqual(unchanged.projectSnapshot.salesAgreement.scope, ['Changed scope']);
  const stale = await create({ sellingPrice: 699, packageId: starter.id, packageQuoteKey: starter.quoteKey });
  assert.equal(stale.status, 409);
  assert.equal(await orderModel.countDocuments(), 1);
});

test('tampered price/category/quote and unlabelled adjustment are refused before writes', async () => {
  const catalog = await api('/admin/sales-packages', null, 'GET');
  const starter = catalog.data.packages[0];
  const base = { sellingPrice: 699, packageId: starter.id, packageQuoteKey: starter.quoteKey };
  // A price that does not equal quote + adjustment means the quote moved under the form.
  assert.equal((await create({ ...base, sellingPrice: 1 })).status, 409);
  assert.equal((await create({ ...base, sellingPrice: 1200, priceAdjustment: 500, adjustmentLabel: 'Stale' })).status, 409);
  assert.equal((await create({ ...base, category: 'dynamic_websites' })).status, 400);
  assert.equal((await create({ ...base, packageQuoteKey: 'stale' })).status, 409);
  assert.equal((await create({ ...base, sellingPrice: 599, priceAdjustment: -100 })).status, 400);
  assert.equal((await create({ ...base, sellingPrice: 599, priceAdjustment: -100, adjustmentLabel: 'x'.repeat(121) })).status, 400);
  assert.equal((await create({ ...base, sellingPrice: 0, priceAdjustment: -700, adjustmentLabel: 'Too much' })).status, 400);
  assert.equal((await create({ ...base, sellingPrice: 599.999, priceAdjustment: -99.999, adjustmentLabel: 'Paise' })).status, 400);
  assert.equal(await orderModel.countDocuments(), 0);
  assert.equal(await invoiceModel.countDocuments(), 0);
  const valid = await create({ ...base, sellingPrice: 599, priceAdjustment: -100, adjustmentLabel: 'Loyal client discount' });
  assert.equal(valid.status, 201, valid.message);
  const invoice = await invoiceModel.findOne({ orderId: valid.data._id }).lean();
  assert.equal(invoice.lineItems.reduce((sum, item) => sum + item.price, 0), 599);
  assert.deepEqual([invoice.lineItems.at(-1).name, invoice.lineItems.at(-1).price], ['Loyal client discount', -100]);
});

test('offer price never locks the selling price: labelled upward and downward adjustments are frozen', async () => {
  const raised = await create({ sellingPrice: 1200, paymentType: 'full', offerSlug: 'page', offerQuoteKey: 'starter-v1', priceAdjustment: 501, adjustmentLabel: 'Extra custom work' });
  assert.equal(raised.status, 201, raised.message);
  const order = await orderModel.findById(raised.data._id).lean();
  const agreement = order.projectSnapshot.salesAgreement;
  assert.equal(agreement.version, 2);
  assert.deepEqual([agreement.offerDiscount, agreement.priceAdjustment, agreement.adjustmentLabel, agreement.finalPrice], [9301, 501, 'Extra custom work', 1200]);
  assert.equal('adminDiscount' in agreement, false);
  assert.equal(order.totalAmount, 1200);
  const invoice = await invoiceModel.findOne({ orderId: order._id, invoiceType: 'project' }).lean();
  assert.equal(invoice.amount, 1200);
  assert.deepEqual(invoice.lineItems.map(item => [item.name, item.price]), [
    ['Business Growth Starter', 10000], ['Offer benefit (Business Growth Starter)', -9301], ['Extra custom work', 501],
  ]);
  const lowered = await create({ sellingPrice: 500, paymentType: 'full', offerSlug: 'page', offerQuoteKey: 'starter-v1', priceAdjustment: -199, adjustmentLabel: 'Festive goodwill' });
  assert.equal(lowered.status, 201, lowered.message);
  // An unlabelled zero adjustment stores no label at all.
  const plain = await create({ sellingPrice: 699, paymentType: 'full', offerSlug: 'page', offerQuoteKey: 'starter-v1', priceAdjustment: 0, adjustmentLabel: 'ignored' });
  assert.equal((await orderModel.findById(plain.data._id).lean()).projectSnapshot.salesAgreement.adjustmentLabel, '');
});

test('archived package cannot create new projects and stays archived', async () => {
  const catalog = await api('/admin/sales-packages', null, 'GET');
  const starter = catalog.data.packages[0];
  assert.equal((await api('/admin/sales-packages', { item: { ...starter, status: 'archived' }, creating: false }, 'PATCH')).status, 200);
  const rejected = await create({ sellingPrice: 699, packageId: starter.id, packageQuoteKey: starter.quoteKey });
  assert.equal(rejected.status, 400);
  const fresh = await api('/admin/sales-packages', null, 'GET');
  assert.equal(fresh.data.packages.find(item => item.id === 'starter').status, 'archived');
});

test('package management requires portal admin; integration requires shared secret', async () => {
  const forbidden = await nativeFetch(base + '/admin/sales-packages', { headers: { Cookie: cookie(customer) } });
  assert.equal(forbidden.status, 403);
  assert.equal((await nativeFetch(base + '/integration/sales-packages')).status, 401);
  const allowed = await nativeFetch(base + '/integration/sales-packages', { headers: { Authorization: `Bearer ${'x'.repeat(40)}` } });
  assert.equal(allowed.status, 200);
  const catalog = await allowed.json();
  assert.equal(catalog.data.packages.length, 3);
  assert.equal('linkedPlanIds' in catalog.data.packages[0], false);
});

test('no built-in packages: an empty catalogue lists nothing and the first save adds only that package', async () => {
  await require('../models/salesCatalogueModel').deleteMany({});
  assert.deepEqual((await api('/admin/sales-packages', null, 'GET')).data.packages, []);
  const { STARTER_PACKAGES } = require('./fixtures/salesPackages');
  const item = { ...STARTER_PACKAGES[0], id: 'own-package', offerSlug: '', billing: 'one_time', portalUploads: true, paymentOptions: ['full'] };
  assert.equal((await api('/admin/sales-packages', { item, creating: true }, 'PATCH')).status, 200);
  assert.deepEqual((await api('/admin/sales-packages', null, 'GET')).data.packages.map(row => row.id), ['own-package']);
});

test('offer and package links are one record: either editor shows the other side, one offer per package', async () => {
  const link = (offerSlug, packageIds) => api('/admin/sales-packages/offer-links', { offerSlug, packageIds }, 'PATCH');
  const offerOf = async () => Object.fromEntries((await api('/admin/sales-packages', null, 'GET')).data.packages.map(row => [row.id, row.offerSlug]));
  // Offer side: ticking moves a package from another offer; unticking clears only this offer's packages.
  assert.equal((await link('diwali', ['starter'])).status, 200);
  assert.deepEqual(await offerOf(), { starter: 'diwali', 'starter-plus': 'page', 'starter-complete': 'page' });
  const catalog = await api('/admin/sales-packages', null, 'GET');
  assert.equal(catalog.data.packages.find(row => row.id === 'starter').quote.offer.slug, 'diwali');
  assert.equal((await link('page', ['starter-plus'])).status, 200);
  assert.deepEqual(await offerOf(), { starter: 'diwali', 'starter-plus': 'page', 'starter-complete': '' });
  // Package side: saving a package with an offer is what the offer editor reads back.
  const complete = catalog.data.packages.find(row => row.id === 'starter-complete');
  assert.equal((await api('/admin/sales-packages', { item: { ...complete, offerSlug: 'diwali', quote: undefined, quoteKey: undefined }, creating: false }, 'PATCH')).status, 200);
  assert.deepEqual(await offerOf(), { starter: 'diwali', 'starter-plus': 'page', 'starter-complete': 'diwali' });
  // Refused without any write: unknown offer, unknown package, package outside the offer's categories.
  assert.equal((await link('missing', ['starter'])).status, 400);
  assert.equal((await link('page', ['nope'])).status, 400);
  const seo = { ...complete, id: 'other-cat', category: 'dynamic_websites', offerSlug: '', quote: undefined, quoteKey: undefined };
  await require('../models/salesCatalogueModel').updateOne({ _id: 'packages' }, { $set: { 'packages.other-cat': seo } });
  assert.equal((await link('page', ['starter-plus', 'other-cat'])).status, 400);
  assert.deepEqual(await offerOf(), { starter: 'diwali', 'starter-plus': 'page', 'starter-complete': 'diwali', 'other-cat': '' });
});


test('repeated creation request creates one project and one payable bill', async () => {
  const payload = { creationKey: 'isolated-request-123456789', sellingPrice: 1000, paymentType: 'full' };
  const first = await create(payload);
  const second = await create(payload);
  assert.equal(first.status, 201, first.message);
  assert.equal(second.status, 200, second.message);
  assert.equal(String(first.data._id), String(second.data._id));
  assert.equal(await orderModel.countDocuments(), 1);
  assert.equal(await invoiceModel.countDocuments({ invoiceType: 'project' }), 1);
  assert.equal(await invoiceModel.countDocuments({ invoiceType: 'project_final' }), 1);
  assert.equal((await create({ ...payload, sellingPrice: 2000 })).status, 409);
});

if (process.env.TEST_SALES_BROWSER === '1') test('actual package editor, admin project form and client agreement work in the browser', { timeout: 120000 }, async () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const { build } = require('../../merasoftware/node_modules/esbuild');
  const { chromium } = require('../../merasoftware/node_modules/playwright');
  const parser = require('../../frontend/node_modules/@babel/parser');
  const frontend = path.resolve(__dirname, '../../frontend'); const website = path.resolve(__dirname, '../../merasoftware');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mera-sales-browser-'));
  const source = fs.readFileSync(path.join(frontend, 'src/pages/AdminClientWorkspace.js'), 'utf8');
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const declaration = ast.program.body.find(node => node.type === 'VariableDeclaration' && node.declarations.some(row => row.id.name === 'CreateProjectForClientForm'));
  const inputs = source.slice(source.indexOf('const projectFormInputClassName'), source.indexOf('const CreateProjectForClientForm'));
  const fixtureApi = { allProduct: { url: base+'/products' }, categoryBasePrices: { url: base+'/base-prices', method: 'get' }, adminSalesPackages: { url: base+'/admin/sales-packages' }, adminCreateProjectOrder: { url: base+'/admin/clients', method: 'post' } };
  const apiSource = `const SummaryApi=${JSON.stringify(fixtureApi)};`;
  // The real hooks/useProjectCategories.js imports ../common; point it at the same fixture API.
  const mockCommon = { name: 'mock-common', setup(b) { b.onResolve({ filter: /^\.\.\/common$/ }, () => ({ path: 'common', namespace: 'mock' })); b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `export default ${JSON.stringify(fixtureApi)};`, loader: 'js' })); } };
  const entry = `import React,{useState,useEffect,useRef} from 'react';import{createRoot}from'react-dom/client';import{X,Save}from'lucide-react';import{toast}from'sonner';import{isFeatureForCategory}from'../helpers/projectCategoryOptions';import useProjectCategories from'../hooks/useProjectCategories';import PaymentMethodFields from '../components/PaymentMethodFields';import{createPaymentEntry,getPaymentEntryError,toPaymentRequest}from'../helpers/paymentMethodRules';import{buildInstallmentPreview}from'../helpers/projectInstallments';import ProjectAgreement from '../components/ProjectAgreement';${apiSource}const FEATURE_UPGRADE_CATEGORY='feature_upgrades';${inputs}${source.slice(declaration.start,declaration.end)};const root=createRoot(document.getElementById('app'));if(location.pathname==='/client-agreement'){fetch('/latest-order').then(r=>r.json()).then(order=>root.render(<ProjectAgreement order={order}/>));}else root.render(<CreateProjectForClientForm mode="package" clientName="Fixture Client" customerId="${customer._id}" onCancel={()=>{}} onCreated={()=>document.body.setAttribute('data-created','true')}/>);`;
  await build({ stdin: { contents: entry, loader: 'jsx', resolveDir: path.join(frontend,'src/pages') }, bundle:true, loader:{'.js':'jsx'}, outfile:path.join(folder,'project.js'), platform:'browser', jsx:'automatic', plugins:[mockCommon] });
  const managerEntry = `import React from 'react';import{createRoot}from'react-dom/client';import{PackagesManager}from'@/app/admin/packages/packages-manager';fetch('/api/packages').then(r=>r.json()).then(initial=>createRoot(document.getElementById('app')).render(<PackagesManager initial={initial}/>));`;
  await build({ stdin:{contents:managerEntry,loader:'tsx',resolveDir:website},bundle:true,outfile:path.join(folder,'manager.js'),platform:'browser',jsx:'automatic',tsconfig:path.join(website,'tsconfig.json') });
  app.get('/api/time',(req,res)=>res.json({now:Date.now()}));
  app.get('/products', (req,res)=>res.json({success:true,data:[]}));
  app.get('/base-prices', (req,res)=>res.json({success:true,data:[{category:'standard_websites',label:'Standard Website',status:'active',basePrice:10000,configured:true,description:'',startingNodeTitle:'Fixture kickoff'}]}));
  app.get('/api/packages', async(req,res)=>{const result=await nativeFetch(base+'/admin/sales-packages',{headers:{Cookie:cookie(admin)}});res.status(result.status).json((await result.json()).data);});
  app.patch('/api/packages', async(req,res)=>{const result=await nativeFetch(base+'/admin/sales-packages',{method:'PATCH',headers:{Cookie:cookie(admin),'Content-Type':'application/json'},body:JSON.stringify(req.body)});const body=await result.json();res.status(result.status).json(result.ok?body.data:{error:body.message});});
  app.get('/latest-order',async(req,res)=>res.json(await orderModel.findOne().lean()));
  app.get('/ui/:asset',(req,res)=>res.sendFile(path.join(folder,req.params.asset)));
  for(const route of ['/project-form','/package-manager','/client-agreement'])app.get(route,(req,res)=>res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px sans-serif;max-width:1000px;margin:20px auto;padding:16px}input,select,textarea{box-sizing:border-box;max-width:100%;padding:8px}label{display:block;margin:8px 0}fieldset{min-width:0}button{padding:10px;margin:8px}p,li{overflow-wrap:anywhere}</style></head><body><main id="app"></main><script src="/ui/${route==='/package-manager'?'manager':'project'}.js"></script></body></html>`));
  let browser;
  try {
    browser=await chromium.launch({headless:true});const context=await browser.newContext();
    await context.addCookies([{name:'token',value:cookie(admin).slice(6),url:base}]);
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error('Fixture browser error:',error.message);});
    await page.goto(base+'/package-manager');await page.getByRole('button',{name:'New package +',exact:true}).click();
    await page.getByLabel('Package name',{exact:true}).fill('Browser Package');await page.getByLabel('Permanent ID',{exact:true}).fill('browser-package');
    await page.getByLabel('Description',{exact:true}).fill('Editable starter example');await page.getByLabel('Included work (one item per line)',{exact:true}).fill('One-page business website');
    await page.getByLabel('Main price (₹)',{exact:true}).fill('10000');await page.getByLabel('Discounted price (₹)',{exact:true}).fill('10000');await page.getByLabel('Linked offer',{exact:true}).selectOption('page');await page.getByLabel('Status',{exact:true}).selectOption('published');
    await page.getByRole('button',{name:'Save package',exact:true}).click();await page.getByText('Package saved. Existing client agreements stay unchanged.',{exact:true}).waitFor();
    await page.reload();await page.getByRole('heading',{name:'Browser Package',exact:true}).waitFor();
    await page.goto(base+'/project-form');
    // Create from Package: choosing the package sets its category (Projects & Plans tab, 12 Nov 2026).
    await page.getByLabel('Package',{exact:true}).selectOption('browser-package');
    // The category's starting node comes from the SSOT and prefills the form.
    await page.waitForFunction(()=>document.querySelector(`input[placeholder="Defaults to 'Project Started'"]`)?.value==='Fixture kickoff');
    const selling=page.locator('input[placeholder="e.g. 12000"]');await page.waitForFunction(()=>document.querySelector('input[placeholder="e.g. 12000"]')?.value==='699');
    assert.equal(await selling.getAttribute('readonly'),null);
    await selling.fill('1200');await page.getByLabel('Adjustment label',{exact:true}).fill('Extra custom work');
    await page.getByText('Price adjustment: +₹501 (calculated ₹699)',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Next: Payment Settings',exact:true}).click();await page.getByRole('button',{name:'Just Add Project, Let Client Pay the Bill',exact:true}).click();
    await page.locator('button[type="submit"]').click();await page.waitForFunction(()=>document.body.dataset.created==='true');
    assert.equal(await orderModel.countDocuments(),1);assert.equal(await orderModel.countDocuments({isServicePlan:true}),0);
    await page.goto(base+'/client-agreement');await page.getByRole('heading',{name:'Browser Package',exact:true}).waitFor();await page.getByText('Offer applied: Business Growth Starter',{exact:true}).waitFor();await page.getByText('Extra custom work',{exact:true}).waitFor();await page.getByText('₹1,200',{exact:true}).waitFor();
    for(const width of [390,1440]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(folder,`client-${width}.png`),fullPage:true});}
    assert.deepEqual(errors,[]);console.log('Sales browser evidence: '+folder);
  } finally {if(browser)await browser.close();}
});


test('package related-plan references do not purchase a service; extras and discounts reconcile', async () => {
  const Product = require('../models/productModel');
  const plan = await Product.create({ serviceName: 'Related Service', category: 'service_plan', isServicePlan: true, isHidden: false, sellingPrice: 1000, servicePlan: { purchaseType: 'one_time' } });
  const feature = await Product.create({ serviceName: 'Extra Design', category: 'feature_upgrades', isHidden: false, sellingPrice: 100.5, compatibleWith: ['standard_websites'], isQuantityBased: true });
  let catalog = await api('/admin/sales-packages', null, 'GET');
  let starter = catalog.data.packages[0];
  assert.equal((await api('/admin/sales-packages', { item: { ...starter, linkedPlanIds: [String(plan._id)] }, creating: false }, 'PATCH')).status, 200);
  catalog = await api('/admin/sales-packages', null, 'GET'); starter = catalog.data.packages[0];
  const created = await create({ sellingPrice: 850, packageId: starter.id, packageQuoteKey: starter.quoteKey, featureIds: [String(feature._id)], featureQuantities: { [String(feature._id)]: 2 }, priceAdjustment: -50, adjustmentLabel: 'Sample client discount' });
  assert.equal(created.status, 201, created.message);
  const order = await orderModel.findById(created.data._id).lean();
  assert.equal(order.projectSnapshot.salesAgreement.extrasTotal, 201);
  assert.deepEqual(order.projectSnapshot.salesAgreement.package.linkedPlanIds, [String(plan._id)]);
  assert.equal(await orderModel.countDocuments({ isServicePlan: true }), 0);
  const invoice = await invoiceModel.findOne({ orderId: order._id, invoiceType: 'project' }).lean();
  assert.equal(invoice.lineItems.reduce((sum, item) => sum + item.price, 0), 850);
  assert.equal((await create({ sellingPrice: 699, packageId: starter.id, packageQuoteKey: starter.quoteKey, featureIds: [String(feature._id)], featureQuantities: { [String(feature._id)]: -1 } })).status, 400);
});

// Opt-in: the real website Offers editor against this backend — package ticks are the package's offerSlug.
if (process.env.TEST_SALES_BROWSER === '1') test('offer editor package ticks and the package editor show one shared link', { timeout: 120000 }, async () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const { build } = require('../../merasoftware/node_modules/esbuild');
  const { chromium } = require('../../merasoftware/node_modules/playwright');
  const website = path.resolve(__dirname, '../../merasoftware');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mera-offer-links-browser-'));
  const nextStubs = { name: 'next-stubs', setup(b) {
    b.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'next-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'next-stub' }, args => ({ resolveDir: website, loader: 'jsx', contents: args.path === 'next/link'
      ? `import React from 'react';export default function Link({ href, prefetch, ...props }) { return <a href={String(href)} {...props} />; }`
      : `export const useRouter=()=>({replace(){},push(){},refresh(){},prefetch(){}});export const usePathname=()=>'/admin/offers';export const useSearchParams=()=>new URLSearchParams();` }));
  } };
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{OffersManager}from'@/app/admin/offers/offers-manager';import{DEFAULT_OFFER}from'@/lib/offers';
    const offers=${JSON.stringify(LIVE_OFFERS.map(({ resolvedTerms, quoteKey, ...offer }) => offer))}.map(offer=>({...DEFAULT_OFFER,...offer}));
    createRoot(document.getElementById('app')).render(<OffersManager initialOffers={offers} initialTerms={[]} initialListing={{title:'Offers',emptyMessage:'None'}} section="settings" initialOfferSlug="diwali" />);`;
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: website }, bundle: true, outfile: path.join(folder, 'offers.js'), platform: 'browser', jsx: 'automatic', loader: { '.css': 'local-css' }, tsconfig: path.join(website, 'tsconfig.json'), plugins: [nextStubs], define: { 'process.env.NODE_ENV': '"production"' } });
  const proxy = (target, method) => async (req, res) => { const result = await nativeFetch(base + target, { method, headers: { Cookie: cookie(admin), 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(req.body) }) }); const body = await result.json(); res.status(result.status).json(result.ok ? body.data : { error: body.message }); };
  app.get('/api/time', (req, res) => res.json({ now: Date.now() }));
  app.get('/api/packages', proxy('/admin/sales-packages', 'GET'));
  app.patch('/api/packages/offer-links', proxy('/admin/sales-packages/offer-links', 'PATCH'));
  app.patch('/api/offers', (req, res) => res.json(req.body.offer)); // the website's own offer store is out of scope here
  app.get('/ui-offers/:asset', (req, res) => res.sendFile(path.join(folder, req.params.asset)));
  app.get('/offers-editor', (req, res) => res.send('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui-offers/offers.css"><style>body{font:16px sans-serif;max-width:1000px;margin:20px auto;padding:16px}label{display:block;margin:8px 0}</style></head><body><main id="app"></main><script src="/ui-offers/offers.js"></script></body></html>'));
  const offerOf = async id => (await require('../models/salesCatalogueModel').findById('packages').lean()).packages[id].offerSlug;
  const box = name => page.getByRole('checkbox', { name: new RegExp(`^\\s*${name}( \\(.*\\))?$`) });
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/offers-editor');
    await page.getByText('Business Starter (now on Business Growth Starter)', { exact: false }).first().waitFor();
    const saveButton = page.getByRole('button', { name: 'Save & publish', exact: true });
    assert.equal(await saveButton.isDisabled(), true, 'opening the offer is not an unsaved change');
    // Offer side: tick moves the package from the other offer.
    await box('Business Starter').check();
    await page.getByText('(moves here from Business Growth Starter on save)', { exact: false }).waitFor();
    await saveButton.click(); await page.getByText('Saved.', { exact: true }).waitFor();
    assert.equal(await offerOf('starter'), 'diwali');
    assert.equal(await box('Business Starter').isChecked(), true);
    assert.equal(await saveButton.isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 900 }); await page.screenshot({ path: path.join(folder, 'offer-links-390.png'), fullPage: true });
    // Untick clears only this offer.
    await box('Business Starter').uncheck(); await saveButton.click(); await page.getByText('Saved.', { exact: true }).waitFor();
    assert.equal(await offerOf('starter'), ''); assert.equal(await offerOf('starter-plus'), 'page');
    // Package side: saving a package with this offer shows it ticked in the offer editor.
    const plus = (await api('/admin/sales-packages', null, 'GET')).data.packages.find(row => row.id === 'starter-plus');
    assert.equal((await api('/admin/sales-packages', { item: { ...plus, offerSlug: 'diwali' }, creating: false }, 'PATCH')).status, 200);
    await page.reload(); await box('Business Starter Plus').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('label')].some(label => /^\s*Business Starter Plus$/.test(label.textContent) && label.querySelector('input').checked));
    assert.deepEqual(errors, []); console.log('Offer links browser evidence: ' + folder);
  } finally { if (browser) await browser.close(); }
});

// ── Back-dated start and the ended-offer override (Projects & Plans form, owner decisions 12 Nov 2026) ──
const DAY_MS = 24 * 60 * 60 * 1000;
const sameTime = (a, b, label) => assert.equal(new Date(a).getTime(), new Date(b).getTime(), label);

test('back-dated custom project: order, first step, invoice, payment and client mail carry the chosen date', async () => {
  const startedAt = new Date(Date.now() - 20 * DAY_MS);
  const created = await create({ sellingPrice: 8000, paymentType: 'full', billingDate: startedAt.toISOString(),
    recordPayment: { paymentMethod: 'upi', transactionReference: '412345678909' } });
  assert.equal(created.status, 201, created.message);
  const order = await orderModel.findById(created.data._id).lean();
  sameTime(order.createdAt, startedAt, 'order.createdAt');
  sameTime(order.projectNodes?.[0]?.createdAt ?? order.projectTimeline?.nodes?.[0]?.createdAt ?? order.projectRuns?.[0]?.startedAt, startedAt, 'first timeline step');
  assert.equal(order.orderVisibility, 'approved');
  const invoice = await invoiceModel.findOne({ orderId: order._id, invoiceType: 'project' }).lean();
  sameTime(invoice.invoiceDate, startedAt, 'invoiceDate'); sameTime(invoice.dueDate, startedAt, 'dueDate'); sameTime(invoice.paidDate, startedAt, 'paidDate');
  const payment = await transactionModel.findOne({ orderId: order._id, type: 'payment' }).lean();
  sameTime(payment.date, startedAt, 'payment date');
  assert.ok(Date.now() - new Date(payment.verificationDate).getTime() < 60000, 'verification stays the real recording time');
  const draft = await EmailDraft.findById(created.emailDraftIds[0]).lean();
  const shown = startedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  assert.ok(draft.text.includes(shown.split(' ')[0]) && draft.text.includes(shown.split(' ')[1]), `mail shows the start date (${shown}): ${draft.text}`);
});

test('start date: future refused, a typo year refused, today is not back-dated, a reservation cannot be back-dated', async () => {
  assert.equal((await create({ sellingPrice: 8000, paymentType: 'full', billingDate: new Date(Date.now() + DAY_MS).toISOString() })).status, 400);
  assert.equal((await create({ sellingPrice: 8000, paymentType: 'full', billingDate: '0202-01-01T00:00:00.000Z' })).status, 400);
  assert.equal((await create({ sellingPrice: 8000, paymentType: 'full', billingDate: 'not a date' })).status, 400);
  const today = await create({ sellingPrice: 8000, paymentType: 'full', billingDate: new Date().toISOString() });
  assert.equal(today.status, 201, today.message);
  const order = await orderModel.findById(today.data._id).lean();
  assert.ok(Date.now() - new Date(order.createdAt).getTime() < 60000);
  const reserved = await create({ sellingPrice: 699, paymentType: 'full', billingDate: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    packageId: 'starter', packageQuoteKey: 'x', offerSlug: 'page', offerReservationId: new mongoose.Types.ObjectId().toString() });
  assert.equal(reserved.status, 400);
  assert.match(reserved.message, /reserved offer/i);
});

test('ended offer: the package price stays regular until the admin applies its own ended offer, with a reason', async () => {
  app.patch('/admin/sales-packages/quote', authToken, require('../controller/order/salesPackagesController').adminQuote);
  const page = LIVE_OFFERS.find(offer => offer.slug === 'page');
  const liveEnd = page.endsAt;
  page.endsAt = new Date(Date.now() - 3 * DAY_MS).toISOString();
  try {
    const catalog = await api('/admin/sales-packages', null, 'GET');
    const starter = catalog.data.packages.find(item => item.id === 'starter');
    assert.equal(starter.quote.offer, null, 'an ended offer no longer prices the package');
    assert.equal(starter.quote.finalPrice, 10000);
    assert.ok(catalog.data.offers.some(offer => offer.slug === 'page'), 'the admin list still has the ended offer');
    // Without the override the regular price is the only one accepted.
    assert.equal((await create({ sellingPrice: 699, paymentType: 'full', packageId: 'starter', packageQuoteKey: starter.quoteKey })).status, 409);
    // The override needs a reason, and only the package's own offer.
    const quoted = await api('/admin/sales-packages/quote', { packageId: 'starter', endedOfferSlug: 'page' }, 'PATCH');
    assert.equal(quoted.status, 200, quoted.message);
    assert.equal(quoted.data.packageQuote.quote.finalPrice, 699);
    assert.equal(quoted.data.packageQuote.quote.offer.slug, 'page');
    const body = { sellingPrice: 699, paymentType: 'full', packageId: 'starter', packageQuoteKey: quoted.data.packageQuote.quoteKey, offerSlug: 'page', endedOfferSlug: 'page' };
    assert.equal((await create(body)).status, 400, 'reason required');
    assert.equal((await create({ ...body, endedOfferSlug: 'diwali', endedOfferReason: 'x' })).status, 409, 'not the package offer');
    const made = await create({ ...body, endedOfferReason: 'Client paid during the offer; added late' });
    assert.equal(made.status, 201, made.message);
    const order = await orderModel.findById(made.data._id).lean();
    const agreement = order.projectSnapshot.salesAgreement;
    assert.equal(agreement.finalPrice, 699);
    assert.equal(agreement.offer.slug, 'page');
    assert.equal(agreement.offer.appliedAfterEnd.reason, 'Client paid during the offer; added late');
    assert.equal(agreement.offer.appliedAfterEnd.by, String(admin._id));
    assert.equal(order.offerReservationId ?? null, null, 'no reservation row for an ended offer');
  } finally { page.endsAt = liveEnd; }
  // While the offer is live there is nothing to override.
  assert.equal((await api('/admin/sales-packages/quote', { packageId: 'starter', endedOfferSlug: 'page' }, 'PATCH')).status, 409);
});

test('back-dated monthly package: the plan, its first cycle and payment start on the date; an ended cycle bills the next', async () => {
  const { savePackage } = require('../helpers/salesPackages');
  app.patch('/admin/sales-packages/quote', authToken, require('../controller/order/salesPackagesController').adminQuote);
  const care = await savePackage({ name: 'Monthly Care', description: 'Care', status: 'published', category: 'standard_websites', billing: 'monthly', portalUploads: true,
    regularPrice: 1500, discountedPrice: 1000, offerExtraPrice: 0, offerSlug: '', inclusions: ['Care'], terms: [], linkedPlanIds: [], order: 9, pages: [], id: '',
    monthly: { billingOptions: [{ billingCycle: 'monthly', discountPercent: 0 }], maxTenureMonths: 12, uploadsPerMonth: 2 } }, true, []);
  const choice = { billingCycle: 'monthly', tenureMonths: 6 };
  const quoted = await api('/admin/sales-packages/quote', { packageId: care.id, choice }, 'PATCH');
  assert.equal(quoted.status, 200, quoted.message);
  const startedAt = new Date(Date.now() - 40 * DAY_MS);
  const made = await create({ sellingPrice: quoted.data.quote.finalPrice, paymentType: 'monthly', monthlyChoice: choice, packageId: care.id,
    packageQuoteKey: quoted.data.packageQuote.quoteKey, billingDate: startedAt.toISOString(), recordPayment: { paymentMethod: 'upi', transactionReference: '412345678908' } });
  assert.equal(made.status, 201, made.message);
  const plan = await orderModel.findById(made.data._id).lean();
  assert.equal(plan.isServicePlan, true);
  assert.equal(made.emailStatus, 'awaiting-review');
  assert.equal(made.emailDraftIds.length, 1);
  const startDraft = await EmailDraft.findById(made.emailDraftIds[0]).lean();
  assert.equal(startDraft.event, 'plan.started');
  assert.equal(startDraft.values.packagePrice, '₹1,000');
  assert.equal(startDraft.values.packageDuration, '6 months');
  const decision = await require('../helpers/emailController').decide(String(startDraft._id), admin._id, { choice: 'skip' }, { application: 'portal', portalAdmin: true });
  assert.equal(decision.status, 'skipped');
  sameTime(plan.createdAt, startedAt, 'plan createdAt'); sameTime(plan.servicePlanStartDate, startedAt, 'plan start');
  sameTime(plan.serviceCurrentCycleStart, startedAt, 'cycle 1 start');
  assert.ok(new Date(plan.serviceCurrentCycleEnd) < new Date(), 'cycle 1 (one month) has already ended');
  assert.equal(plan.servicePlanStatus, 'active');
  const invoice = await invoiceModel.findOne({ orderId: plan._id, serviceCycleNumber: 1 }).lean();
  sameTime(invoice.invoiceDate, startedAt, 'cycle 1 invoice'); sameTime(invoice.paidDate, startedAt, 'cycle 1 paid');
  // The renewal run bills cycle 2 and pauses the plan until it is paid (the form warns about this).
  await require('../cron/servicePlanRenewalCron').processServicePlanRenewals(new Date());
  const after = await orderModel.findById(plan._id).lean();
  assert.equal(after.servicePlanStatus, 'paused');
  assert.equal(await invoiceModel.countDocuments({ orderId: plan._id, invoiceType: 'plan_renewal', serviceCycleNumber: 2 }), 1);
});

test('admin-made monthly package that starts later, on payment approval: start message is reviewed; a customer-made plan stays automatic', async () => {
  const { savePackage } = require('../helpers/salesPackages');
  const { EmailHistory } = require('../models/emailControlModel');
  app.patch('/admin/sales-packages/quote', authToken, require('../controller/order/salesPackagesController').adminQuote);
  const care = await savePackage({ name: 'Monthly Care', description: 'Care', status: 'published', category: 'standard_websites', billing: 'monthly', portalUploads: true,
    regularPrice: 1500, discountedPrice: 1000, offerExtraPrice: 0, offerSlug: '', inclusions: ['Care'], terms: [], linkedPlanIds: [], order: 9, pages: [], id: '',
    monthly: { billingOptions: [{ billingCycle: 'monthly', discountPercent: 0 }], maxTenureMonths: 12, uploadsPerMonth: 2 } }, true, []);
  const choice = { billingCycle: 'monthly', tenureMonths: 6 };
  const quoted = await api('/admin/sales-packages/quote', { packageId: care.id, choice }, 'PATCH');
  assert.equal(quoted.status, 200, quoted.message);
  // The admin adds the package and lets the client pay the bill: nothing has started, nothing is staged.
  const made = await create({ sellingPrice: quoted.data.quote.finalPrice, paymentType: 'monthly', monthlyChoice: choice, packageId: care.id, packageQuoteKey: quoted.data.packageQuote.quoteKey });
  assert.equal(made.status, 201, made.message);
  assert.equal(made.emailDraftIds?.length || 0, 0, 'no start message is staged before payment');
  const plan = await orderModel.findById(made.data._id).lean();
  assert.equal(plan.serviceStartReview, true);
  assert.equal(plan.serviceStartNotifiedAt, null);
  const invoice = await invoiceModel.findOne({ orderId: plan._id, serviceCycleNumber: 1 });
  assert.notEqual(invoice.status, 'paid');
  const pay = async (transactionId) => {
    await transactionModel.create({ userId: customer._id, orderId: plan._id, invoiceId: invoice._id, transactionId, description: 'Isolated UPI payment', amount: invoice.amount,
      status: 'pending', paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice', upiTransactionId: '412345678901' });
    return api('/wallet/approve-transaction', { transactionId });
  };
  // The admin approves the client's UPI payment: the plan starts now and its message waits for Send / Don't Send.
  const approved = await pay('ADMINPLAN-APPROVE-1');
  assert.equal(approved.status, 200, approved.message);
  assert.equal(approved.emailStatus, 'awaiting-review');
  assert.equal(approved.emailDraftIds.length, 1);
  const draft = await EmailDraft.findById(approved.emailDraftIds[0]).lean();
  assert.equal(draft.event, 'plan.started');
  assert.equal(draft.values.packagePrice, '₹1,000');
  const started = await orderModel.findById(plan._id).lean();
  assert.equal(started.servicePlanStatus, 'active');
  assert.ok(started.serviceStartNotifiedAt, 'the start is claimed once');
  assert.equal((await require('../helpers/emailController').decide(String(draft._id), admin._id, { choice: 'skip' }, { application: 'portal', portalAdmin: true })).status, 'skipped');
  assert.equal(await EmailHistory.countDocuments({ dedupeKey: `plan-started:${plan._id}` }), 0, 'Don\'t Send sends nothing and nothing automatic follows');
  // The same flag-less order (a client's own purchase) is untouched by this change: no review, the old automatic path claims the start.
  await orderModel.updateOne({ _id: plan._id }, { $set: { serviceStartReview: false, serviceStartNotifiedAt: null, servicePlanStatus: 'active' } });
  await invoiceModel.updateOne({ _id: invoice._id }, { $set: { status: 'unpaid', amountPaid: 0, paidDate: null } });
  const automatic = await pay('ADMINPLAN-APPROVE-2');
  assert.equal(automatic.status, 200, automatic.message);
  assert.notEqual(automatic.emailStatus, 'awaiting-review');
  assert.equal(automatic.emailDraftIds?.length || 0, 0);
  for (let i = 0; i < 40 && !(await orderModel.findById(plan._id).lean()).serviceStartNotifiedAt; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok((await orderModel.findById(plan._id).lean()).serviceStartNotifiedAt, 'automatic start claimed by the existing path');
});
