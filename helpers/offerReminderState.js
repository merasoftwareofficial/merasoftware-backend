const { DAY } = require('./offerPaymentPolicy');
const { isInstallmentDue } = require('./projectDuePayment');

// Why an open offer invoice has no payment reminder coming ('' when one can still be due) and its next
// milestone. One place for the admin list and the work summary, so a count can never disagree with a row.
// The worker (offerPaymentReminderEligibility) stays authoritative for every delivery decision.
function offerReminderState(invoice, order, customer, now, reason = '') {
  if (!reason && order.isServicePlan && Number(invoice.serviceCycleNumber) > 1 && order.paymentPolicy.cycleScope !== 'every_cycle') reason = 'Offer terms apply to the first cycle only.';
  else if (!reason && invoice.installmentNumber && invoice.installmentNumber !== order.currentInstallment) reason = 'This is not the current installment.';
  else if (!reason && invoice.installmentNumber) {
    const installment = (order.installments || []).find(item => item.installmentNumber === invoice.installmentNumber);
    if (installment && !isInstallmentDue(order, installment, now)) reason = 'This installment is not due yet.';
  }
  if (!reason && (!customer?.email || customer.isActive === false || customer.deletedAt)) reason = 'Customer account or email is unavailable.';
  const offsets = order.paymentPolicy.reminderOffsets || [];
  if (!reason && !offsets.length) reason = 'No reminder days in the saved agreement.';
  const due = new Date(invoice.dueDate);
  const future = Number.isFinite(+due) ? offsets.map(offset => ({ offset, at: new Date(+due + offset * DAY) })).filter(item => item.at > now).sort((a, b) => a.at - b.at) : [];
  return { reason, offsets, nextMilestone: reason ? null : future[0] || null };
}
module.exports = { offerReminderState };
