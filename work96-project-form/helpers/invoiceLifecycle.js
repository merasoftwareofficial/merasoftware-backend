const monthlyInvoiceModel = require("../models/monthlyInvoiceModel");
const orderProductModel = require("../models/orderProductModel");
const transactionModel = require("../models/transactionModel");
const { prepareUpiPaymentEvidence } = require("./upiPaymentEvidence");

const isMonthlyPlan = (order) =>
  Boolean(order?.productId?.isMonthlyRenewablePlan || order?.productId?.isMonthlyLimitedPlan);

const pauseOrderForOverdueInvoice = async (order, session = null) => {
  if (!order || !isMonthlyPlan(order) || order.planStatus === "closed") {
    return false;
  }

  order.isActive = false;
  order.autoRenewalStatus = "paused";
  await order.save({ session });
  return true;
};

const resumeOrderForPaidInvoice = async (order, session = null) => {
  if (!order || !isMonthlyPlan(order) || order.planStatus === "closed") {
    return false;
  }

  if (order.totalYearlyDaysRemaining !== undefined && order.totalYearlyDaysRemaining <= 0) {
    order.isActive = false;
    order.autoRenewalStatus = "expired";
    await order.save({ session });
    return false;
  }

  const expiryDate = order.currentMonthExpiryDate ? new Date(order.currentMonthExpiryDate) : null;
  if (expiryDate && expiryDate.getTime() <= Date.now()) {
    return false;
  }

  // Don't resume while a different invoice on this same order is still unpaid/overdue — the
  // invoice being settled here has already been saved as "paid" by the caller before this runs,
  // so it never matches this query itself.
  const stillOverdue = await monthlyInvoiceModel
    .exists({ orderId: order._id, status: { $in: ["unpaid", "overdue"] } })
    .session(session);
  if (stillOverdue) {
    return false;
  }

  order.isActive = true;
  order.autoRenewalStatus = "active";
  await order.save({ session });
  return true;
};

const updateOverdueInvoicesAndPausePlans = async ({ now = new Date(), session = null } = {}) => {
  const overdueInvoices = await monthlyInvoiceModel
    .find({
      status: "unpaid",
      dueDate: { $lt: now },
    })
    .populate({
      path: "orderId",
      populate: { path: "productId" },
    })
    .session(session);

  const results = [];

  for (const invoice of overdueInvoices) {
    invoice.status = "overdue";
    await invoice.save({ session });

    const planPaused = await pauseOrderForOverdueInvoice(invoice.orderId, session);
    results.push({
      invoiceId: invoice._id,
      orderId: invoice.orderId?._id,
      invoiceNumber: invoice.invoiceNumber,
      planPaused,
    });
  }

  return {
    processed: results.length,
    results,
  };
};

const generateInvoiceTransactionId = (invoice) => {
  const invoiceKey = String(invoice?.invoiceNumber || invoice?._id || "invoice").replace(/[^a-zA-Z0-9]/g, "");
  return `INVPAID${invoiceKey}${Date.now()}${Math.floor(Math.random() * 10000)}`;
};

const findCompletedInvoiceTransaction = async (invoiceId, session = null) =>
  transactionModel
    .findOne({
      invoiceId,
      status: "completed",
    })
    .session(session);

const ensureCompletedInvoiceTransaction = async ({
  invoice,
  order,
  paymentMethod,
  transactionReference,
  markedPaidBy,
  transaction = null,
  session = null,
}) => {
  if (transaction) {
    transaction.invoiceId = transaction.invoiceId || invoice._id;
    transaction.orderId = transaction.orderId || invoice.orderId;
    transaction.sourceType = transaction.sourceType || "invoice";
    transaction.status = "completed";
    transaction.paymentStatus = "approved";
    transaction.verifiedBy = transaction.verifiedBy || markedPaidBy || null;
    transaction.verificationDate = transaction.verificationDate || new Date();
    await transaction.save({ session });
    return transaction;
  }

  const existingTransaction = await findCompletedInvoiceTransaction(invoice._id, session);
  if (existingTransaction) {
    return existingTransaction;
  }

  const transactionId = generateInvoiceTransactionId(invoice);
  const paymentEvidence = paymentMethod === "upi"
    ? await prepareUpiPaymentEvidence({ reference: transactionReference, transactionId, capturedVia: "admin" })
    : undefined;
  const completedTransaction = new transactionModel({
    userId: invoice.userId,
    orderId: invoice.orderId,
    invoiceId: invoice._id,
    transactionId,
    upiTransactionId: transactionReference || null,
    paymentEvidence,
    amount: invoice.amount,
    status: "completed",
    paymentStatus: "approved",
    type: "renewal",
    sourceType: "invoice",
    description: `Payment for invoice ${invoice.invoiceNumber || invoice._id}`,
    paymentMethod: paymentMethod || "upi",
    verifiedBy: markedPaidBy || null,
    verificationDate: new Date(),
    date: new Date(),
    renewalNumber: invoice.renewalMonth || null,
    renewalPeriodStart: invoice.renewalPeriodStart || null,
    renewalPeriodEnd: invoice.renewalPeriodEnd || null,
    productId: order?.productId?._id || order?.productId || null,
  });

  await completedTransaction.save({ session });
  return completedTransaction;
};

const markInvoicePaidAndResumePlan = async ({
  invoiceId,
  paymentMethod,
  transactionReference,
  markedPaidBy,
  internalNote,
  transaction = null,
  session = null,
}) => {
  const invoice = await monthlyInvoiceModel.findById(invoiceId).session(session);
  if (!invoice) {
    const error = new Error("Invoice not found");
    error.statusCode = 404;
    throw error;
  }

  if (invoice.status === "cancelled") {
    const error = new Error("Cancelled invoice cannot be marked as paid");
    error.statusCode = 400;
    throw error;
  }

  const order = await orderProductModel
    .findById(invoice.orderId)
    .populate("productId")
    .session(session);

  const completedTransaction = await ensureCompletedInvoiceTransaction({
    invoice,
    order,
    paymentMethod,
    transactionReference,
    markedPaidBy,
    transaction,
    session,
  });

  invoice.status = "paid";
  invoice.paidDate = new Date();
  invoice.paymentMethod = completedTransaction.paymentMethod || paymentMethod || invoice.paymentMethod || null;
  invoice.transactionReference =
    completedTransaction.upiTransactionId ||
    transactionReference ||
    completedTransaction.transactionId ||
    invoice.transactionReference ||
    null;
  invoice.markedPaidBy = markedPaidBy || invoice.markedPaidBy || null;
  if (internalNote !== undefined) {
    invoice.internalNote = internalNote || null;
  }
  await invoice.save({ session });

  const planResumed = await resumeOrderForPaidInvoice(order, session);

  return {
    invoice,
    order,
    transaction: completedTransaction,
    planResumed,
  };
};

module.exports = {
  updateOverdueInvoicesAndPausePlans,
  markInvoicePaidAndResumePlan,
};
