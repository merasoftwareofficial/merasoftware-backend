// SSOT for "is a project order's currently-due installment unpaid right now."
// Extracted from getOrderDetails.js (previously inline there only) so getUserOrder.js's
// list/badge feed uses the exact same due-installment + progressThreshold rule instead of
// its old "ANY unpaid invoice on the order" check, which incorrectly matched future
// installments that aren't due yet.
//
// Project orders only — plans use monthlyInvoiceModel, a separate system, and must not
// be run through this.

// Partial orders created before progressThreshold existed have null on every installment.
// They keep the portal's long-standing 40% / 75% rule for #2 / #3 (ProjectDetails.js), so the
// server and the screen give one answer for them too.
const LEGACY_THRESHOLDS = { 2: 40, 3: 75 };
const installmentThreshold = (installment) =>
  installment.progressThreshold ?? LEGACY_THRESHOLDS[installment.installmentNumber] ?? null;

// Is this installment due right now? Read from the installment itself, never from whether its
// invoice exists: a later installment's invoice is only created when it is paid
// (installmentSettlement.js / projectPaymentSettlement.js), so "no invoice" must not mean
// "nothing due" (merasoftware/src/docs/package.md, decision 17).
function isInstallmentDue(order, installment, now = new Date()) {
  if (!installment || installment.paid) return false;
  const threshold = installmentThreshold(installment);
  return threshold == null || Number(order.projectProgress || 0) >= Number(threshold);
}

// The installment the customer has to pay now, or null.
function dueInstallment(order) {
  if (!Array.isArray(order?.installments) || !order.installments.length) return null;
  const current = order.installments.find((installment) => installment.installmentNumber === order.currentInstallment);
  return isInstallmentDue(order, current) ? current : null;
}

const getDueUnpaidInvoiceFilter = (order) => {
  const filter = { orderId: order._id, invoiceType: 'project', status: { $in: ['unpaid', 'partially_paid', 'overdue'] } };

  if (Array.isArray(order.installments) && order.installments.length > 0) {
    const current = order.installments.find(
      (installment) => installment.installmentNumber === order.currentInstallment
    );
    const isDue = !current || isInstallmentDue(order, current);
    filter.installmentNumber = isDue ? order.currentInstallment : -1;
  }

  return filter;
};

// Is a payment due on this project right now? A due, unpaid installment counts with or without
// an invoice; otherwise an unpaid due invoice (a full-payment project's single bill) counts.
async function isProjectPaymentDue(order, { session = null } = {}) {
  if (dueInstallment(order)) return true;
  const Invoice = require('../models/invoiceModel');
  let query = Invoice.countDocuments(getDueUnpaidInvoiceFilter(order));
  if (session) query = query.session(session);
  return (await query.catch(() => 0)) > 0;
}

module.exports = { getDueUnpaidInvoiceFilter, isInstallmentDue, dueInstallment, isProjectPaymentDue };
