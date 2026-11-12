const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Reservation = require('../models/offerReservationModel');
const StartRequest = require('../models/packageStartRequestModel');
const Invoice = require('../models/invoiceModel');
const { EmailHistory } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');
const { legacyReminderHistory } = require('../helpers/legacyReminderHistory');
let db, userId, reservationId, requestId, invoiceId;
before(async () => { db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri()); await Promise.all([EmailHistory.init(), Queue.init()]); });
after(async () => { await mongoose.disconnect(); await db.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  userId = new mongoose.Types.ObjectId(); reservationId = new mongoose.Types.ObjectId(); requestId = new mongoose.Types.ObjectId(); invoiceId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, name: 'History customer' });
  await Reservation.collection.insertOne({ _id: reservationId, userId, offerSnapshot: { title: 'Finished offer' }, projectId: new mongoose.Types.ObjectId() });
  await StartRequest.collection.insertOne({ _id: requestId, userId, packageSnapshot: { name: 'Closed request' }, closedAt: new Date() });
  await Invoice.collection.insertOne({ _id: invoiceId, userId, invoiceNumber: 'PAID-HISTORY', status: 'paid' });
});
async function history(event, dedupeKey, extra = {}) {
  return EmailHistory.create({ event, dedupeKey, application: 'portal', draftId: new mongoose.Types.ObjectId(), status: 'sent', ...extra });
}
test('all retained history is paginated without losing completed records or inventing missing queue delivery', async () => {
  for (let version = 1; version <= 21; version++) await history('offer.reservation.extended', `offer-reservation-extended:${reservationId}:${version}`);
  const pending = await history('package.start.request.admin', `package-start-pending:${requestId}:1`, { status: 'queued', delivery: { channels: ['whatsapp'], emailStatus: 'not-selected', whatsappStatus: 'queued' } });
  await history('offer.payment.reminder', `offer-reminder:${invoiceId}:0`, { providerId: 'fake-provider' });
  await history('lead.proposal', `offer-reminder:${invoiceId}:999`); // an unrelated event cannot enter this history
  const first = await legacyReminderHistory({ source: 'reservation', entityId: String(reservationId), page: 1 });
  const second = await legacyReminderHistory({ source: 'reservation', entityId: String(reservationId), page: 2 });
  assert.equal(first.total, 21); assert.equal(first.rows.length, 20); assert.equal(second.rows.length, 1);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 21);
  assert.equal(first.rows[0].customer, 'History customer'); assert.equal(first.rows[0].context, 'Finished offer');
  const all = await legacyReminderHistory(); assert.equal(all.total, 23);
  const request = await legacyReminderHistory({ source: 'package_request', entityId: String(requestId) });
  assert.equal(request.rows[0].context, 'Closed request'); assert.deepEqual(request.rows[0].whatsapp, []);
  assert.equal(request.rows[0].whatsappLastKnown, 'queued');
  await Queue.create({ emailDraftId: pending.draftId, event: pending.event, to: '919876543210', text: 'Reminder', status: 'sent', sentAt: new Date() });
  const withQueue = await legacyReminderHistory({ source: 'package_request', entityId: String(requestId) });
  assert.equal(withQueue.rows[0].whatsapp[0].status, 'sent');
  const payment = await legacyReminderHistory({ source: 'offer_payment', entityId: String(invoiceId) });
  assert.equal(payment.rows[0].context, 'PAID-HISTORY'); assert.equal(payment.rows[0].emailStatus, 'sent');
});
test('history rejects invalid sources and IDs, and retains auditable records when the source has been deleted', async () => {
  await history('offer.reservation.expired', `offer-reservation-expired:${reservationId}`);
  await assert.rejects(legacyReminderHistory({ source: 'constructor' }), /Unknown history source/);
  await assert.rejects(legacyReminderHistory({ source: 'all', entityId: String(reservationId) }), /valid record/);
  await assert.rejects(legacyReminderHistory({ source: 'reservation', entityId: 'not-an-id' }), /valid record/);
  await Reservation.deleteOne({ _id: reservationId });
  await assert.rejects(legacyReminderHistory({ source: 'reservation', entityId: String(reservationId) }), /no longer available/);
  const all = await legacyReminderHistory(); assert.equal(all.total, 1); assert.equal(all.rows[0].customer, 'Record no longer available');
});
