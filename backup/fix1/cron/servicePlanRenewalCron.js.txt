const cron = require('node-cron');
const orderModel = require('../models/orderProductModel');
const invoiceModel = require('../models/invoiceModel');
const { createProjectInvoice } = require('../helpers/paymentRecording');
const { getNextCycleNumber, isFinalCycle, isFixedTenureService, getCycleDates } = require('../helpers/serviceBillingSchedule');
const { syncServiceBillingStatement } = require('../helpers/serviceBillingStatement');

const resolveRenewalPrice = (service) => {
  const snapshot = service.servicePlanSnapshot || {};
  return Number((snapshot.billingOptions || []).find((item) => item.billingCycle === service.serviceSelectedBillingCycle)?.pricePerCycle || 0);
};

const processServicePlanRenewals = async (now = new Date()) => {
  const dueServices = await orderModel.find({ isServicePlan: true, servicePlanStatus: 'active', serviceNextBillingDate: { $lte: now } });
  for (const service of dueServices) {
    // New fixed-tenure services must complete every contracted cycle. Old records
    // without serviceTotalCycles retain their pre-existing auto-renew behaviour.
    if (isFixedTenureService(service) && isFinalCycle(service, service.serviceCurrentCycleNumber)) {
      service.servicePlanStatus = 'expired';
      service.serviceNextBillingDate = null;
      await service.save();
      await syncServiceBillingStatement(service);
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
    const amount = resolveRenewalPrice(service);
    if (!(amount > 0)) continue;
    const cycleNumber = getNextCycleNumber(service);
    const cycle = getCycleDates(service, cycleNumber, now);
    await createProjectInvoice({ customerId: service.userId, orderId: service._id, amount, lineItems: [{ name: `Cycle ${cycleNumber}: ${service.orderItems?.[0]?.name || 'Service'}`, price: amount }], invoiceDate: now, dueDate: now, invoiceType: 'plan_renewal', serviceCycleNumber: cycleNumber });
    service.servicePlanStatus = 'paused';
    await service.save();
  }
};

const scheduleServicePlanRenewals = () => cron.schedule('5 1 * * *', () => processServicePlanRenewals().catch((error) => console.error('Service renewal cron failed:', error.message)), { timezone: 'Asia/Kolkata' });
module.exports = { processServicePlanRenewals, scheduleServicePlanRenewals };
