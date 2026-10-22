const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const MonthlyInvoice = require('../models/monthlyInvoiceModel');
const UpdateRequest = require('../models/updateRequestModel');
const User = require('../models/userModel');
const Product = require('../models/productModel');
const { EmailHistory } = require('../models/emailControlModel');
const ChessGame = require('../chess/chessGameModel');
const { collectFirstRunPreview, installWriteGuard, printReport } = require('../scripts/readOnlyCronFirstRunPreview');

// Fixtures go in raw (no schema validation): the preview reads whatever production holds.
const NOW = new Date('2026-10-23T01:30:00+05:30');
const days = n => new Date(NOW.getTime() + n * 86400000);
const id = () => new mongoose.Types.ObjectId();
let database, report, before_;
const ids = { customer: id(), legacyProduct: id(), legacyOrder: id(), inactive: id(), renewing: id(), finalCycle: id(), offerOrder: id(), offerBill: id(), sentBill: id() };
const counts = () => Promise.all([Order, Invoice, MonthlyInvoice, UpdateRequest, EmailHistory, ChessGame].map(model => model.collection.countDocuments()));

before(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri(), { dbName: 'cron-preview' });
  await User.collection.insertOne({ _id: ids.customer, name: 'Ravi', email: 'ravi@example.test', roles: ['customer'] });
  await UpdateRequest.collection.insertOne({ userId: ids.customer, files: [
    { originalName: 'old.zip', driveFileId: 'drive-1', expirationDate: days(-3) },
    { originalName: 'no-drive.txt', expirationDate: days(-3) },
    { originalName: 'fresh.zip', driveFileId: 'drive-2', expirationDate: days(5) },
  ] });
  await Product.collection.insertOne({ _id: ids.legacyProduct, serviceName: 'Legacy', isMonthlyLimitedPlan: true, monthlyRenewalPrice: 1200 });
  await Order.collection.insertMany([
    { _id: ids.legacyOrder, userId: ids.customer, productId: ids.legacyProduct, currentMonthExpiryDate: days(-2), totalYearlyDaysRemaining: 200 },
    // Validity plan, no auto-renew: stopped at its billing date although its own ending is ahead.
    { _id: ids.inactive, userId: ids.customer, isServicePlan: true, servicePlanStatus: 'active', serviceNextBillingDate: days(-5), servicePlanEndDate: days(300), serviceAutoRenew: false, servicePlanSnapshot: { serviceName: 'Yearly care' } },
    { _id: ids.renewing, userId: ids.customer, isServicePlan: true, servicePlanStatus: 'active', serviceNextBillingDate: days(-1), serviceTotalCycles: 3, serviceCurrentCycleNumber: 1,
      serviceSelectedBillingCycle: 'monthly', servicePlanSnapshot: { serviceName: 'Monthly SEO', billingOptions: [{ billingCycle: 'monthly', pricePerCycle: 500 }] } },
    { _id: ids.finalCycle, userId: ids.customer, isServicePlan: true, servicePlanStatus: 'active', serviceNextBillingDate: days(-1), serviceTotalCycles: 2, serviceCurrentCycleNumber: 2, servicePlanSnapshot: { serviceName: 'Two months' } },
    { _id: ids.offerOrder, userId: ids.customer, isWebsiteProject: true, orderVisibility: 'approved',
      paymentPolicy: { mode: 'pay_later', dueDays: 7, cycleScope: 'first_purchase', reminderOffsets: [-1, 0, 3], appliedAt: days(-8) } },
  ]);
  await MonthlyInvoice.collection.insertOne({ userId: ids.customer, orderId: ids.legacyOrder, invoiceNumber: 'INV-1', amount: 1200, status: 'unpaid', dueDate: days(-1) });
  await Invoice.collection.insertMany([
    { _id: ids.offerBill, orderId: ids.offerOrder, invoiceType: 'project', invoiceNumber: 'OFR-1', amount: 699, status: 'unpaid', dueDate: days(-1) },
    { _id: ids.sentBill, orderId: ids.offerOrder, invoiceType: 'project', invoiceNumber: 'OFR-2', amount: 100, status: 'overdue', dueDate: days(-1) },
  ]);
  await EmailHistory.collection.insertOne({ dedupeKey: `offer-reminder:${ids.sentBill}:0`, event: 'offer.payment.reminder' });
  await ChessGame.collection.insertMany([
    { roomCode: 'OLD', status: 'end-pending', endRequestedAt: new Date(NOW.getTime() - 13 * 3600000) },
    { roomCode: 'NEW', status: 'end-pending', endRequestedAt: new Date(NOW.getTime() - 1 * 3600000) },
  ]);
  before_ = await counts();
  installWriteGuard();
  report = await collectFirstRunPreview(NOW);
});
after(async () => { await mongoose.disconnect(); await database?.stop(); });

test('file cleanup lists only expired Drive files as permanent deletes', () => {
  assert.equal(report.fileCleanup.length, 1);
  assert.deepEqual(report.fileCleanup[0].driveDeletes.map(file => file.name), ['old.zip']);
  assert.equal(report.fileCleanup[0].recordsRemovedWithoutDrive, 1);
  assert.match(report.fileCleanup[0].customer, /Ravi <ravi@example.test>/);
});

test('overdue monthly bill pauses its legacy plan, and the legacy plan renews', () => {
  assert.deepEqual(report.overdueMonthly.map(row => [row.invoice, row.planPaused]), [['INV-1', true]]);
  assert.deepEqual(report.legacyRenewals.map(row => [row.orderId, row.invoiceAmount]), [[String(ids.legacyOrder), 1200]]);
});

test('service renewals: inactive before its ending is flagged, a due cycle bills and pauses, a final cycle expires', () => {
  const byId = Object.fromEntries(report.serviceRenewals.map(row => [row.orderId, row]));
  assert.equal(byId[ids.inactive].outcome, 'inactive');
  assert.equal(byId[ids.inactive].endsEarly, true);
  assert.equal(byId[ids.renewing].newInvoice, 500);
  assert.match(byId[ids.renewing].outcome, /^paused until cycle 2/);
  assert.equal(byId[ids.finalCycle].outcome, 'expired');
  assert.equal(byId[ids.finalCycle].endsEarly, false);
});

test('offer reminders: the latest due milestone is sent once; an already-sent reminder is skipped', () => {
  const byBill = Object.fromEntries(report.offerReminders.map(row => [row.invoice, row]));
  assert.equal(byBill['OFR-1'].offsetDays, 0);
  assert.equal(byBill['OFR-1'].willSend, true);
  assert.equal(byBill['OFR-2'].willSend, false);
  assert.equal(byBill['OFR-2'].reason, 'already sent');
  assert.deepEqual(report.offerInvoicesOverdue, ['OFR-1']);
});

test('only the chess game stuck for more than 12 hours is deleted', () => {
  assert.equal(report.chessDeleted, 1);
});

test('the preview changed nothing, and any write is refused before it reaches the database', async () => {
  assert.deepEqual(await counts(), before_);
  assert.equal((await UpdateRequest.collection.findOne({})).files.length, 3);
  await assert.rejects(Order.updateOne({ _id: ids.inactive }, { $set: { servicePlanStatus: 'inactive' } }), /READ-ONLY: blocked updateOne/);
  await assert.rejects(ChessGame.deleteMany({}), /READ-ONLY: blocked deleteMany/);
  assert.equal((await Order.collection.findOne({ _id: ids.inactive })).servicePlanStatus, 'active');
});

test('the printed report states counts and warnings plainly', () => {
  const lines = [];
  const log = console.log; console.log = line => lines.push(String(line ?? ''));
  try { printReport(report); } finally { console.log = log; }
  const text = lines.join('\n');
  assert.match(text, /1 file\(s\) PERMANENTLY deleted from Google Drive/);
  assert.match(text, /STOPS BEFORE ITS OWN ENDING DATE/);
  assert.match(text, /Customer emails sent \(cannot be unsent\): 1/);
  assert.match(text, /No cron charges a wallet/);
});
