const invoiceModel = require("../models/invoiceModel");
const transactionModel = require("../models/transactionModel");
const generateInvoiceNumber = require("./generateInvoiceNumber");
const { getOrderDisplayName } = require("./orderPresentation");
// Payment SSOT — what has actually been received is derived from completed transactions.
const { getInvoiceAmountReceived, deriveInvoiceStatus } = require("./orderPaymentTotals");
const { prepareUpiPaymentEvidence } = require("./upiPaymentEvidence");

const getOrderTotal = (order) =>
  Number(order?.totalAmount || order?.totalPrice || order?.price || 0);

// Invoice line items derived from an order's own orderItems snapshot, so the invoice mirrors
// exactly what the customer ordered (base + each feature). Shared SSOT — used by every path that
// creates a project invoice on demand (approveProjectOrder.js, walletPayInstant.js's due-based
// installment invoice creation, doc 52 Phase 3).
const buildLineItemsFromOrder = (order) => {
  if (Array.isArray(order?.orderItems) && order.orderItems.length > 0) {
    return order.orderItems.map((item) => ({
      name: item.name,
      price: Number(item.finalPrice ?? item.originalPrice ?? 0),
    }));
  }
  return [{ name: getOrderDisplayName(order, "Project"), price: getOrderTotal(order) }];
};

// Shared payment-recording SSOT for admin-created / admin-approved custom projects.
//
// Extracted verbatim from adminCreateProjectOrder.js so the create-project flow and the
// project-approval flow record payment through the exact same logic (one transaction,
// one invoice, no duplicate systems).
//
// Deliberately NOT the recurring-plan markInvoicePaidAndResumePlan() helper
// (invoiceLifecycle.js), which is hardcoded to monthlyInvoiceModel and also runs
// plan-resume logic that does not apply to one-time / installment projects.

// Settles money against a project invoice (invoiceModel). This is the ONE shared place that
// changes an invoice's paid-state — status is always DERIVED from invoice.amountPaid vs
// invoice.amount, never hardcoded by a caller (SSOT — see doc 52).
//
//   - amount: how much is being applied NOW (defaults to the invoice's full amount, so existing
//     full-payment callers are unchanged). Pass a smaller amount for a partial/wallet-only part
//     of a combined wallet+UPI payment.
//   - existingTransaction: when the caller already created the completed transaction for this
//     money (e.g. deductWalletInstant's wallet debit), pass it here so this helper links it
//     instead of creating a second transaction for the same payment. Omit to have this helper
//     create the transaction itself (the original admin "Record Payment" / approval behaviour).
const markProjectInvoicePaid = async ({
  invoice,
  customerId,
  paymentMethod,
  transactionReference,
  notes,
  actorId,
  amount,
  existingTransaction = null,
}) => {
  const amountNow = Number(amount != null ? amount : invoice.amount);

  let transaction = existingTransaction;
  if (!transaction) {
    const transactionId = `INVPAID${String(invoice.invoiceNumber).replace(/[^a-zA-Z0-9]/g, "")}${Date.now()}`;
    const paymentEvidence = paymentMethod === "upi"
      ? await prepareUpiPaymentEvidence({ reference: transactionReference, transactionId, capturedVia: "admin" })
      : undefined;
    transaction = await transactionModel.create({
      userId: customerId,
      orderId: invoice.orderId,
      invoiceId: invoice._id,
      transactionId,
      upiTransactionId: transactionReference || null,
      paymentEvidence,
      amount: amountNow,
      status: "completed",
      paymentStatus: "approved",
      type: "payment",
      sourceType: "invoice",
      description: `Payment recorded for invoice ${invoice.invoiceNumber}`,
      paymentMethod: paymentMethod || "cash",
      verifiedBy: actorId,
      verificationDate: new Date(),
      date: new Date(),
    });
  } else if (!transaction.invoiceId) {
    // Link a pre-existing transaction (e.g. a wallet debit) to this invoice if not linked yet.
    transaction.invoiceId = invoice._id;
    await transaction.save();
  }

  // Payment SSOT (helpers/orderPaymentTotals.js): what an invoice has been paid is DERIVED from
  // the completed transactions pointing at it — never accumulated blindly. Was:
  // `amountPaid += amountNow`, which trusted the caller's arithmetic and silently drifted the
  // moment a caller ran twice, or ran and then threw. That is exactly how a service invoice was
  // credited for a payment that was still pending approval: the invoice read PAID while its only
  // transaction was 'pending', leaving the order permanently unapprovable. Deriving makes a
  // repeated call idempotent (the same transaction is counted once, not twice) and makes it
  // impossible for uncompleted money to appear as paid.
  const linkedCount = await transactionModel.countDocuments({ invoiceId: invoice._id });
  const derived = await getInvoiceAmountReceived(invoice._id);
  // The fallback applies ONLY when no transaction points at this invoice at all (a legacy
  // caller settling an invoice without a payment row). It must never trigger merely because the
  // derived total is 0 — a linked payment that is still pending derives to exactly 0, and
  // falling back there would credit the invoice for money that has not arrived, recreating the
  // original bug.
  invoice.amountPaid = Math.min(
    Number(invoice.amount || 0),
    linkedCount > 0 ? derived : Number(invoice.amountPaid || 0) + amountNow
  );
  invoice.status = deriveInvoiceStatus(invoice.amountPaid, invoice.amount);
  if (invoice.status === "paid") {
    invoice.paidDate = new Date();
  }
  invoice.paymentMethod = paymentMethod || invoice.paymentMethod || "cash";
  invoice.transactionReference = transactionReference || invoice.transactionReference || null;
  invoice.markedPaidBy = actorId || invoice.markedPaidBy || null;
  if (notes) invoice.notes = notes;
  await invoice.save();

  return { invoice, transaction };
};

// Reverses a previously-applied wallet portion when its linked UPI remainder is
// rejected. This is deliberately the counterpart of markProjectInvoicePaid:
// amountPaid, status and paidDate are derived from the remaining settled amount,
// never assigned by a caller.
const reverseProjectInvoicePayment = async ({ invoice, amount }) => {
  const amountNow = Number(amount || 0);
  if (!invoice || !(amountNow > 0)) return invoice;

  // Same SSOT as markProjectInvoicePaid: re-derive from the completed transactions that remain
  // rather than subtracting the caller's figure. By the time this runs the reversed payment is
  // no longer 'completed', so it drops out of the sum on its own — which also makes a repeated
  // reversal idempotent instead of subtracting the same money twice.
  const linkedCount = await transactionModel.countDocuments({ invoiceId: invoice._id });
  const derived = await getInvoiceAmountReceived(invoice._id);
  // Same rule as markProjectInvoicePaid: derive whenever this invoice has payment rows — a
  // fully reversed invoice legitimately derives to 0, so "derived is 0" must not send us down
  // the blind-subtraction path.
  invoice.amountPaid = Math.max(
    0,
    linkedCount > 0 ? derived : Number(invoice.amountPaid || 0) - amountNow
  );
  invoice.status = deriveInvoiceStatus(invoice.amountPaid, invoice.amount);
  if (invoice.status !== "paid") invoice.paidDate = null;
  await invoice.save();
  return invoice;
};

// Creates one project invoice on the shared invoiceModel (invoiceType: "project").
// Used both at create-time (adminCreateProjectOrder) and at approval-time for a
// Pay-Later order that was created without any invoice, so a single invoice model
// backs every project regardless of how it entered the system.
const createProjectInvoice = async ({
  customerId,
  orderId,
  amount,
  lineItems,
  installmentNumber,
  serviceCycleNumber,
  invoiceDate = new Date(),
  dueDate,
  invoiceType = "project",
}) => {
  const invoiceNumber = await generateInvoiceNumber();
  return invoiceModel.create({
    userId: customerId,
    orderId,
    invoiceNumber,
    invoiceType,
    amount,
    status: "unpaid",
    invoiceDate,
    dueDate: dueDate || invoiceDate,
    ...(installmentNumber ? { installmentNumber } : {}),
    ...(serviceCycleNumber ? { serviceCycleNumber } : {}),
    lineItems,
  });
};

module.exports = {
  markProjectInvoicePaid,
  reverseProjectInvoicePayment,
  createProjectInvoice,
  buildLineItemsFromOrder,
};
