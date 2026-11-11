// A one-time package is priced from its category and add-on services (owner decision 10 Nov 2026): the same
// catalogue a custom project uses, frozen when the package is saved. Isolated MongoDB; nothing live is touched.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Catalogue = require('../models/salesCatalogueModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Category = require('../models/categoryBasePriceModel');
const Product = require('../models/productModel');
const { savePackage, readPackages, quotePackage, quotePackageChoice, validatePackage } = require('../helpers/salesPackages');
const createProject = require('../controller/order/adminCreateProjectOrder');
const { adminRead, integrationRead } = require('../controller/order/salesPackagesController');

const PURCHASE = { billing: 'one_time', portalUploads: true, paymentOptions: ['full'] };
const base = { name: 'Business Starter', description: 'A business website.', status: 'published', category: 'standard_websites', ...PURCHASE,
  offerExtraPrice: 0, offerSlug: '', inclusions: ['Website'], terms: [], linkedPlanIds: [], order: 0, pages: [] };
let database, admin, customer, seo, pages, hidden, otherCategory;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Catalogue, Order, Invoice, Category, Product].map(model => model.init()));
  Object.assign(process.env, { PORTFOLIO_WEBSITE_URL: 'https://website.example.test', PORTFOLIO_INTEGRATION_SECRET: 'isolated-test-secret-32-characters-long', RESEND_API_KEY: 'isolated-test', FROM_EMAIL: 'sender@example.test' });
  global.fetch = async url => {
    if (String(url).includes('/api/offers/live')) return { ok: true, json: async () => ({ offers: [], catalogueOffers: [], packagePages: [] }) };
    if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'provider-1' }) };
    throw new Error(`Unexpected external request ${url}`);
  };
});
after(async () => { global.fetch = realFetch; await mongoose.disconnect(); await database.stop(); });
const feature = fields => Product.create({ category: 'feature_upgrades', compatibleWith: [], isHidden: false, ...fields });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [customer, admin] = await User.create([
    { name: 'Client', email: 'client@example.test', roles: ['customer'], phone: '+919876500002' },
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
  ]);
  await Category.create([{ category: 'standard_websites', basePrice: 10000 }, { category: 'dynamic_websites', basePrice: 20000 }, { category: 'unpriced_one', label: 'Unpriced', basePrice: null }]);
  seo = await feature({ serviceName: 'SEO setup', price: 3000, sellingPrice: 3000 });
  pages = await feature({ serviceName: 'Extra page', price: 500, sellingPrice: 500, isQuantityBased: true });
  hidden = await feature({ serviceName: 'Hidden add-on', price: 100, sellingPrice: 100, isHidden: true });
  otherCategory = await feature({ serviceName: 'Dynamic only', price: 700, sellingPrice: 700, compatibleWith: ['dynamic_websites'] });
});
const sel = (...rows) => rows.map(([feature, quantity = 1]) => ({ featureId: String(feature._id), quantity }));
const make = (fields = {}) => { const regularPrice = fields.regularPrice ?? 13000; return savePackage({ ...base, id: '', regularPrice, discountedPrice: Math.min(12000, regularPrice), services: sel([seo]), ...fields }, true, []); };

test('main price = category base + chosen add-ons, read here; the services are frozen in `pricing`', async () => {
  const saved = await make();
  assert.equal(saved.regularPrice, 13000);
  assert.deepEqual(saved.pricing, { categoryBasePrice: 10000, categoryTerms: [], services: [{ featureId: String(seo._id), name: 'SEO setup', unitPrice: 3000, isQuantityBased: false, quantity: 1, terms: [] }] });
  assert.equal('services' in saved, false, 'the request field is not stored');
  const many = await make({ name: 'Second', regularPrice: 10000 + 3000 + 1500, services: sel([seo], [pages, 3]) });
  assert.equal(many.pricing.services[1].quantity, 3);
  const none = await make({ name: 'Base only', regularPrice: 10000, discountedPrice: 10000, services: [] });
  assert.deepEqual(none.pricing, { categoryBasePrice: 10000, categoryTerms: [], services: [] });
});

test('the included work shows the saved number of each quantity add-on: "4 × name"; other lines stay as written', async () => {
  // A package saved before numbers existed: bare names. Publishing it again, with nothing changed, adds the number.
  const old = await make({ name: 'Old', regularPrice: 15000, inclusions: ['SEO setup', 'Extra page', 'Website Update'], services: sel([seo], [pages, 4]) });
  assert.deepEqual(old.inclusions, ['SEO setup', '4 × Extra page', 'Website Update']);
  const again = await savePackage({ ...base, id: old.id, regularPrice: 15000, discountedPrice: 12000, inclusions: ['SEO setup', 'Extra page', 'Website Update'], services: sel([seo], [pages, 4]) }, false, []);
  assert.deepEqual(again.inclusions, ['SEO setup', '4 × Extra page', 'Website Update']);
  // A new quantity replaces an older number; a line written differently and a non-quantity add-on stay as they are.
  const changed = await savePackage({ ...base, id: old.id, regularPrice: 13500, discountedPrice: 12000, inclusions: ['SEO setup', '4 × Extra page', 'Extra pages within 20km'], services: sel([seo], [pages, 1]) }, false, []);
  assert.deepEqual(changed.inclusions, ['SEO setup', '1 × Extra page', 'Extra pages within 20km']);
  // The price and the frozen services (what invoices read) are unchanged by this.
  assert.deepEqual(changed.pricing.services.map(row => [row.name, row.quantity, row.unitPrice]), [['SEO setup', 1, 3000], ['Extra page', 1, 500]]);
  // A package with a typed price has no services: its lines are never touched.
  const typed = await savePackage({ ...base, id: '', name: 'Typed', regularPrice: 9000, discountedPrice: 9000, inclusions: ['Extra page'] }, true, []);
  assert.deepEqual(typed.inclusions, ['Extra page']);
});

test('add-on and category terms are merged into the package terms automatically; the admin lines stay', async () => {
  await Category.updateOne({ category: 'standard_websites' }, { terms: ['Category term A', 'Category term B'] });
  await Product.updateOne({ _id: seo._id }, { terms: ['SEO term 1', 'SEO term 2'] });
  const saved = await make({ terms: ['Admin line'] });
  assert.deepEqual(saved.terms, ['Admin line', 'Category term A', 'Category term B', 'SEO term 1', 'SEO term 2']);
  assert.deepEqual(saved.pricing.categoryTerms, ['Category term A', 'Category term B']);
  // A saved service keeps the terms it was saved with, even if the add-on's terms change later.
  await Product.updateOne({ _id: seo._id }, { terms: ['SEO term changed'] });
  const resaved = await savePackage({ ...base, id: saved.id, regularPrice: 13000, discountedPrice: 12000, services: sel([seo]), terms: saved.terms }, false, []);
  assert.deepEqual(resaved.terms, ['Admin line', 'Category term A', 'Category term B', 'SEO term 1', 'SEO term 2']);
  // Untick the add-on: the form sends only the admin's own lines, and the add-on's automatic lines are gone.
  const unticked = await savePackage({ ...base, id: saved.id, regularPrice: 10000, discountedPrice: 10000, services: [], terms: ['Admin line'] }, false, []);
  assert.deepEqual(unticked.terms, ['Admin line', 'Category term A', 'Category term B']);
  await assert.rejects(make({ terms: Array.from({ length: 49 }, (_, i) => `Line ${i}`) }), /more than 50 lines/);
});

test('the price the form shows must match; a client-sent pricing is ignored', async () => {
  await assert.rejects(make({ regularPrice: 12999 }), error => error.statusCode === 409 && /main price changed/i.test(error.message));
  const forged = await make({ pricing: { categoryBasePrice: 1, services: [] } });
  assert.equal(forged.pricing.categoryBasePrice, 10000);
});

test('refused: unpriced category, hidden or other-category add-on, unknown, duplicate, bad quantity', async () => {
  await assert.rejects(make({ category: 'unpriced_one', regularPrice: 3000, discountedPrice: 3000 }), /no base price/);
  await assert.rejects(make({ services: sel([hidden]), regularPrice: 10100 }), /unavailable/);
  await assert.rejects(make({ services: sel([otherCategory]), regularPrice: 10700 }), /unavailable/);
  await assert.rejects(make({ services: [{ featureId: String(new mongoose.Types.ObjectId()), quantity: 1 }] }), /unavailable/);
  await assert.rejects(make({ services: sel([seo], [seo]) }), /twice/);
  await assert.rejects(make({ services: [{ featureId: String(pages._id), quantity: 0 }], regularPrice: 10000 }), /1 and 1000|between 1/);
  await assert.rejects(make({ services: [{ featureId: 'nope', quantity: 1 }] }), /valid add-on/);
});

// Owner decision 11 Nov 2026 (src/docs/monthlypackage.md): a monthly package may be priced from its category and
// add-ons too; that price is the price of one month, and every cycle (with its discount) is worked out from it.
test('a monthly package priced from its category and add-ons: the parts make the monthly price', async () => {
  const MONTHLY = { billing: 'monthly', paymentOptions: undefined, monthly: { billingOptions: [{ billingCycle: 'quarterly', discountPercent: 10 }], maxTenureMonths: 12, uploadsPerMonth: 2 } };
  const saved = await make({ ...MONTHLY, name: 'Monthly parts' });
  assert.deepEqual([saved.regularPrice, saved.pricing.categoryBasePrice, saved.billing], [13000, 10000, 'monthly']);
  const quarter = quotePackageChoice(saved, [], { billingCycle: 'quarterly', tenureMonths: 6 });
  // Normal price 12,000 a month: a quarter is 36,000 less 10% = 32,400, two quarters in six months.
  assert.deepEqual([quarter.monthly.perMonthPrice, quarter.monthly.cyclePrice, quarter.finalPrice], [12000, 32400, 64800]);
});

test('a non-quantity add-on counts once whatever quantity is sent (as the custom project form)', async () => {
  const saved = await make({ services: [{ featureId: String(seo._id), quantity: 5 }] });
  assert.equal(saved.regularPrice, 13000);
  assert.equal(saved.pricing.services[0].quantity, 1);
});

test('a saved package is not touched by later price changes; a new add-on takes the current price', async () => {
  const saved = await make({ services: sel([seo], [pages, 2]), regularPrice: 14000 });
  await Category.updateOne({ category: 'standard_websites' }, { basePrice: 99999 });
  await Product.updateOne({ _id: seo._id }, { price: 7000, sellingPrice: 7000 });
  await Product.updateOne({ _id: pages._id }, { price: 900, sellingPrice: 900 });
  // The same package saved again with the same services keeps every frozen price.
  const again = await savePackage({ ...base, id: saved.id, regularPrice: 14000, discountedPrice: 12000, services: sel([seo], [pages, 2]) }, false, []);
  assert.equal(again.regularPrice, 14000);
  // The quantity of a frozen add-on may change; its unit price stays.
  const more = await savePackage({ ...base, id: saved.id, regularPrice: 10000 + 3000 + 1500, discountedPrice: 12000, services: sel([seo], [pages, 3]) }, false, []);
  assert.equal(more.pricing.services[1].unitPrice, 500);
  // Only a new add-on takes today's catalogue price.
  const extra = await feature({ serviceName: 'Logo', price: 2000, sellingPrice: 2000 });
  const added = await savePackage({ ...base, id: saved.id, regularPrice: 10000 + 3000 + 1500 + 2000, discountedPrice: 12000, services: sel([seo], [pages, 3], [extra]) }, false, []);
  assert.equal(added.pricing.services[2].unitPrice, 2000);
  await assert.rejects(savePackage({ ...base, id: saved.id, regularPrice: 99999 + 7000, discountedPrice: 12000, services: sel([seo]) }, false, []), /main price changed/);
});

test('"update to current prices" takes every price afresh; a withdrawn add-on is named', async () => {
  const saved = await make();
  await Category.updateOne({ category: 'standard_websites' }, { basePrice: 11000 });
  await Product.updateOne({ _id: seo._id }, { price: 4000, sellingPrice: 4000 });
  const refreshed = await savePackage({ ...base, id: saved.id, regularPrice: 15000, discountedPrice: 12000, services: sel([seo]), repriceFromCurrent: true }, false, []);
  assert.equal(refreshed.pricing.categoryBasePrice, 11000);
  assert.equal(refreshed.pricing.services[0].unitPrice, 4000);
  await Product.deleteOne({ _id: seo._id });
  // Without a refresh a deleted add-on stays in the package as it was saved.
  assert.equal((await savePackage({ ...base, id: saved.id, regularPrice: 15000, discountedPrice: 12000, services: sel([seo]) }, false, [])).regularPrice, 15000);
  await assert.rejects(savePackage({ ...base, id: saved.id, regularPrice: 15000, discountedPrice: 12000, services: sel([seo]), repriceFromCurrent: true }, false, []), /SEO setup is no longer offered/);
});

test('a new category re-prices everything', async () => {
  const saved = await make();
  const moved = await savePackage({ ...base, id: saved.id, category: 'dynamic_websites', regularPrice: 20000 + 3000, discountedPrice: 12000, services: sel([seo]) }, false, []);
  assert.equal(moved.pricing.categoryBasePrice, 20000);
  const withOnly = await savePackage({ ...base, id: saved.id, category: 'dynamic_websites', regularPrice: 20000 + 700, discountedPrice: 12000, services: sel([otherCategory]) }, false, []);
  assert.equal(withOnly.regularPrice, 20700);
});

test('a saved package keeps the way its price was set: neither way switches; typed one-time and monthly packages stay typed', async () => {
  const { billing, portalUploads, paymentOptions, ...old } = base;
  await Catalogue.updateOne({ _id: 'packages' }, { $set: { 'packages.legacy': { ...old, id: 'legacy', regularPrice: 15000, discountedPrice: 9999 } } }, { upsert: true });
  const typed = await savePackage({ ...old, id: 'legacy', regularPrice: 15000, discountedPrice: 9999 }, false, []);
  assert.equal(typed.regularPrice, 15000);
  assert.equal('pricing' in typed, false);
  // A typed package cannot be switched to the category-and-add-ons price, with or without its purchase settings.
  await assert.rejects(savePackage({ ...old, ...PURCHASE, id: 'legacy', regularPrice: 13000, discountedPrice: 9999, services: sel([seo]) }, false, []), /priced by hand and keeps it/);
  await Catalogue.updateOne({ _id: 'packages' }, { $set: { 'packages.typedone': { ...base, id: 'typedone', regularPrice: 4000, discountedPrice: 3500 } } });
  await assert.rejects(savePackage({ ...base, id: 'typedone', regularPrice: 13000, discountedPrice: 9999, services: sel([seo]) }, false, []), /priced by hand and keeps it/);
  assert.equal((await savePackage({ ...base, id: 'typedone', regularPrice: 4500, discountedPrice: 3500 }, false, [])).regularPrice, 4500, 'it stays typed and can be edited');
  // The other way: a priced package cannot be turned into a typed one either (its parts would be lost unnoticed).
  const priced = await make({ name: 'Parts one' });
  await assert.rejects(savePackage({ ...base, id: priced.id, regularPrice: 13000, discountedPrice: 12000 }, false, []), /Send its services, or duplicate it/);
  // A new package takes either way (a copy of a typed one may be priced from its parts, and the reverse).
  const typedNew = await savePackage({ ...base, id: '', name: 'Typed new', regularPrice: 4000, discountedPrice: 3500 }, true, []);
  assert.equal('pricing' in typedNew, false);
  const partsNew = await savePackage({ ...base, id: '', name: 'Parts new', regularPrice: 13000, discountedPrice: 12000, services: sel([seo]) }, true, []);
  assert.equal(partsNew.pricing.services.length, 1);
  // Monthly follows the same rule: a priced package made monthly keeps its parts (they must be sent), never a typed price.
  await assert.rejects(savePackage({ ...base, id: priced.id, billing: 'monthly', paymentOptions: undefined, regularPrice: 13000, discountedPrice: 9999, monthly: { billingOptions: [{ billingCycle: 'monthly', discountPercent: 0 }], maxTenureMonths: 12 } }, false, []), /Send its services, or duplicate it/);
});

test('the quote key follows the frozen pricing, never the live catalogue; packages without it keep their key', async () => {
  const saved = await make();
  const key = quotePackage(saved, []).quoteKey;
  await Product.updateOne({ _id: seo._id }, { price: 8000, sellingPrice: 8000 });
  await Category.updateOne({ category: 'standard_websites' }, { basePrice: 50000 });
  assert.equal(quotePackage((await readPackages())[0], []).quoteKey, key);
  const typed = validatePackage({ ...base, id: 'plain', regularPrice: 1000, discountedPrice: 900 });
  assert.equal(quotePackage(typed, []).quoteKey, quotePackage({ ...typed, pricing: undefined }, []).quoteKey);
});

test('an add-on service price change does not reach a project made from the package; a custom project is priced as before', async () => {
  const saved = await make();
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  // A custom project: category base + chosen add-ons (the shared featureLines), unchanged by this work.
  const res = response();
  const projectBody = { category: 'standard_websites', projectName: 'Custom', totalPages: 5, sellingPrice: 10000 + 3000 + 1500, featureIds: [String(seo._id), String(pages._id)], featureQuantities: { [String(pages._id)]: 3 }, paymentType: 'full' };
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) }, body: projectBody }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.price, 14500);
  assert.deepEqual(res.body.data.projectSnapshot.features.map(row => [row.name, row.unitPrice, row.quantity, row.price]), [['SEO setup', 3000, 1, 3000], ['Extra page', 500, 3, 1500]]);
  assert.ok(saved.id);
});

test('a custom project carries the terms of its category and add-ons on its order (shown on the order page)', async () => {
  await Category.updateOne({ category: 'standard_websites' }, { terms: ['Category term A'] });
  await Product.updateOne({ _id: seo._id }, { terms: ['SEO term 1'] });
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const res = response();
  const projectBody = { category: 'standard_websites', projectName: 'Custom terms', totalPages: 5, sellingPrice: 13000, featureIds: [String(seo._id)], paymentType: 'full' };
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) }, body: projectBody }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.projectSnapshot.terms, ['Category term A', 'SEO term 1']);
  const stored = await Order.findById(res.body.data._id).lean();
  assert.deepEqual(stored.projectSnapshot.terms, ['Category term A', 'SEO term 1']);
});

test('adminRead gives the form the base prices, add-ons and category usage; the public read hides the frozen pricing', async () => {
  const saved = await make();
  const call = async handler => { const res = { statusCode: 200, headers: {}, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; await handler(handler === adminRead ? { userId: admin._id, userRole: 'admin' } : { get: () => `Bearer ${process.env.PORTFOLIO_INTEGRATION_SECRET}` }, res); return res; };
  const read = await call(adminRead);
  assert.equal(read.statusCode, 200, JSON.stringify(read.body));
  const standard = read.body.data.categories.find(row => row.category === 'standard_websites');
  assert.equal(standard.basePrice, 10000);
  assert.equal(standard.usage.packages, 1);
  assert.ok(read.body.data.addOns.some(row => row.name === 'Hidden add-on' && row.isHidden === true));
  assert.deepEqual(read.body.data.addOns.find(row => row.name === 'Extra page'), { id: String(pages._id), name: 'Extra page', unitPrice: 500, description: '', isHidden: false, isQuantityBased: true, compatibleWith: [], terms: [] });
  assert.ok(read.body.data.packages.find(row => row.id === saved.id).pricing, 'the admin sees the frozen pricing');
  const publicRead = await call(integrationRead);
  assert.equal(publicRead.statusCode, 200, JSON.stringify(publicRead.body));
  assert.equal(publicRead.body.data.packages.some(row => 'pricing' in row), false);
});

test('a project made from a priced package freezes its parts, and its invoice lists them even after prices change', async () => {
  const saved = await make();
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) },
    body: { category: 'standard_websites', projectName: 'From package', totalPages: 5, packageId: saved.id, packageQuoteKey: quotePackage(saved, []).quoteKey, sellingPrice: saved.discountedPrice, featureIds: [], paymentType: 'full' } }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  await Product.updateOne({ _id: seo._id }, { price: 9000, sellingPrice: 9000 });
  await Category.updateOne({ category: 'standard_websites' }, { basePrice: 50000 });
  const order = await Order.findById(res.body.data._id).lean();
  const frozen = order.projectSnapshot.salesAgreement.package.pricing;
  assert.deepEqual(frozen, saved.pricing, 'the parts the package was sold with');
  const { buildInvoiceRows } = require('../helpers/generateInvoiceDocumentPdf');
  const rows = buildInvoiceRows({ invoice: { amount: order.totalAmount }, order, targetTotal: order.totalAmount });
  assert.deepEqual(rows.map(row => [row.name, row.price]), [['Business Starter', undefined], ['Standard Website base price', 10000], ['SEO setup', 3000], ['Package discount', -1000]]);
});
