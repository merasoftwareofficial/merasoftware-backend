const cron = require('node-cron');
const orderModel = require('../models/orderProductModel');
const invoiceModel = require('../models/invoiceModel');
const { createProjectInvoice } = require('../helpers/paymentRecording');
const { getNextCycleNumber, isFinalCycle, isFixedTenureService, getCycleDates, resolveServiceRenewalPrice } = require('../helpers/serviceBillingSchedule');
const { syncServiceBillingStatement } = require('../helpers/serviceBillingStatement');
const { planExpired } = require('../helpers/actionEvents');
const { resolvePaymentDueDate } = require('../helpers/paymentDueDate');

// Hard system rule: once a service plan's unpaid invoice passes its dueDate,
// no service or plan remains active — mark invoice overdue and pause the plan.
const pauseOverdueServicePlans = async (now = new Date()) => {
  const overdueInvoices = await invoiceModel.find({
    invoiceType: { $in: ['project', 'plan_renewal'] },
    status: { $in: ['unpaid', 'partially_paid', 'overdue'] },
    dueDate: { $lte: now },
  }).select('_id orderId status amount amountPaid').lean();
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

  let pausedCount = 0;
  for (const plan of activePlans) {
    plan.servicePlanStatus = 'paused';
    await plan.save();
    await syncServiceBillingStatement(plan).catch(() => {});
    pausedCount += 1;
  }
  return pausedCount;
};

const processServicePlanRenewals = async (now = new Date()) => {
  await pauseOverdueServicePlans(now);
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
    await createProjectInvoice({ customerId: service.userId, orderId: service._id, amount, lineItems: [{ name: `Cycle ${cycleNumber}: ${service.orderItems?.[0]?.name || 'Service'}`, price: amount }], invoiceDate: now, dueDate, invoiceType: 'plan_renewal', serviceCycleNumber: cycleNumber });
    if (dueDate.getTime() > now.getTime()) {
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
module.exports = { processServicePlanRenewals, pauseOverdueServicePlans, scheduleServicePlanRenewals };
