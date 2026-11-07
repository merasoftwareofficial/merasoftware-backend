// One package form (merasoftware/src/docs/package-offers.md, owner decisions 7 Nov 2026): automatic package
// IDs, the package page design, and "Start my project" on a package without an offer (helpers/packageStart.js).
// Isolated MongoDB, fake email provider, real WhatsApp queue rows; the website is never contacted.
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
const Category = require('../models/categoryBasePriceModel');
const { EmailDraft, EmailHistory, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');
const { savePackage, readPackages, quotePackage, validatePackage, packageIdBase } = require('../helpers/salesPackages');
const start = require('../helpers/packageStart');
const { byKey, channelFor } = require('../helpers/emailCatalog');
const createProject = require('../controller/order/adminCreateProjectOrder');

const DAY = 24 * 3600000;
const DESIGN = { eyebrow: 'YOUR BUSINESS, ONLINE', heading: 'Get your business', headingHighlight: 'noticed online.', supportingLine: '',
  subheading: "What's included", tagline: 'One-time package', badge: 'Most chosen', priceDescription: 'One-time payment.',
  ctaLabel: 'Enquire about this package', contactHref: 'mailto:contact@merasoftware.com' };
const item = { name: 'Business Starter', description: 'A business website.', status: 'published', category: 'standard_websites',
  regularPrice: 15000, discountedPrice: 9999, offerExtraPrice: 0, offerSlug: '', inclusions: ['Website'], terms: [], linkedPlanIds: [], order: 0, pages: [] };
let database, member, customer, admin, emails;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Lead, Catalogue, StartRequest, Order, Invoice, Category, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate, Queue].map(model => model.init()));
  Object.assign(process.env, {
    PORTFOLIO_WEBSITE_URL: 'https://website.example.test', FORNTEND_URL: 'https://portal.example.test', ADMIN_DASHBOARD_URL: 'https://portal.example.test',
    PORTFOLIO_INTEGRATION_SECRET: 'isolated-test-secret-32-characters-long', RESEND_API_KEY: 'isolated-test', FROM_EMAIL: 'sender@example.test',
    ENABLE_WHATSAPP: 'true', PACKAGE_START_REQUESTS_ENABLED: 'true',
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
    { name: 'Member', email: 'member@example.test', roles: ['member'], phone: '+919876500001' },
    { name: 'Client', email: 'client@example.test', roles: ['customer'], phone: '+919876500002' },
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
  ]);
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
  emails = 0;
  process.env.PACKAGE_START_REQUESTS_ENABLED = 'true';
});
const history = event => EmailHistory.find({ event }).lean();
const ask = (user = member, packageId = 'business-starter') => start.requestPackageStart({ userId: user._id, packageId });
async function age(ms) {
  for (const row of await StartRequest.find().lean()) await StartRequest.collection.updateOne({ _id: row._id }, { $set: { requestedAt: new Date(row.requestedAt.getTime() - ms) } });
}

// --- Automatic ID and page design --------------------------------------------------------------------------
test('a new package gets its ID from its name, the next number when taken; the ID never changes', async () => {
  assert.equal(packageIdBase('Business Starter'), 'business-starter');
  assert.equal(packageIdBase('  All-in-One  Startup!! '), 'all-in-one-startup');
  assert.equal(packageIdBase('बिज़नेस पैकेज'), 'package', 'a name without Latin letters');
  assert.equal((await savePackage({ ...item, id: '' }, true, [])).id, 'business-starter');
  assert.equal((await savePackage({ ...item }, true, [])).id, 'business-starter-2', 'missing ID = automatic too');
  assert.equal((await savePackage({ ...item, id: '', name: 'बिज़नेस' }, true, [])).id, 'package');
  const renamed = await savePackage({ ...item, id: 'business-starter', name: 'Business Starter Pro' }, false, []);
  assert.equal(renamed.id, 'business-starter', 'renaming keeps the link');
  await assert.rejects(savePackage({ ...item, id: '' }, false, []), /safe lowercase package ID/, 'editing always names its package');
  assert.deepEqual((await readPackages()).map(row => row.id).sort(), ['business-starter', 'business-starter-2', 'package']);
});
test('two new packages with the same name saved at once get different IDs', async () => {
  const saved = await Promise.all([savePackage({ ...item, id: '' }, true, []), savePackage({ ...item, id: '' }, true, [])]);
  assert.deepEqual(saved.map(row => row.id).sort(), ['business-starter', 'business-starter-2']);
});
test('the page design is checked, saved, and never changes the quote version', async () => {
  const withDesign = validatePackage({ ...item, id: 'x', design: DESIGN });
  assert.equal(withDesign.design.heading, 'Get your business');
  assert.equal(validatePackage({ ...item, id: 'x' }).design, undefined, 'packages saved before page design have none');
  assert.throws(() => validatePackage({ ...item, id: 'x', design: { ...DESIGN, heading: ' ' } }), /page design heading/);
  assert.throws(() => validatePackage({ ...item, id: 'x', design: { ...DESIGN, badge: 'x'.repeat(61) } }), /page design badge/);
  assert.throws(() => validatePackage({ ...item, id: 'x', design: { ...DESIGN, contactHref: 'http://example.com' } }), /contact link/);
  assert.throws(() => validatePackage({ ...item, id: 'x', design: { ...DESIGN, script: 'x' } }), /valid page design/);
  const plain = validatePackage({ ...item, id: 'x' });
  assert.equal(quotePackage(withDesign, []).quoteKey, quotePackage(plain, []).quoteKey, 'design is display only');
  assert.equal(quotePackage({ ...withDesign, design: { ...DESIGN, heading: 'Other' } }, []).quoteKey, quotePackage(plain, []).quoteKey);
  const saved = await savePackage({ ...item, id: '', design: DESIGN }, true, []);
  assert.deepEqual((await readPackages())[0].design, saved.design);
});

// --- Start my project on a package -----------------------------------------------------------------------------
test('switched off by its flag; only a published package; a phone is needed', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  process.env.PACKAGE_START_REQUESTS_ENABLED = 'false';
  await assert.rejects(ask(), /not enabled yet/);
  process.env.PACKAGE_START_REQUESTS_ENABLED = 'true';
  await assert.rejects(ask(member, 'missing'), /not available/);
  await savePackage({ ...item, id: '', name: 'Draft one', status: 'draft' }, true, []);
  await assert.rejects(ask(member, 'draft-one'), /not available/);
  const noPhone = await User.create({ name: 'No phone', email: 'nophone@example.test', roles: ['member'] });
  await assert.rejects(ask(noPhone), error => error.statusCode === 428);
  const result = await start.requestPackageStart({ userId: noPhone._id, packageId: 'business-starter', countryCode: '+91', phone: '9876500009' });
  assert.equal(result.requested, true);
  assert.equal((await User.findById(noPhone._id)).phone, '+919876500009');
});
test('member: one open request, lead follow-up, team and customer told once', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  const result = await ask();
  assert.equal(result.requested, true); assert.equal(result.request.status, 'requested');
  assert.equal(result.request.price, 9999); assert.equal(result.request.title, 'Business Starter');
  assert.equal((await ask()).requested, false, 'a second click returns the open request');
  assert.equal(await StartRequest.countDocuments(), 1);
  await start.deliverPackageStartNotices(); await start.deliverPackageStartNotices();
  assert.equal((await history('package.start.request.admin')).length, 1);
  const [told] = await Queue.find({ event: 'package.start.request.received' }).lean();
  assert.match(told.text, /We have received your request to start your project on Business Starter/);
  assert.match(told.text, /https:\/\/website\.example\.test\/package\/business-starter/);
  const lead = await Lead.findOne({ reservationUserId: member._id });
  assert.match(lead.followUps.at(-1).note, /Wants to start the project on the package Business Starter \(₹9,999\)/);
  assert.equal(String((await StartRequest.findOne()).leadId), String(lead._id));
  assert.equal(byKey.get('package.start.request.admin').audience, 'team');
  assert.equal(channelFor('package.start.request.received'), 'both');
});
test('an admin can switch each of the two mails Off in Communication', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  await EmailPolicy.create([{ event: 'package.start.request.admin', mode: 'off' }, { event: 'package.start.request.received', mode: 'off' }]);
  await ask();
  await start.deliverPackageStartNotices();
  assert.equal((await history('package.start.request.admin')).filter(row => ['sent', 'delivered'].includes(row.status)).length, 0);
  assert.equal((await Queue.find({ event: /package\.start/ })).length, 0);
  assert.equal(emails, 0);
});
test('client: the Won lead gets the follow-up; two clicks at once make one request', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  const both = await Promise.all([ask(customer), ask(customer)]);
  assert.equal(both.filter(row => row.requested).length, 1);
  assert.equal(await StartRequest.countDocuments(), 1);
  const lead = await Lead.findOne({ convertedToUserId: customer._id });
  assert.ok(lead, 'the client has their Won lead');
  assert.match(lead.followUps.at(-1).note, /package Business Starter/);
});
test('the team is reminded once a day, at most 3 times, until the request is closed', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  await ask(); await start.deliverPackageStartNotices();
  await start.alertPendingPackageStarts();
  assert.equal((await StartRequest.findOne()).alerts, 0, 'not before a full day');
  for (let day = 1; day <= 4; day++) { await age(DAY + 60000); await start.alertPendingPackageStarts(); }
  assert.equal((await StartRequest.findOne()).alerts, 3);
  assert.equal((await history('package.start.request.admin')).length, 4, 'the first message and 3 reminders');
  const row = await StartRequest.findOne();
  const closed = await start.closeByTeam({ requestId: row._id, actorId: admin._id });
  assert.equal(closed.request.status, 'closed');
  await assert.rejects(start.closeByTeam({ requestId: row._id, actorId: admin._id }), /already closed/);
  assert.equal((await ask()).requested, true, 'after closing, the person may ask again');
});
test('creating the project on the package closes the open request', async () => {
  const saved = await savePackage({ ...item, id: '' }, true, []);
  await ask(customer);
  const quoted = quotePackage(saved, []);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) },
    body: { category: 'standard_websites', sellingPrice: 9999, paymentType: 'full', packageId: saved.id, packageQuoteKey: quoted.quoteKey } }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body).slice(0, 300));
  const row = await StartRequest.findOne().lean();
  assert.equal(row.closedReason, 'project_created');
  assert.ok(row.projectId);
  assert.equal((await start.listPackageStarts(customer._id)).requests[0].status, 'closed');
});
