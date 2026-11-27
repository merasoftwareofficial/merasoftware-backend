const { isFinalCycle, getNextCycleNumber, resolveServiceRenewalPrice } = require('./serviceBillingSchedule');
const { resolvePaymentDueDate, resolveGraceCutoff } = require('./paymentDueDate');

// No writes or sends. A candidate identifies one cycle whether its invoice has
// been created yet or not. Legacy offer-policy orders are deliberately excluded
// until ownership between the two reminder systems can be proven non-overlapping.
function packageReminderCandidate(order, invoice = null, { includeStandalonePlans = false } = {}) {
  if (!order?.isServicePlan || order.orderVisibility === 'cancelled' || order.paymentPolicy) return null;
  if (!includeStandalonePlans && !order.salesPackage?.package?.id) return null;
  if (invoice) {
    if (!['active', 'paused', 'expired'].includes(order.servicePlanStatus) || String(invoice.orderId) !== String(order._id)) return null;
    if (invoice.invoiceType !== 'plan_renewal' || !['unpaid', 'partially_paid', 'overdue'].includes(invoice.status)) return null;
    const amount = Math.max(0, Number(invoice.amount || 0) - Number(invoice.amountPaid || 0));
    const cycle = Number(invoice.serviceCycleNumber), due = new Date(invoice.dueDate);
    if (!invoice._id || !invoice.dueDate || !(amount > 0) || !Number.isInteger(cycle) || cycle < 2 || !Number.isFinite(+due)) return null;
    const graceEndDate = resolveGraceCutoff({ order, dueDate: due });
    return { orderId: String(order._id), cycle, due, graceEndDate, amount, invoiceId: String(invoice._id), projected: false };
  }
  if (order.servicePlanStatus !== 'active' || order.serviceAutoRenewalStoppedAt || isFinalCycle(order, order.serviceCurrentCycleNumber)) return null;
  const cycle = getNextCycleNumber(order), amount = resolveServiceRenewalPrice(order);
  const due = order.serviceNextBillingDate ? resolvePaymentDueDate({ order, invoiceDate: new Date(order.serviceNextBillingDate), cycleNumber: cycle }) : null;
  if (!order.serviceNextBillingDate || !Number.isInteger(cycle) || cycle < 2 || !due || !Number.isFinite(+due) || !(amount > 0)) return null;
  const graceEndDate = resolveGraceCutoff({ order, dueDate: due });
  return { orderId: String(order._id), cycle, due, graceEndDate, amount, invoiceId: null, projected: true };
}
module.exports = { packageReminderCandidate };
