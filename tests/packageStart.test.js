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
const item = { name: 'Business Starter', description: 'A business website.', status: 'published', category: 'standard_websites', billing: 'one_time', portalUploads: true, paymentOptions: ['full'],
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
const ask = (user = member, packageId = 'business-starter') => start.requestPackageStart({ userId: user._id, packageId, choice: { paymentOption: 'full' } });
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
  const result = await start.requestPackageStart({ userId: noPhone._id, packageId: 'business-starter', choice: { paymentOption: 'full' }, countryCode: '+91', phone: '9876500009' });
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
  assert.match(told.text, /We have received your callback request for Business Starter/);
  assert.match(told.text, /Our team will call you shortly/);
  assert.match(told.text, /https:\/\/website\.example\.test\/package\/business-starter/);
  const lead = await Lead.findOne({ reservationUserId: member._id });
  assert.match(lead.followUps.at(-1).note, /Wants to start the project on the package Business Starter \(₹9,999\)/);
  assert.equal(String((await StartRequest.findOne()).leadId), String(lead._id));
  assert.equal(byKey.get('package.start.request.admin').audience, 'team');
  assert.equal(channelFor('package.start.request.received'), 'both');
});
test('a buy (Get this package) tells the team with the full choice and never tells the customer; a callback tells both', async () => {
  await savePackage({ ...item, id: '', paymentOptions: ['full', 'installments_2'] }, true, []);
  const choice = { paymentOption: 'installments_2' };
  await assert.rejects(start.requestPackageStart({ userId: member._id, packageId: 'business-starter', choice, kind: 'other' }), /Choose how you want to start/);
  const bought = await start.requestPackageStart({ userId: member._id, packageId: 'business-starter', choice, kind: 'buy' });
  assert.equal(bought.requested, true); assert.equal(bought.request.kind, 'buy');
  assert.equal((await StartRequest.findOne()).kind, 'buy');
  await start.deliverPackageStartNotices(); await start.deliverPackageStartNotices();
  assert.equal((await history('package.start.request.admin')).length, 1, 'the team is told once');
  assert.equal((await history('package.start.request.received')).length, 0, 'the customer is not told');
  assert.equal(await Queue.countDocuments({ event: 'package.start.request.received' }), 0);
  const [team] = await Queue.find({ event: 'package.start.request.admin' }).lean();
  assert.match(team.text, /A customer started a package from the website/);
  assert.match(team.text, /2 installments \(50% \+ 50%\)/);
  assert.match(team.text, /Business Starter/);
  const lead = await Lead.findOne({ reservationUserId: member._id });
  assert.match(lead.followUps.at(-1).note, /Started buying the package Business Starter/);
  // Without a kind the request is a callback, as it always was: the customer is told too.
  const called = await start.requestPackageStart({ userId: customer._id, packageId: 'business-starter', choice });
  assert.equal(called.request.kind, 'callback');
  await start.deliverPackageStartNotices();
  assert.equal((await history('package.start.request.received')).length, 1);
  const [callTeam] = (await Queue.find({ event: 'package.start.request.admin' }).lean()).slice(-1);
  assert.match(callTeam.text, /A customer wants to start their project on a package/);
  // The customer's "project created" mail goes by WhatsApp unless an admin changes Send via; the team's by both.
  assert.equal(channelFor('package.purchase.received'), 'whatsapp');
  assert.equal(byKey.get('package.purchase.received').trigger, 'system');
  assert.equal(byKey.get('package.purchase.received').audience, 'customer');
  // The daily reminder reaches the team for a buy as well.
  await age(DAY + 60000); await start.alertPendingPackageStarts();
  assert.equal((await history('package.start.request.admin')).length, 4, '2 first messages and 2 reminders');
});
const askAs = (user, kind, packageId = 'business-starter') => start.requestPackageStart({ userId: user._id, packageId, kind, choice: { paymentOption: 'full' } });
test('a callback asked for while a buy is open replaces it: the team and the customer are told, reminders start again', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  const bought = await askAs(member, 'buy');
  await start.deliverPackageStartNotices();
  assert.equal((await history('package.start.request.received')).length, 0);
  const called = await askAs(member, 'callback');
  assert.equal(called.requested, true); assert.equal(called.request.kind, 'callback');
  assert.notEqual(called.request.id, bought.request.id, 'a new request');
  const old = await StartRequest.findById(bought.request.id).lean();
  assert.equal(old.closedReason, 'callback_requested'); assert.ok(old.closedAt);
  assert.equal(await StartRequest.countDocuments({ closedAt: null }), 1, 'one open request');
  await start.deliverPackageStartNotices();
  assert.equal((await history('package.start.request.admin')).length, 2, 'the buy message and the callback message');
  assert.equal((await history('package.start.request.received')).length, 1, 'the customer is told once, for the callback');
  const lead = await Lead.findOne({ reservationUserId: member._id });
  assert.match(lead.followUps.at(-1).note, /Wants to start the project on the package Business Starter/);
  // The new request has its own clock: no reminder before a full day after the callback.
  await start.alertPendingPackageStarts();
  assert.equal((await StartRequest.findById(called.request.id)).alerts, 0);
});
test('a buy asked for while a callback is open changes nothing; a repeated callback changes nothing', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  const called = await askAs(member, 'callback');
  await start.deliverPackageStartNotices();
  const again = await askAs(member, 'buy');
  assert.equal(again.requested, false); assert.equal(again.request.id, called.request.id); assert.equal(again.request.kind, 'callback');
  assert.equal((await askAs(member, 'callback')).requested, false);
  await start.deliverPackageStartNotices();
  assert.equal(await StartRequest.countDocuments(), 1);
  assert.equal((await history('package.start.request.admin')).length, 1);
  assert.equal((await history('package.start.request.received')).length, 1);
});
test('a buy and a callback at the same moment end as one open callback, told once', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  await Promise.all([askAs(customer, 'buy'), askAs(customer, 'callback')]);
  const open = await StartRequest.find({ closedAt: null }).lean();
  assert.equal(open.length, 1); assert.equal(open[0].kind, 'callback');
  await start.deliverPackageStartNotices();
  assert.equal((await history('package.start.request.received')).length, 1);
});
test('the customer hears once; every reminder goes to the team only', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  await askAs(customer, 'callback'); await start.deliverPackageStartNotices();
  for (let day = 1; day <= 5; day++) { await age(DAY + 60000); await start.alertPendingPackageStarts(); }
  const mine = '919876500002';
  const toCustomer = await Queue.find({ to: mine, event: /package\.start/ }).lean();
  assert.deepEqual(toCustomer.map(row => row.event), ['package.start.request.received'], 'one WhatsApp, no reminders');
  const sent = await history('package.start.request.received');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['client@example.test']);
  const reminders = (await history('package.start.request.admin')).filter(row => /package-start-pending/.test(row.dedupeKey));
  assert.equal(reminders.length, 3, 'at most 3 reminders');
  assert.ok(reminders.every(row => !row.to.includes('client@example.test')), 'to the team, never the customer');
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

// --- A callback from the package or offer page carries no choice (owner decision 10 Nov 2026) ---------------------
// The page's "Arrange a callback" sends only the package: the customer has chosen nothing yet. Only a buy needs the choice.
const callbackOnly = (user, packageId = 'business-starter') => start.requestPackageStart({ userId: user._id, packageId, kind: 'callback' });
test('a callback without a choice is recorded and tells the team and the customer, on a package with purchase settings', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  const called = await callbackOnly(member);
  assert.equal(called.requested, true); assert.equal(called.request.kind, 'callback');
  assert.equal(called.request.price, 9999, 'the package price without an offer');
  assert.equal(called.request.choice, null); assert.equal(called.request.quote, null);
  await start.deliverPackageStartNotices();
  assert.equal((await history('package.start.request.admin')).length, 1, 'the team is told');
  assert.equal((await history('package.start.request.received')).length, 1, 'the customer is told');
  const lead = await Lead.findOne({ reservationUserId: member._id });
  assert.match(lead.followUps.at(-1).note, /Wants to start the project on the package Business Starter \(₹9,999\)/);
});
test('a callback without a choice on a package with a running offer is recorded at the offer price', async () => {
  const offer = { slug: 'summer', title: 'Summer offer', status: 'published', endsAt: new Date(Date.now() + 5 * DAY).toISOString(), applicableCategories: ['standard_websites'],
    pricingRule: 'fixed_price', offerPrice: 7999, resolvedTerms: [] };
  await savePackage({ ...item, id: '', offerSlug: 'summer' }, true, [offer]);
  const live = global.fetch;
  global.fetch = async url => String(url).includes('/api/offers/live') ? { ok: true, json: async () => ({ offers: [offer], catalogueOffers: [offer], packagePages: [] }) } : live(url);
  try {
    const called = await callbackOnly(member);
    assert.equal(called.request.price, 7999, 'the offer price');
    await start.deliverPackageStartNotices();
    assert.equal((await history('package.start.request.admin')).length, 1);
  } finally { global.fetch = live; }
});
test('a callback without a choice is still recorded when the website cannot be reached', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  const live = global.fetch;
  global.fetch = async url => { if (String(url).includes('/api/offers/live')) throw new Error('offline'); return live(url); };
  try {
    const called = await callbackOnly(member);
    assert.equal(called.requested, true); assert.equal(called.request.price, 9999, 'the normal price');
  } finally { global.fetch = live; }
});
test('a buy still needs the choice; a callback with a bad choice is still refused', async () => {
  await savePackage({ ...item, id: '' }, true, []);
  await assert.rejects(start.requestPackageStart({ userId: member._id, packageId: 'business-starter', kind: 'buy' }), /Choose how you want to buy this package/);
  await assert.rejects(start.requestPackageStart({ userId: member._id, packageId: 'business-starter', kind: 'buy', choice: null }), /Choose how you want to buy this package/);
  await assert.rejects(start.requestPackageStart({ userId: member._id, packageId: 'business-starter', kind: 'callback', choice: { paymentOption: 'nope' } }), /Choose a way to pay/);
  assert.equal(await StartRequest.countDocuments(), 0);
});
