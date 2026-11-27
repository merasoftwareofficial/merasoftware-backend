const { isFinalCycle, getNextCycleNumber, resolveServiceRenewalPrice } = require('./serviceBillingSchedule');
const { resolvePaymentDueDate } = require('./paymentDueDate');

// No writes or sends. A candidate identifies one cycle whether its invoice has
// been created yet or not. Legacy offer-policy orders are deliberately excluded
// until ownership between the two reminder systems can be proven non-overlapping.
function packageReminderCandidate(order, invoice = null) {
  if (!order?.isServicePlan || !order.salesPackage?.package?.id || order.orderVisibility === 'cancelled' || order.paymentPolicy) return null;
  if (invoice) {
    if (!['active', 'paused', 'expired'].includes(order.servicePlanStatus) || String(invoice.orderId) !== String(order._id)) return null;
    if (invoice.invoiceType !== 'plan_renewal' || !['unpaid', 'partially_paid', 'overdue'].includes(invoice.status)) return null;
    const amount = Math.max(0, Number(invoice.amount || 0) - Number(invoice.amountPaid || 0));
    const cycle = Number(invoice.serviceCycleNumber), due = new Date(invoice.dueDate);
    if (!invoice._id || !invoice.dueDate || !(amount > 0) || !Number.isInteger(cycle) || cycle < 2 || !Number.isFinite(+due)) return null;
    return { orderId: String(order._id), cycle, due, amount, invoiceId: String(invoice._id), projected: false };
  }
  if (order.servicePlanStatus !== 'active' || order.serviceAutoRenewalStoppedAt || isFinalCycle(order, order.serviceCurrentCycleNumber)) return null;
  const cycle = getNextCycleNumber(order), amount = resolveServiceRenewalPrice(order);
  const due = order.serviceNextBillingDate ? resolvePaymentDueDate({ order, invoiceDate: new Date(order.serviceNextBillingDate), cycleNumber: cycle }) : null;
  if (!order.serviceNextBillingDate || !Number.isInteger(cycle) || cycle < 2 || !due || !Number.isFinite(+due) || !(amount > 0)) return null;
  return { orderId: String(order._id), cycle, due, amount, invoiceId: null, projected: true };
}
module.exports = { packageReminderCandidate };
