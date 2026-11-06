// Reservation reminders (24 h / 1 h left) and "Start my project" (merasoftware/src/docs/reservation-countdown.md,
// owner decisions 7 Nov 2026). Isolated MongoDB, fake email provider, real WhatsApp queue rows.
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
const { reserveOffer, listReservations, extendReservation } = require('../helpers/offerReservations');
const { closeDueReservations, reservationOverview } = require('../helpers/reservationClosure');
const { sendDueReminders } = require('../helpers/reservationReminders');
const { requestProjectStart, deliverStartNotices, alertPendingStarts } = require('../helpers/reservationStart');
const { byKey, channelFor } = require('../helpers/emailCatalog');
const createProject = require('../controller/order/adminCreateProjectOrder');

const HOUR = 3600000;
let database, member, customer, admin, offer, emails;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Lead, Reservation, Order, Invoice, Transaction, Category, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate, Queue].map(model => model.init()));
  Object.assign(process.env, {
    PORTFOLIO_WEBSITE_URL: 'https://website.example.test', FORNTEND_URL: 'https://portal.example.test', ADMIN_DASHBOARD_URL: 'https://portal.example.test',
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
  [member, customer, admin] = await User.create([
    { name: 'Member', email: 'member@example.test', roles: ['member'], phone: '+919876500001' },
    { name: 'Client', email: 'client@example.test', roles: ['customer'], phone: '+919876500002' },
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
  ]);
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
  emails = 0;
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'true';
  offer = { slug: 'test-offer', title: 'Reserved website', status: 'published', endsAt: new Date(Date.now() + HOUR).toISOString(),
    mainPrice: 10000, offerPrice: 5000, pricingRule: 'fixed_price', quoteKey: 'quote', resolvedTerms: ['Agreed scope'], targets: ['projects'],
    applicableCategories: ['standard_websites'], inclusions: ['Website'], reservationHoldHours: 48 };
});
const reserve = async (user = member) => (await reserveOffer({ userId: user._id, offerSlug: offer.slug, quoteKey: offer.quoteKey })).reservation;
// The clock as if the reservation had been made `ago` ms earlier (every saved time moves back).
async function age(ago) {
  const row = await Reservation.findOne().lean();
  const shift = date => date && new Date(new Date(date).getTime() - ago);
  await Reservation.collection.updateOne({ _id: row._id }, { $set: { reservedAt: shift(row.reservedAt), expiresAt: shift(row.expiresAt),
    extendedUntil: shift(row.extendedUntil), startRequestedAt: shift(row.startRequestedAt),
    extensions: (row.extensions || []).map(item => ({ ...item, at: shift(item.at) })),
    startRequests: (row.startRequests || []).map(item => ({ ...item, at: shift(item.at) })) } });
}
const queued = event => Queue.find({ event }).lean();
const history = event => EmailHistory.find({ event }).lean();
const start = async (user = member) => requestProjectStart({ reservationId: (await Reservation.findOne())._id, userId: user._id });
async function projectOn(reservationId) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'false';
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) },
    body: { category: 'standard_websites', sellingPrice: 5000, paymentType: 'full', offerSlug: offer.slug, offerQuoteKey: offer.quoteKey, offerReservationId: String(reservationId) } }, res);
  process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED = 'true';
  return res;
}

// --- Reminders ----------------------------------------------------------------------------------------
test('a 48-hour reservation gets one reminder at 24 hours left and one at 1 hour left, with the offer page', async () => {
  await reserve();
  await age(23 * HOUR); await sendDueReminders();
  assert.equal((await queued('offer.reservation.reminder')).length, 0, 'not at 25 hours left');
  await age(HOUR + 60000); await sendDueReminders(); await sendDueReminders();
  const [first] = await queued('offer.reservation.reminder');
  assert.equal((await queued('offer.reservation.reminder')).length, 1, 'once only');
  assert.match(first.text, /ends in about 24 hours/); assert.match(first.text, /https:\/\/website\.example\.test\/offer\/test-offer/);
  assert.equal(emails, 1, 'Both: the email went too');
  await age(23 * HOUR); await sendDueReminders();
  const [last] = await queued('offer.reservation.lastHour');
  assert.match(last.text, /This is the last hour: your reservation for Reserved website ends in about (59 minutes|1 hour)/);
  assert.equal((await Reservation.findOne()).remindersSent.length, 2);
});
test('a missed run sends only the latest stage, and none after the deadline', async () => {
  await reserve();
  await age(47.5 * HOUR); await sendDueReminders();
  assert.equal((await queued('offer.reservation.reminder')).length, 0);
  assert.equal((await queued('offer.reservation.lastHour')).length, 1);
  await Reservation.deleteMany({}); await Queue.deleteMany({});
  await reserve(); await age(48 * HOUR + 60000); await sendDueReminders();
  assert.equal((await Queue.find({ event: /offer\.reservation\.(reminder|lastHour)/ })).length, 0);
});
test('a short hold skips the 24-hour reminder; reservations made before reminders shipped get none', async () => {
  offer.reservationHoldHours = 12;
  await reserve(); await sendDueReminders();
  assert.equal((await queued('offer.reservation.reminder')).length, 0, '12-hour hold: no 24-hour reminder');
  await age(11.5 * HOUR); await sendDueReminders();
  assert.equal((await queued('offer.reservation.lastHour')).length, 1);
  await Reservation.deleteMany({}); await Queue.deleteMany({});
  offer.reservationHoldHours = 48;
  await reserve(); await Reservation.collection.updateMany({}, { $unset: { remindersEnabled: '' } });
  await age(47.5 * HOUR); await sendDueReminders();
  assert.equal((await queued('offer.reservation.lastHour')).length, 0, 'older rows untouched');
});
test('an extension gets its own reminders for the new deadline', async () => {
  await reserve();
  await age(47.5 * HOUR); await sendDueReminders();
  const row = await Reservation.findOne();
  await extendReservation({ reservationId: row._id, actorId: admin._id, until: new Date(Date.now() + 30 * HOUR), reason: 'Customer asked' });
  await age(6 * HOUR + 60000); await sendDueReminders();
  assert.equal((await queued('offer.reservation.reminder')).length, 1, 'new deadline, new 24-hour reminder');
});

// --- Start my project ------------------------------------------------------------------------------------
test('start request: clock paused, team and customer told once, lead follow-up, no reminder or closing', async () => {
  const reserved = await reserve();
  await age(10 * HOUR);
  const result = await start();
  assert.equal(result.requested, true); assert.equal(result.reservation.status, 'start_requested');
  await deliverStartNotices(); await deliverStartNotices();
  const [team] = await history('offer.start.request.admin');
  assert.equal((await history('offer.start.request.admin')).length, 1);
  assert.deepEqual(team.to, ['vacomputers.com@gmail.com', 'syncvap@gmail.com']);
  const [told] = await queued('offer.start.request.received');
  assert.match(told.text, /We have received your request/); assert.match(told.text, /\/offer\/test-offer/);
  assert.equal((await history('offer.start.request.received')).length, 1);
  const lead = await Lead.findOne({ reservationUserId: member._id });
  assert.match(lead.followUps.at(-1).note, /Wants to start the project on Reserved website/);
  assert.equal(lead.status, (await Lead.findById(lead._id)).status, 'status unchanged');
  // A second click returns the saved request and sends nothing new.
  assert.equal((await start()).requested, false);
  await deliverStartNotices();
  assert.equal((await history('offer.start.request.admin')).length, 1);
  // Paused: past the old deadline it is not reminded, closed, expired or renewable.
  await age(48 * HOUR); await sendDueReminders(); await closeDueReservations();
  assert.equal((await Queue.find({ event: /offer\.reservation\.(reminder|lastHour|expired)/ })).length, 0);
  assert.equal((await listReservations(member._id)).reservations[0].status, 'start_requested');
  const view = await reservationOverview();
  assert.equal(view.counts.running, 1); assert.equal(view.counts.expired, 0); assert.ok(view.running[0].startRequestedAt);
  assert.equal((await reserve()).id, reserved.id, 'reserving again returns the paused reservation');
});
test('a project created on a paused reservation resumes the clock for the first payment, at least 24 hours', async () => {
  offer.reservationHoldHours = 72;
  await reserve(customer);
  await age(70 * HOUR); // 2 hours left
  await start(customer);
  await age(5 * HOUR); // the old deadline passed while paused
  const res = await projectOn((await Reservation.findOne())._id);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const row = await Reservation.findOne();
  assert.ok(row.projectId); assert.equal(row.startRequestedAt, null);
  assert.equal(row.startRequests[0].ended, 'project');
  const left = row.extendedUntil - Date.now();
  assert.ok(left > 23.9 * HOUR && left <= 24 * HOUR, `24 hours, got ${left / HOUR}`);
  const lead = await Lead.findOne({ convertedToUserId: customer._id });
  assert.match(lead.followUps.at(-1).note, /Project created on the start request/);
});
test('the admin resumes with Extend deadline, shorter too; the customer may ask again', async () => {
  await reserve();
  await start(); await deliverStartNotices();
  const row = await Reservation.findOne();
  // Customer declined: 1 hour, earlier than the old deadline, is allowed while paused.
  await extendReservation({ reservationId: row._id, actorId: admin._id, until: new Date(Date.now() + HOUR), reason: 'Customer declined' });
  const resumed = await Reservation.findOne();
  assert.equal(resumed.startRequestedAt, null); assert.equal(resumed.startRequests[0].ended, 'resumed');
  const lead = await Lead.findOne({ reservationUserId: member._id });
  assert.match(lead.followUps.at(-1).note, /countdown resumed by the team.*Customer declined/);
  await sendDueReminders();
  assert.equal((await queued('offer.reservation.lastHour')).length, 0, 'a 1-hour resume gets no 1-hour reminder');
  // Asking again is a new request with its own messages.
  assert.equal((await start()).requested, true);
  await deliverStartNotices();
  assert.equal((await history('offer.start.request.admin')).length, 2);
  await extendReservation({ reservationId: row._id, actorId: admin._id, until: new Date(Date.now() + HOUR), reason: 'No reply' });
  await age(HOUR + 60000); await closeDueReservations();
  assert.equal((await queued('offer.reservation.expired')).length, 1, 'the closing message follows the resumed deadline');
});
test('a request nobody acts on reminds the team once a day, at most 3 times', async () => {
  await reserve();
  await start(); await deliverStartNotices();
  await alertPendingStarts();
  assert.equal((await history('offer.start.request.admin')).length, 1, 'not before a full day');
  await age(24 * HOUR + 60000); await alertPendingStarts(); await alertPendingStarts();
  const alerts = () => EmailHistory.find({ event: 'offer.start.request.admin', dedupeKey: /^offer-start-pending:/ }).lean();
  assert.equal((await alerts()).length, 1);
  const draft = await EmailDraft.findOne({ dedupeKey: /^offer-start-pending:/ });
  assert.match(draft.blocks.get('waiting').text, /waiting 1 day/);
  assert.equal((await EmailDraft.findOne({ dedupeKey: /^offer-start-request:/ })).blocks.get('waiting').text, '', 'the first message has no waiting line');
  await age(5 * 24 * HOUR); for (let run = 0; run < 5; run++) await alertPendingStarts();
  assert.equal((await alerts()).length, 3);
});
test('no start after the deadline, on a project, or by another account', async () => {
  await reserve();
  await assert.rejects(requestProjectStart({ reservationId: (await Reservation.findOne())._id, userId: customer._id }), /not found/);
  await age(48 * HOUR + 60000);
  await assert.rejects(start(), /has ended/);
});
test('the new actions are system mail, start On, and go by Both; the team one is a team action', () => {
  for (const key of ['offer.reservation.reminder', 'offer.reservation.lastHour', 'offer.start.request.admin', 'offer.start.request.received']) {
    assert.equal(byKey.get(key).trigger, 'system', key);
    assert.equal(channelFor(key, null), 'both', key);
  }
  assert.equal(byKey.get('offer.start.request.admin').audience, 'team');
});
