// Team mail goes where the admins saved it in Admin → Settings (helpers/teamContacts.js), with the owner's
// fallback only while nobody saved anything. Isolated MongoDB, fake email provider, real WhatsApp queue rows.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const Reservation = require('../models/offerReservationModel');
const { EmailDraft, EmailHistory, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');
const { reserveOffer } = require('../helpers/offerReservations');
const { requestProjectStart, deliverStartNotices } = require('../helpers/reservationStart');
const { teamRecipients, teamNumbersFor } = require('../helpers/teamContacts');
const { isAdminRecipientEvent } = require('../helpers/emailCatalog');

const HOUR = 3600000;
let database, member, offer, sent;
const realFetch = global.fetch;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User, Lead, Reservation, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate, Queue].map(model => model.init()));
  Object.assign(process.env, {
    PORTFOLIO_WEBSITE_URL: 'https://website.example.test', ADMIN_DASHBOARD_URL: 'https://portal.example.test',
    PORTFOLIO_INTEGRATION_SECRET: 'isolated-test-secret-32-characters-long', RESEND_API_KEY: 'isolated-test', FROM_EMAIL: 'sender@example.test',
    OFFER_RESERVATIONS_ENABLED: 'true', OFFER_RESERVATION_CONFIRMATIONS_ENABLED: 'true', ENABLE_WHATSAPP: 'true',
  });
  global.fetch = async (url, options) => {
    if (String(url).includes('/api/offers/live')) return { ok: true, json: async () => ({ offers: [offer], catalogueOffers: [offer] }) };
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(options.body).to); return { ok: true, json: async () => ({ id: `provider-${sent.length}` }) }; }
    throw new Error(`Unexpected external request ${url}`);
  };
});
after(async () => { global.fetch = realFetch; await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  member = await User.create({ name: 'Member', email: 'member@example.test', roles: ['member'], phone: '+919876500001' });
  sent = [];
  offer = { slug: 'test-offer', title: 'Reserved website', status: 'published', endsAt: new Date(Date.now() + HOUR).toISOString(),
    mainPrice: 10000, offerPrice: 5000, pricingRule: 'fixed_price', quoteKey: 'quote', resolvedTerms: [], targets: ['projects'],
    applicableCategories: ['standard_websites'], inclusions: [], reservationHoldHours: 48 };
});
// A team message through the real path: Start my project tells the team (offer.start.request.admin).
async function teamMessage() {
  await reserveOffer({ userId: member._id, offerSlug: offer.slug, quoteKey: offer.quoteKey });
  await requestProjectStart({ reservationId: (await Reservation.findOne())._id, userId: member._id });
  await deliverStartNotices();
  const [history] = await EmailHistory.find({ event: 'offer.start.request.admin' }).lean();
  const queued = await Queue.find({ event: 'offer.start.request.admin' }).sort({ to: 1 }).lean();
  return { to: history.to, whatsapp: queued.filter(row => row.status === 'pending').map(row => row.to) };
}

test('nobody saved settings: the owner fallback, syncvap@gmail.com and both numbers', async () => {
  assert.deepEqual(await teamRecipients(), ['syncvap@gmail.com']);
  const { to, whatsapp } = await teamMessage();
  assert.deepEqual(to, ['syncvap@gmail.com']);
  assert.deepEqual(whatsapp, ['919256537003', '919356393094']);
});
test('the admin settings decide: contact email and both saved numbers, no fallback', async () => {
  await User.create({ name: 'Owner', email: 'login@example.test', roles: ['admin'], phone: '+919800000000',
    adminContact: { email: 'team@example.test', whatsappNumbers: ['+919811111111', '+919822222222'] } });
  const { to, whatsapp } = await teamMessage();
  assert.deepEqual(to, ['team@example.test']);
  assert.deepEqual(whatsapp, ['919811111111', '919822222222'], 'the saved numbers, not the account phone');
  assert.ok(!JSON.stringify(sent).includes('syncvap'));
});
test('numbers without a contact email use the login email; an admin who saved nothing gets nothing', async () => {
  await User.create([
    { name: 'Numbers only', email: 'numbers@example.test', roles: ['admin'], adminContact: { email: '', whatsappNumbers: ['+919833333333'] } },
    { name: 'Nothing saved', email: 'silent@example.test', roles: ['admin'], phone: '+919844444444' },
    { name: 'Gone', email: 'gone@example.test', roles: ['admin'], isActive: false, adminContact: { email: 'gone@example.test', whatsappNumbers: ['+919855555555'] } },
  ]);
  assert.deepEqual(await teamRecipients(), ['numbers@example.test']);
  assert.deepEqual(await teamNumbersFor('NUMBERS@example.test'), ['+919833333333']);
});
test('one admin without a number still gets the email; WhatsApp goes to the admin that has one', async () => {
  await User.create([
    { name: 'Email only', email: 'a@example.test', roles: ['admin'], adminContact: { email: 'mail-only@example.test', whatsappNumbers: [] } },
    { name: 'With number', email: 'b@example.test', roles: ['admin'], adminContact: { email: 'with-number@example.test', whatsappNumbers: ['+919866666666'] } },
  ]);
  const { to, whatsapp } = await teamMessage();
  assert.deepEqual([...to].sort(), ['mail-only@example.test', 'with-number@example.test']);
  assert.deepEqual(whatsapp, ['919866666666']);
  assert.equal(sent.filter(list => list.includes('mail-only@example.test')).length, 1, 'the email went to both');
});
test('customer mail and the developer assignment keep their own recipients', async () => {
  await User.create({ name: 'Owner', email: 'login@example.test', roles: ['admin'], adminContact: { email: 'team@example.test', whatsappNumbers: ['+919811111111'] } });
  await teamMessage();
  const [customer] = await EmailHistory.find({ event: 'offer.start.request.received' }).lean();
  assert.deepEqual(customer.to, ['member@example.test']);
  assert.equal(isAdminRecipientEvent('sendDeveloperAssignmentEmail'), false);
  assert.equal(isAdminRecipientEvent('plan.request.admin'), true);
});
