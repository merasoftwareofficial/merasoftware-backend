const { randomUUID } = require('node:crypto');
const Rule = require('../models/communicationReminderRuleModel');
const Run = require('../models/communicationReminderRunModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const { getNextCycleNumber } = require('./serviceBillingSchedule');
const { planPackageRuns, persistPackageRuns } = require('./packageReminderSchedule');
const { dispatchReminder } = require('./communicationReminderDispatch');

const LEASE_MS = 120000;
async function processMonthlyRule(ruleId, now = new Date()) {
  const owner = randomUUID();
  const clock = () => new Date();
  const rule = await Rule.findOneAndUpdate({ _id: ruleId, enabled: true, source: 'monthly_package',
    $or: [{ workerLeaseUntil: null }, { workerLeaseUntil: { $lte: clock() } }] },
  { $set: { workerLeaseOwner: owner, workerLeaseUntil: new Date(Date.now() + LEASE_MS) } }, { new: true }).lean();
  if (!rule) return { claimed: false, planned: 0, dispatched: 0 };
  const owns = () => Rule.exists({ _id: rule._id, enabled: true, revision: rule.revision, workerLeaseOwner: owner, workerLeaseUntil: { $gt: clock() } });
  const renew = setInterval(() => { Rule.updateOne({ _id: rule._id, enabled: true, revision: rule.revision, workerLeaseOwner: owner }, { $set: { workerLeaseUntil: new Date(Date.now() + LEASE_MS) } }).catch(error => console.error('[reminder worker] lease:', error.message)); }, 30000);
  renew.unref?.();
  let planned = 0, dispatched = 0;
  try {
    const cursor = Order.find({ isServicePlan: true, 'salesPackage.package.id': { $exists: true, $ne: null }, paymentPolicy: null,
      orderVisibility: { $ne: 'cancelled' }, servicePlanStatus: { $in: ['active', 'paused', 'expired'] } }).cursor();
    for await (const order of cursor) {
      if (!await owns()) break;
      const invoices = await Invoice.find({ orderId: order._id, invoiceType: 'plan_renewal' }).lean();
      const nextCycle = getNextCycleNumber(order);
      const candidates = invoices.filter(invoice => ['unpaid', 'partially_paid', 'overdue'].includes(invoice.status));
      if (!invoices.some(invoice => Number(invoice.serviceCycleNumber) === nextCycle)) candidates.push(null);
      for (const invoice of candidates) {
        const plans = planPackageRuns(rule, order, invoice);
        await persistPackageRuns(plans); planned += plans.length;
      }
      for (const invoice of invoices.filter(row => ['paid', 'cancelled'].includes(row.status))) {
        await Run.updateMany({ ruleId: rule._id, ruleRevision: rule.revision, occurrenceKey: `${order._id}:${invoice.serviceCycleNumber}`, status: 'scheduled' }, { $set: { status: 'cancelled', reason: 'Invoice settled or cancelled.' } });
      }
      if (order.serviceAutoRenewalStoppedAt && !invoices.some(invoice => Number(invoice.serviceCycleNumber) === nextCycle)) {
        await Run.updateMany({ ruleId: rule._id, ruleRevision: rule.revision, occurrenceKey: `${order._id}:${nextCycle}`, status: 'scheduled' }, { $set: { status: 'cancelled', reason: 'Renewal stopped.' } });
      }
    }
    if (!await owns()) return { claimed: true, planned, dispatched, leaseLost: true };
    // On a missed scheduler interval, process only the latest due step per
    // occurrence; older scheduled stages are marked skipped to avoid bursts.
    const eligible = await Run.aggregate([
      { $match: { ruleId: rule._id, ruleRevision: rule.revision, dueAt: { $lte: now }, $or: [{ status: 'scheduled' }, { status: 'preparing', lockUntil: { $lte: new Date() } }] } },
      { $sort: { occurrenceKey: 1, dueAt: -1, step: -1 } },
      { $group: { _id: '$occurrenceKey', latest: { $first: '$$ROOT' } } },
      // Exclude waiting invoices before the batch limit so they cannot starve
      // unrelated customers whose reminders are ready to send.
      { $lookup: { from: Invoice.collection.name, let: { order: '$latest.entityId', cycle: '$latest.cycle' }, pipeline: [
        { $match: { invoiceType: 'plan_renewal', $expr: { $and: [{ $eq: ['$orderId', '$$order'] }, { $eq: ['$serviceCycleNumber', '$$cycle'] }] } } }, { $limit: 1 },
      ], as: 'renewalInvoice' } },
      { $match: { $or: [{ 'latest.anchorAt': { $gt: now } }, { 'renewalInvoice.0': { $exists: true } }] } },
      { $sort: { 'latest.dueAt': 1 } }, { $limit: 100 },
    ]);
    for (const entry of eligible) {
      if (!await owns()) break;
      const run = entry.latest;
      // Billing may create the renewal invoice after its projected boundary.
      // Keep the occurrence pending until that happens; cancelling it here
      // would permanently lose the due-day reminder on a slow billing run.
      if (run.anchorAt && new Date(run.anchorAt) <= now) {
        const invoice = await Invoice.exists({ orderId: run.entityId, invoiceType: 'plan_renewal', serviceCycleNumber: run.cycle });
        if (!invoice) continue;
      }
      const later = await Run.exists({ ruleId: rule._id, ruleRevision: rule.revision, occurrenceKey: run.occurrenceKey, dueAt: { $gt: run.dueAt, $lte: now }, status: { $in: ['preparing', 'queued', 'sent', 'partial', 'unknown', 'failed', 'expired', 'cancelled', 'skipped'] } });
      if (later) { await Run.updateOne({ _id: run._id, status: { $in: ['scheduled', 'preparing'] } }, { $set: { status: 'skipped', reason: 'A later reminder stage was already processed.' }, $unset: { lockOwner: 1, lockUntil: 1, workerLeaseOwner: 1 } }); continue; }
      await Run.updateMany({ ruleId: rule._id, ruleRevision: rule.revision, occurrenceKey: run.occurrenceKey, dueAt: { $lt: run.dueAt }, status: 'scheduled' }, { $set: { status: 'skipped', reason: 'A later reminder stage is due.' } });
      if (!await owns()) break;
      await dispatchReminder(run._id, now, owner); dispatched++;
    }
    return { claimed: true, planned, dispatched };
  } finally {
    clearInterval(renew);
    await Rule.updateOne({ _id: rule._id, workerLeaseOwner: owner }, { $unset: { workerLeaseOwner: 1, workerLeaseUntil: 1 } });
  }
}
async function processCommunicationReminders(now = new Date()) {
  if (process.env.COMMUNICATION_REMINDER_JOBS_ENABLED !== 'true') return { enabled: false, rules: 0 };
  const reconciled = await require('./communicationReminderReconcile').reconcilePendingReminders();
  if (process.env.ENABLE_CRONS !== 'true') return { enabled: true, billingEnabled: false, reconciled, rules: 0 };
  const rules = await Rule.find({ enabled: true, source: { $in: ['monthly_package', 'broadcast'] } }).select('_id source').lean();
  for (const rule of rules) {
    if (rule.source === 'broadcast') await require('./broadcastReminderWorker').processBroadcastRule(rule._id, now);
    else await processMonthlyRule(rule._id, now);
  }
  return { enabled: true, billingEnabled: true, reconciled, rules: rules.length };
}
module.exports = { processMonthlyRule, processCommunicationReminders };
