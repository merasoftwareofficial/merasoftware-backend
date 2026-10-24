// SSOT for "is a project order's currently-due installment unpaid right now."
// Extracted from getOrderDetails.js (previously inline there only) so getUserOrder.js's
// list/badge feed uses the exact same due-installment + progressThreshold rule instead of
// its old "ANY unpaid invoice on the order" check, which incorrectly matched future
// installments that aren't due yet.
//
// Project orders only — plans use monthlyInvoiceModel, a separate system, and must not
// be run through this.
const getDueUnpaidInvoiceFilter = (order) => {
  const filter = { orderId: order._id, invoiceType: 'project', status: { $in: ['unpaid', 'partially_paid', 'overdue'] } };

  if (Array.isArray(order.installments) && order.installments.length > 0) {
    const dueInstallment = order.installments.find(
      (installment) => installment.installmentNumber === order.currentInstallment
    );
    const isDue = !dueInstallment
      || dueInstallment.progressThreshold == null
      || Number(order.projectProgress || 0) >= Number(dueInstallment.progressThreshold);
    filter.installmentNumber = isDue ? order.currentInstallment : -1;
  }

  return filter;
};

module.exports = { getDueUnpaidInvoiceFilter };
