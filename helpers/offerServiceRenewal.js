const mongoose = require('mongoose');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const { createProjectInvoice } = require('./paymentRecording');
const { modeForCycle, paymentDueDate } = require('./offerPaymentPolicy');
const { getCycleDates, isFixedTenureService, isFinalCycle } = require('./serviceBillingSchedule');

// Advancing work time is distinct from recording money. Old unpaid invoices
// remain collectible; a paid late invoice cannot rewind this cycle or its quota.
async function advanceOfferServiceCycle(orderId, now = new Date()) {
  await mongoose.connection.transaction(async session => {
    const order = await Order.findById(orderId).session(session);
    if (!order?.paymentPolicy || order.orderVisibility === 'cancelled' || order.servicePlanStatus !== 'active' || !order.serviceNextBillingDate || new Date(order.serviceNextBillingDate) > now) return;
    if ((isFixedTenureService(order) && isFinalCycle(order, order.serviceCurrentCycleNumber)) || (order.servicePlanEndDate && new Date(order.servicePlanEndDate) <= now)) {
      order.servicePlanStatus = 'expired'; order.serviceNextBillingDate = null;
      await order.save({ session }); return;
    }
    if (!isFixedTenureService(order) && !order.serviceAutoRenew) {
      order.servicePlanStatus = 'inactive'; order.serviceNextBillingDate = null;
      await order.save({ session }); return;
    }
    const next = Number(order.serviceCurrentCycleNumber || 1) + 1;
    const cycle = getCycleDates(order, next, now);
    const policy = order.paymentPolicy;
    const mode = modeForCycle(order, next);
    const amount = Number(order.serviceCyclePrice || 0);
    if (!(amount > 0)) throw new Error('Service cycle price is missing');
    const key = `${order._id}:${next}`;
    if (!await Invoice.exists({ paymentPolicyKey: key }).session(session)) {
      await createProjectInvoice({ customerId: order.userId, orderId: order._id, amount,
        lineItems: [{ name: `Cycle ${next}: ${order.servicePlanSnapshot.serviceName}`, price: amount }],
        invoiceType: 'plan_renewal', serviceCycleNumber: next, invoiceDate: cycle.start,
        dueDate: mode === 'advance' ? cycle.start : paymentDueDate(policy, cycle.start), session, paymentPolicyKey: key });
    }
    order.serviceCurrentCycleNumber = next;
    order.serviceCurrentCycleStart = cycle.start; order.serviceCurrentCycleEnd = cycle.end;
    order.serviceAccessUsedInCycle = 0;
    order.serviceNextBillingDate = cycle.end;
    order.servicePlanStatus = mode === 'advance' ? 'paused' : 'active';
    await order.save({ session });
  });
}
module.exports = { advanceOfferServiceCycle };
