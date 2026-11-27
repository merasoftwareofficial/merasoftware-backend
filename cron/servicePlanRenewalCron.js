const cron = require('node-cron');
const orderModel = require('../models/orderProductModel');
const invoiceModel = require('../models/invoiceModel');
const { createProjectInvoice } = require('../helpers/paymentRecording');
const { getNextCycleNumber, isFinalCycle, isFixedTenureService, getCycleDates, resolveServiceRenewalPrice } = require('../helpers/serviceBillingSchedule');
const { syncServiceBillingStatement } = require('../helpers/serviceBillingStatement');
const { planExpired } = require('../helpers/actionEvents');
const { resolvePaymentDueDate, resolveGraceCutoff, resolveDueDaysFromOrder, resolveGraceEndAction } = require('../helpers/paymentDueDate');

// Hard system rule: once a service plan's unpaid invoice passes its dueDate, mark it overdue.
// Pause the plan once dueDate + unpaid grace days (graceCutoff) passes.
const pauseOverdueServicePlans = async (now = new Date()) => {
  const nowMs = new Date(now).getTime();
  const overdueInvoices = await invoiceModel.find({
    invoiceType: { $in: ['project', 'plan_renewal'] },
    status: { $in: ['unpaid', 'partially_paid', 'overdue'] },
    dueDate: { $lte: now },
  }).select('_id orderId status amount amountPaid dueDate').lean();
  const unpaidOverdue = overdueInvoices.filter((inv) => Number(inv.amount || 0) > Number(inv.amountPaid || 0));
  if (!unpaidOverdue.length) return 0;

  const orderIds = [...new Set(unpaidOverdue.map((inv) => String(inv.orderId)).filter(Boolean))];
  const activePlans = await orderModel.find({
    _id: { $in: orderIds },
    isServicePlan: true,
    orderVisibility: 'approved',
    servicePlanStatus: 'active',
  });
  if (!activePlans.length) return 0;

  const activeOrderSet = new Set(activePlans.map((o) => String(o._id)));
  const markOverdueIds = unpaidOverdue
    .filter((inv) => inv.status === 'unpaid' && activeOrderSet.has(String(inv.orderId)))
    .map((inv) => inv._id);
  if (markOverdueIds.length) {
    await invoiceModel.updateMany({ _id: { $in: markOverdueIds }, status: 'unpaid' }, { $set: { status: 'overdue' } });
  }

  const invByOrder = new Map();
  for (const inv of unpaidOverdue) {
    const oid = String(inv.orderId);
    const prev = invByOrder.get(oid);
    if (!prev || new Date(inv.dueDate).getTime() < new Date(prev.dueDate).getTime()) invByOrder.set(oid, inv);
  }

  let pausedCount = 0;
  for (const plan of activePlans) {
    const inv = invByOrder.get(String(plan._id));
    const cutoff = resolveGraceCutoff({ order: plan, invoice: inv });
    if (cutoff && cutoff.getTime() > nowMs) continue;
    plan.servicePlanStatus = 'paused';
    await plan.save();
    await syncServiceBillingStatement(plan).catch(() => {});
    pausedCount += 1;
  }
  return pausedCount;
};

// Optional one-time package rule: when graceDays > 0 and graceEndAction === 'auto_cancel',
// cancel strictly zero-payment orders with no pending UPI once max(dueDate, createdAt) + graceDays <= now.
// Orders with any payment (paidAmount > 0) are NEVER auto-cancelled.
const expireUnpaidOneTimeProjects = async (now = new Date()) => {
  const nowMs = new Date(now).getTime();
  const overdueInvoices = await invoiceModel.find({
    invoiceType: 'project',
    status: { $in: ['unpaid', 'overdue'] },
    dueDate: { $lte: now },
    amount: { $gt: 0 },
  }).select('_id orderId status amount amountPaid dueDate').lean();
  const zeroPaid = overdueInvoices.filter((inv) => Number(inv.amountPaid || 0) <= 0);
  if (!zeroPaid.length) return 0;

  const orderIds = [...new Set(zeroPaid.map((inv) => String(inv.orderId)).filter(Boolean))];
  const candidates = await orderModel.find({
    _id: { $in: orderIds },
    isServicePlan: { $ne: true },
    orderVisibility: { $in: ['approved', 'visible'] },
    $or: [{ paidAmount: { $lte: 0 } }, { paidAmount: { $exists: false } }],
  });
  if (!candidates.length) return 0;

  const invByOrder = new Map();
  for (const inv of zeroPaid) {
    const oid = String(inv.orderId);
    const prev = invByOrder.get(oid);
    if (!prev || new Date(inv.dueDate).getTime() < new Date(prev.dueDate).getTime()) invByOrder.set(oid, inv);
  }

  const Transaction = require('../models/transactionModel');
  let cancelledCount = 0;
  for (const order of candidates) {
    if (Number(order.paidAmount || 0) > 0) continue;
    const graceDays = resolveDueDaysFromOrder(order);
    if (!(graceDays > 0) || resolveGraceEndAction(order) !== 'auto_cancel') continue;
    const inv = invByOrder.get(String(order._id));
    if (!inv) continue;
    const cutoff = resolveGraceCutoff({ order, invoice: inv, graceDays, protectBackdated: true });
    if (!cutoff || cutoff.getTime() > nowMs) continue;
    const hasPendingUpi = await Transaction.exists({ orderId: order._id, status: 'pending', paymentStatus: 'pending-approval' });
    if (hasPendingUpi) continue;
    order.orderVisibility = 'cancelled';
    await order.save();
    await invoiceModel.updateMany(
      { orderId: order._id, invoiceType: 'project', status: { $in: ['unpaid', 'overdue'] }, amountPaid: { $lte: 0 } },
      { $set: { status: 'cancelled' } },
    );
    cancelledCount += 1;
  }
  return cancelledCount;
};

const processServicePlanRenewals = async (now = new Date()) => {
  await pauseOverdueServicePlans(now);
  await expireUnpaidOneTimeProjects(now);
  const dueServices = await orderModel.find({ isServicePlan: true, servicePlanStatus: 'active', serviceNextBillingDate: { $lte: now } });
  for (const service of dueServices) {
    // The client stopped it (serviceLifecycle.js stopServiceRenewal, like a subscription): the paid cycle runs to
    // its end, then the plan ends with no further bill, whatever length was bought (src/docs/monthlypackage.md).
    if (service.serviceAutoRenewalStoppedAt) {
      service.servicePlanStatus = 'expired';
      service.serviceNextBillingDate = null;
      await service.save();
      await syncServiceBillingStatement(service);
      await planExpired(service).catch(() => {});
      continue;
    }
    if (service.paymentPolicy) {
      await require('../helpers/offerServiceRenewal').advanceOfferServiceCycle(service._id, now);
      continue;
    }
    // New fixed-tenure services must complete every contracted cycle. Old records
    // without serviceTotalCycles retain their pre-existing auto-renew behaviour.
    if (isFixedTenureService(service) && isFinalCycle(service, service.serviceCurrentCycleNumber)) {
      service.servicePlanStatus = 'expired';
      service.serviceNextBillingDate = null;
      await service.save();
      await syncServiceBillingStatement(service);
      await planExpired(service).catch(() => {});
      continue;
    }
    if (!isFixedTenureService(service) && !service.serviceAutoRenew) {
      service.servicePlanStatus = 'inactive';
      await service.save();
      continue;
    }
    const existing = await invoiceModel.findOne({ orderId: service._id, invoiceType: 'plan_renewal', status: { $in: ['unpaid', 'partially_paid', 'overdue'] } });
    if (existing) {
      service.servicePlanStatus = 'paused';
      await service.save();
      continue;
    }
    const amount = resolveServiceRenewalPrice(service);
    if (!(amount > 0)) continue;
    const cycleNumber = getNextCycleNumber(service);
    const cycle = getCycleDates(service, cycleNumber, now);
    const dueDate = resolvePaymentDueDate({ order: service, invoiceDate: now, cycleNumber });
    const graceCutoff = resolveGraceCutoff({ order: service, dueDate });
    await createProjectInvoice({ customerId: service.userId, orderId: service._id, amount, lineItems: [{ name: `Cycle ${cycleNumber}: ${service.orderItems?.[0]?.name || 'Service'}`, price: amount }], invoiceDate: now, dueDate, invoiceType: 'plan_renewal', serviceCycleNumber: cycleNumber });
    if (graceCutoff && graceCutoff.getTime() > now.getTime()) {
      service.serviceCurrentCycleNumber = cycleNumber;
      service.serviceCurrentCycleStart = cycle.start;
      service.serviceCurrentCycleEnd = cycle.end;
      service.serviceAccessUsedInCycle = 0;
      service.serviceNextBillingDate = cycle.end;
      service.servicePlanStatus = 'active';
    } else {
      service.servicePlanStatus = 'paused';
    }
    await service.save();
  }
};

const scheduleServicePlanRenewals = () => cron.schedule('5 1 * * *', () => processServicePlanRenewals().catch((error) => console.error('Service renewal cron failed:', error.message)), { timezone: 'Asia/Kolkata' });
module.exports = { processServicePlanRenewals, pauseOverdueServicePlans, expireUnpaidOneTimeProjects, scheduleServicePlanRenewals };
