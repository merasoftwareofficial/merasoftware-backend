const orderModel = require('../models/orderProductModel');

// A service's project activation is owned by the existing project order. No
// second timeline/store is introduced: completion in the node SSOT activates
// only the eligible linked services.
const activateAfterProjectServices = async ({ projectOrderId, actorId, now = new Date() }) => {
  const services = await orderModel.find({
    isServicePlan: true,
    linkedProjectOrderId: projectOrderId,
    servicePlanStatus: 'pending_activation',
    'servicePlanSnapshot.timing': 'after',
    orderVisibility: 'approved',
  });
  for (const service of services) {
    service.servicePlanStatus = 'active';
    service.servicePlanStartDate = now;
    if (service.serviceBillingCycleMonths) {
      const cycleEnd = new Date(now);
      cycleEnd.setMonth(cycleEnd.getMonth() + service.serviceBillingCycleMonths);
      service.serviceCurrentCycleStart = now;
      service.serviceCurrentCycleEnd = cycleEnd;
      service.serviceNextBillingDate = cycleEnd;
      if (service.serviceTenureMonths) {
        const endDate = new Date(now);
        endDate.setMonth(endDate.getMonth() + service.serviceTenureMonths);
        service.servicePlanEndDate = endDate;
      }
    }
    await service.save();
  }
  return services.length;
};

const stopServiceRenewal = async ({ serviceOrderId, userId, now = new Date() }) => {
  const service = await orderModel.findOne({ _id: serviceOrderId, userId, isServicePlan: true });
  if (!service) throw new Error('Service not found');
  if (service.servicePlanStatus !== 'active') throw new Error('Only active services can stop renewal');
  service.serviceAutoRenew = false;
  service.serviceAutoRenewalStoppedAt = now;
  await service.save();
  return service;
};

module.exports = { activateAfterProjectServices, stopServiceRenewal };
