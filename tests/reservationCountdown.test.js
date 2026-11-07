// Reservation hours per offer, the start/closing messages and each action's "Send via"
// (merasoftware/src/docs/reservation-countdown.md). Isolated MongoDB, fake email provider, real WhatsApp queue rows.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const Reservation = require('../models/offerReservationModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const Category = require('../models/categoryBasePriceModel');
const { EmailDraft, EmailHistory, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');
const { reserveOffer, listReservations, extendReservation, holdHours } = require('../helpers/offerReservations');
const { drainReservationConfirmations } = require('../helpers/offerReservationConfirmation');
const { closeDueReservations, reservationOverview } = require('../helpers/reservationClosure');
const { channelFor, byKey, events } = require('../helpers/emailCatalog');
const { buildTemplatedMail, systemTemplate } = require('../helpers/emailTemplates');
const { definitions } = require('../helpers/emailDefinitions');
const createProject = require('../controller/order/adminCreateProjectOrder');

const HOUR = 3600000;
let database, member, customer, offer, emails;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Lead, Reservation, Order, Invoice, Transaction, Category, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate, Queue].map(model => model.init()));
  Object.assign(process.env, {
    PORTFOLIO_WEBSITE_URL: 'https://website.example.test', FORNTEND_URL: 'https://portal.example.test',
    PORTFOLIO_INTEGRATION_SECRET: 'isolated-test-secret-32-characters-long', RESEND_API_KEY: 'isolated-test', FROM_EMAIL: 'sender@example.test',
    OFFER_RESERVATIONS_ENABLED: 'true', OFFER_RESERVATION_CONFIRMATIONS_ENABLED: 'true', ENABLE_WHATSAPP: 'true',
  });
  global.fetch = async url => {
    if (String(url).includes('/api/offers/live')) return { ok: true, json: async () => ({ offers: [offer], catalogueOffers: [offer] }) };
    if (String(url).includes('api.resend.com')) { emails++; return { ok: true, json: async () => ({ id: `provider-${emails}` }) }; }
    throw new Error(`Unexpected external request ${url}`);
  };
});
after(async () => { global.fetch = realFetch; await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [member, customer] = await User.create([
    { name: 'Member', email: 'member@example.test', roles: ['member'], phone: '+919876500001' },
    { name: 'Client', email: 'client@example.test', roles: ['customer'], phone: '+919876500002' },
  ]);
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
  emails = 0;
  process.env.ENABLE_WHATSAPP = 'true';
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'true';
  offer = { slug: 'test-offer', title: 'Reserved website', status: 'published', endsAt: new Date(Date.now() + HOUR).toISOString(),
    mainPrice: 10000, offerPrice: 5000, pricingRule: 'fixed_price', quoteKey: 'quote', resolvedTerms: ['Agreed scope'], targets: ['projects'],
    applicableCategories: ['standard_websites'], inclusions: ['Website'], reservationHoldHours: 48 };
});
const reserve = (user = member) => reserveOffer({ userId: user._id, offerSlug: offer.slug, quoteKey: offer.quoteKey });
async function adminProject() {
  const admin = await User.findOneAndUpdate({ email: 'admin@example.test' }, { $setOnInsert: { name: 'Admin', roles: ['admin'] } }, { upsert: true, new: true });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  // The controller drains confirmations itself; keep it off here so the test decides when they go.
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'false';
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) },
    body: { category: 'standard_websites', sellingPrice: 5000, paymentType: 'full', offerSlug: offer.slug, offerQuoteKey: offer.quoteKey } }, res);
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'true';
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res;
}
// Moves a reservation's clock, as if it had been made `ago` ms earlier with its own hours.
async function age(ago) {
  const row = await Reservation.findOne().lean();
  const shift = date => new Date(new Date(date).getTime() - ago);
  await Reservation.collection.updateOne({ _id: row._id }, { $set: { reservedAt: shift(row.reservedAt), expiresAt: shift(row.expiresAt) } });
}
const queued = event => Queue.find({ event }).lean();

// --- Hours --------------------------------------------------------------------------------------
test('a reservation lasts the hours its offer sets, frozen at reserve time', async () => {
  await reserve();
  const row = await Reservation.findOne();
  assert.equal(row.expiresAt - row.reservedAt, 48 * HOUR);
  assert.equal(row.closureStatus, 'pending');
  offer.reservationHoldHours = 6; // the admin edits the offer afterwards
  await listReservations(member._id);
  assert.equal((await Reservation.findOne()).expiresAt - row.reservedAt, 48 * HOUR);
});
test('missing or invalid hours mean 72', () => {
  for (const value of [undefined, null, 0, 721, 1.5, '48']) assert.equal(holdHours({ reservationHoldHours: value }), 72);
  assert.equal(holdHours({ reservationHoldHours: 1 }), 1);
  assert.equal(holdHours({ reservationHoldHours: 720 }), 720);
});
test('a project created by the team on an offer gets the offer hours too', async () => {
  await adminProject();
  const row = await Reservation.findOne();
  assert.equal(row.origin, 'admin_project');
  assert.equal(row.expiresAt - row.reservedAt, 48 * HOUR);
});

// --- Start message --------------------------------------------------------------------------------
test('start message goes by WhatsApp only, with the hours, the deadline and the next step', async () => {
  await reserve(); await drainReservationConfirmations();
  assert.equal(emails, 0, 'no email by default');
  const [row] = await queued('offer.reserved');
  assert.equal(row.to, '919876500001');
  assert.match(row.text, /lasts 48 hours/);
  assert.match(row.text, /Get your project started before then/);
  assert.equal((await Reservation.findOne()).confirmationStatus, 'sent');
  await Reservation.updateOne({}, { $set: { confirmationStatus: 'pending', confirmationNextAttemptAt: new Date(0) } });
  await drainReservationConfirmations();
  assert.equal((await queued('offer.reserved')).length, 1, 'a retry never sends twice');
});
test('a project created by the team says the project has started instead', async () => {
  await adminProject(); await drainReservationConfirmations();
  const [row] = await queued('offer.reserved');
  assert.match(row.text, /Your project has started/);
  assert.doesNotMatch(row.text, /Get your project started/);
});
test('no phone: Not sent with the reason, never an email, never retried', async () => {
  // No phone anywhere: the account's and its lead's are removed (savedPhoneFor falls back to the lead).
  await reserve(); await User.updateOne({ _id: member._id }, { $unset: { phone: 1 } });
  await Lead.collection.updateMany({}, { $unset: { phone: 1 } });
  await drainReservationConfirmations();
  assert.equal(emails, 0);
  assert.equal((await Reservation.findOne()).confirmationStatus, 'not-sent');
  const draft = await EmailDraft.findOne({ event: 'offer.reserved' }).lean();
  assert.equal(draft.status, 'skipped'); assert.match(draft.failure, /^Not sent: A valid saved phone number is missing/);
  assert.equal((await EmailHistory.findOne({ draftId: draft._id }).lean()).failure, draft.failure);
  await drainReservationConfirmations();
  assert.equal(await EmailDraft.countDocuments(), 1); assert.equal(emails, 0);
});
test('Both on automatic mail sends the part that can go (email without a phone), never Not sent', async () => {
  await EmailPolicy.create({ event: 'offer.reserved', channel: 'both' });
  await reserve(); await User.updateOne({ _id: member._id }, { $unset: { phone: 1 } });
  await Lead.collection.updateMany({}, { $unset: { phone: 1 } });
  await drainReservationConfirmations();
  assert.equal(emails, 1); assert.equal((await queued('offer.reserved')).length, 0);
  assert.equal((await Reservation.findOne()).confirmationStatus, 'sent');
});
test('Email or Both chosen on the action sends that way', async () => {
  await EmailPolicy.create({ event: 'offer.reserved', channel: 'both' });
  await reserve(); await drainReservationConfirmations();
  assert.equal(emails, 1); assert.equal((await queued('offer.reserved')).length, 1);
});

// --- Closing message ------------------------------------------------------------------------------
test('deadline passed with no project: one closing message with the offers page', async () => {
  await reserve(); await drainReservationConfirmations();
  await closeDueReservations();
  assert.equal((await queued('offer.reservation.expired')).length, 0, 'not before the deadline');
  await age(48 * HOUR + 60000);
  await closeDueReservations();
  const [row] = await queued('offer.reservation.expired');
  assert.match(row.text, /offer has now expired/); assert.match(row.text, /https:\/\/website\.example\.test\/offers/); assert.match(row.text, /Better luck next time/);
  assert.equal((await Reservation.findOne()).closureStatus, 'sent');
  await Reservation.updateOne({}, { $set: { closureStatus: 'pending' } });
  await closeDueReservations();
  assert.equal((await queued('offer.reservation.expired')).length, 1, 'once only');
  // Owner decision 7 Nov 2026: the closing message goes by Email + WhatsApp (the confirmation stays WhatsApp only).
  assert.equal(emails, 1);
});
test('a project on the reservation means used: no closing message, even if released later', async () => {
  await reserve(customer);
  await adminProject();
  const row = await Reservation.findOne();
  assert.ok(row.projectId);
  await age(48 * HOUR + 60000);
  await closeDueReservations();
  assert.equal((await Reservation.findOne()).closureStatus, 'used');
  await Order.updateOne({ _id: row.projectId }, { $set: { orderVisibility: 'cancelled' } });
  await listReservations(customer._id); // releases the cancelled project's reservation
  assert.equal((await Reservation.findOne()).projectId, null);
  await closeDueReservations();
  assert.equal((await queued('offer.reservation.expired')).length, 0);
});
test('an extension moves the closing message to the new deadline', async () => {
  await reserve(); await age(48 * HOUR + 60000);
  const admin = await User.create({ name: 'Admin', email: 'admin2@example.test', roles: ['admin'] });
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'false';
  await extendReservation({ reservationId: (await Reservation.findOne())._id, actorId: admin._id, until: new Date(Date.now() + 2 * HOUR), reason: 'Customer asked' });
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'true';
  await closeDueReservations();
  assert.equal((await Reservation.findOne()).closureStatus, 'pending');
  await Reservation.updateOne({}, { $set: { extendedUntil: new Date(Date.now() - 60000) } });
  await closeDueReservations();
  assert.equal((await Reservation.findOne()).closureStatus, 'sent');
});
test('a deadline over 24 hours old is late: no burst of old messages', async () => {
  await reserve(); await age(48 * HOUR + 25 * HOUR);
  await closeDueReservations();
  assert.equal((await Reservation.findOne()).closureStatus, 'late');
  assert.equal((await queued('offer.reservation.expired')).length, 0);
});
test('reservations made before this shipped are never messaged', async () => {
  await reserve();
  await Reservation.collection.updateOne({}, { $unset: { closureStatus: 1 } });
  await age(48 * HOUR + 60000);
  await closeDueReservations();
  assert.equal((await Reservation.findOne()).closureStatus, undefined);
  assert.equal((await queued('offer.reservation.expired')).length, 0);
});
test('closing message Off or unreachable is recorded as not-sent', async () => {
  await EmailPolicy.create({ event: 'offer.reservation.expired', mode: 'off' });
  await reserve(); await age(48 * HOUR + 60000);
  await closeDueReservations();
  const row = await Reservation.findOne();
  assert.equal(row.closureStatus, 'not-sent'); assert.match(row.closureFailure, /Off/);
});
test('closing job is off with the confirmations flag', async () => {
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'false';
  await reserve(); await age(48 * HOUR + 60000);
  assert.deepEqual(await closeDueReservations(), []);
  assert.equal((await Reservation.findOne()).closureStatus, 'pending');
});
test('the Reservation box counts running, used and expired reservations', async () => {
  await reserve();
  let view = await reservationOverview();
  assert.equal(view.counts.running, 1); assert.equal(view.running[0].hours, 48); assert.equal(view.running[0].customer, 'Member');
  await age(48 * HOUR + 60000); await closeDueReservations();
  view = await reservationOverview();
  assert.equal(view.counts.running, 0); assert.equal(view.counts.expired, 1); assert.equal(view.counts.closures.sent, 1);
});

// --- Send via -----------------------------------------------------------------------------------------
test('every action has one route: customer WhatsApp, team Both, subscription Email', () => {
  const team = events.filter(row => row.audience === 'team').map(row => row.key);
  assert.equal(team.length, 13, 'with the package start request (helpers/packageStart.js)');
  // Owner decision 7 Nov 2026: the reservation countdown and start-request messages to the customer go by Both.
  const customerBoth = ['offer.reservation.reminder', 'offer.reservation.lastHour', 'offer.start.request.received', 'offer.reservation.expired', 'package.start.request.received'];
  for (const row of events) {
    const expected = row.key.startsWith('website.subscription.') ? 'email' : row.audience === 'team' || customerBoth.includes(row.key) ? 'both' : 'whatsapp';
    assert.equal(channelFor(row.key, null), expected, row.key);
  }
  assert.equal(channelFor('offer.reserved', { channel: 'both' }), 'both');
  assert.equal(channelFor('website.subscription.confirm', { channel: 'whatsapp' }), 'email');
  assert.equal(byKey.get('offer.reservation.expired').trigger, 'system');
});

// --- Invoice link ---------------------------------------------------------------------------------
test('invoice messages link to the portal invoice instead of promising a PDF', async () => {
  const invoice = { _id: new mongoose.Types.ObjectId(), invoiceNumber: 'INV-9', amount: 3000, dueDate: new Date(), userId: { name: 'Client', email: 'client@example.test' } };
  const href = `https://portal.example.test/invoice-detail/${invoice._id}`;
  for (const [event, args] of [['invoice.reminder', [invoice, 'Please pay']], ['offer.payment.reminder', [invoice, 'Please pay']], ['invoice.project', [invoice]],
    ['sendMonthlyInvoiceEmail', [invoice.userId, {}, invoice]]]) {
    const mail = buildTemplatedMail(event, ...args);
    assert.ok(mail.requiredLinks.includes(href), event);
    assert.equal(mail.values.invoiceLink, href, event);
    assert.doesNotMatch(definitions[event].text, /attached/i, event);
  }
});
test('an unedited Standard copy moves to the new wording; an edited one is kept', async () => {
  const old = definitions['invoice.reminder'].replaces[0];
  await EmailTemplate.create({ event: 'invoice.reminder', system: true, name: 'Standard', subject: definitions['invoice.reminder'].subject, text: old });
  assert.equal((await systemTemplate('invoice.reminder')).text, definitions['invoice.reminder'].text);
  await EmailTemplate.create({ event: 'offer.reserved', system: true, name: 'Standard', subject: 'Reserved', text: 'Owner wording {{name}}' });
  assert.equal((await systemTemplate('offer.reserved')).text, 'Owner wording {{name}}');
});
