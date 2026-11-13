const Run = require('../models/communicationReminderRunModel');
const Rule = require('../models/communicationReminderRuleModel');

// One line of status per reminder work for the admin Reminders list. Every number is a snapshot of stored
// state, never a delivery count: the workers re-check eligibility before sending.
const CACHE_MS = process.env.REMINDER_SUMMARY_CACHE_MS ? Number(process.env.REMINDER_SUMMARY_CACHE_MS) || 0 : 60000;
const SCAN_LIMIT = 20000; // rows read per work; past it the count is shown as a minimum
const BATCH = 500;
let cache = null;
const clearCache = () => { cache = null; };
const flag = name => process.env[name] === 'true';

// New rules (monthly package, broadcast follow-up): cheap, always live. An active rule only sends while both
// server schedulers are on (activation checks this once; the worker checks it on every run).
async function ruleSummary() {
  const schedulerEnabled = flag('COMMUNICATION_REMINDER_JOBS_ENABLED') && flag('ENABLE_CRONS');
  const rules = await Rule.find({ enabled: true, source: { $in: ['monthly_package', 'broadcast'] } }).select('_id source revision').lean();
  const result = {};
  for (const source of ['monthly_package', 'broadcast']) {
    const rule = rules.find(row => row.source === source);
    const recipients = rule ? await Run.distinct('clientId', { ruleId: rule._id, ruleRevision: rule.revision, source, status: 'scheduled' }) : [];
    result[source] = { enabled: !!rule, schedulerEnabled, scheduledRecipients: recipients.length };
  }
  return result;
}

const usable = user => !!user && user.isActive !== false && !user.deletedAt && !user.isGuest;
async function usersById(ids, select) {
  const User = require('../models/userModel');
  return new Map((await User.find({ _id: { $in: ids } }).select(select).lean()).map(user => [String(user._id), user]));
}

// Offer payment: customers with an open invoice whose saved agreement still has a reminder day ahead.
// The per-invoice rule is the admin list's own (offerReminderState), so list and count agree.
async function offerSummary(now) {
  const Invoice = require('../models/invoiceModel');
  const Order = require('../models/orderProductModel');
  const { EmailPolicy } = require('../models/emailControlModel');
  const { offerReminderState } = require('./offerReminderState');
  const policy = await EmailPolicy.findOne({ event: 'offer.payment.reminder' }).select('mode').lean();
  const customers = new Set();
  let scanned = 0, truncated = false, buffer = [];
  const flush = async () => {
    const users = await usersById(buffer.map(row => row.userId), 'email isActive deletedAt');
    for (const invoice of buffer) {
      const state = offerReminderState(invoice, invoice.orders, users.get(String(invoice.userId)), now, invoice.offerRemindersPaused ? 'paused' : '');
      if (!state.reason && state.nextMilestone) customers.add(String(invoice.userId));
    }
    buffer = [];
  };
  const cursor = Invoice.aggregate([
    { $match: { invoiceType: { $in: ['project', 'plan_renewal'] }, status: { $in: ['unpaid', 'partially_paid', 'overdue'] } } },
    { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'orders' } },
    { $unwind: '$orders' },
    { $match: { 'orders.paymentPolicy': { $ne: null }, 'orders.orderVisibility': { $ne: 'cancelled' }, 'orders.servicePlanStatus': { $ne: 'pending_activation' } } },
    { $project: { userId: 1, dueDate: 1, offerRemindersPaused: 1, installmentNumber: 1, serviceCycleNumber: 1, orders: 1 } },
  ]).allowDiskUse(true).cursor();
  for await (const invoice of cursor) {
    if (scanned >= SCAN_LIMIT) { truncated = true; break; }
    scanned += 1; buffer.push(invoice);
    if (buffer.length >= BATCH) await flush();
  }
  if (buffer.length) await flush();
  return { messagesOn: policy?.mode !== 'off', schedulerEnabled: flag('ENABLE_CRONS'), upcomingCustomers: customers.size, truncated };
}

// Reservation: customers with a running reservation that still has a reminder stage ahead (the same forecast
// the Reservation panel shows per row), reminders on and not paused.
async function reservationSummary(now) {
  const Reservation = require('../models/offerReservationModel');
  const { EmailPolicy } = require('../models/emailControlModel');
  const { upcomingStage } = require('./reservationReminders');
  const events = ['offer.reservation.dayPassed', 'offer.reservation.reminder', 'offer.reservation.sixHours', 'offer.reservation.lastHour'];
  const policies = await EmailPolicy.find({ event: { $in: events } }).select('event mode').lean();
  const messagesOff = events.filter(event => policies.find(row => row.event === event)?.mode === 'off').length;
  const customers = new Set();
  let scanned = 0, truncated = false, buffer = [];
  const flush = async () => {
    const users = await usersById(buffer.map(row => row.userId), 'isActive deletedAt isGuest');
    for (const row of buffer) if (usable(users.get(String(row.userId))) && upcomingStage(row, now)) customers.add(String(row.userId));
    buffer = [];
  };
  const cursor = Reservation.find({ projectId: null, confirmedAt: null, remindersEnabled: true, remindersPaused: { $ne: true }, startRequestedAt: null,
    $or: [{ extendedUntil: null, expiresAt: { $gt: now } }, { extendedUntil: { $gt: now } }] })
    .select('userId reservedAt expiresAt extendedUntil extensions remindersEnabled remindersPaused remindersSent projectId confirmedAt startRequestedAt startRequests').lean().cursor();
  for await (const row of cursor) {
    if (scanned >= SCAN_LIMIT) { truncated = true; break; }
    scanned += 1; buffer.push(row);
    if (buffer.length >= BATCH) await flush();
  }
  if (buffer.length) await flush();
  return { messagesOff, schedulerEnabled: flag('OFFER_RESERVATION_JOBS_ENABLED') && flag('OFFER_RESERVATION_CONFIRMATIONS_ENABLED'), upcomingCustomers: customers.size, truncated };
}

// Offer and reservation scan their collections, so they are cached for a minute and a failure in one
// never hides the others.
async function legacySummary(now) {
  if (CACHE_MS > 0 && cache && now - cache.at < CACHE_MS) return cache.value;
  const attempt = async fn => { try { return await fn(now); } catch (error) { console.error('[reminder work summary]', error.message); return { unavailable: true }; } };
  const value = { offer_payment: await attempt(offerSummary), reservation: await attempt(reservationSummary), legacyAsOf: now };
  if (CACHE_MS > 0 && !value.offer_payment.unavailable && !value.reservation.unavailable) cache = { at: +now, value };
  return value;
}

async function workSummary({ now = new Date() } = {}) {
  return { ...(await ruleSummary()), ...(await legacySummary(now)) };
}
module.exports = { workSummary, clearCache };
