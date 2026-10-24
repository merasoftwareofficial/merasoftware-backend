const invoiceModel = require("../models/invoiceModel");
const generateInvoiceNumber = require("./generateInvoiceNumber");
const { buildLineItemsFromOrder } = require("./paymentRecording");

const getOrderTotal = (order) =>
  Number(order?.totalAmount || order?.totalPrice || order?.price || 0);

// This is a statement, not another amount to collect. Its money fields mirror
// the already-settled order state after a successful payment transaction.
const syncProjectFinalInvoice = async (order, { session = null } = {}) => {
  if (!order?.isWebsiteProject || !order?._id) return null;

  const amount = getOrderTotal(order);
  const amountPaid = Math.min(amount, Math.max(0, Number(order.paidAmount || 0)));
  const remainingAmount = Math.max(0, amount - amountPaid);
  const status = amountPaid >= amount ? "paid" : amountPaid > 0 ? "partially_paid" : "unpaid";
  const existing = await invoiceModel.findOne({ orderId: order._id, invoiceType: "project_final" }).session(session);

  const payload = {
    amount,
    amountPaid,
    status,
    dueDate: order.createdAt || new Date(),
    lineItems: buildLineItemsFromOrder(order),
    notes: `Project payment summary. Outstanding balance: ${remainingAmount}.`,
  };

  if (status === "paid") payload.paidDate = existing?.paidDate || new Date();
  else payload.paidDate = null;

  if (existing) {
    Object.assign(existing, payload);
    await existing.save({ session });
    return existing;
  }

  const statement = new invoiceModel({
    userId: order.userId,
    orderId: order._id,
    invoiceNumber: await generateInvoiceNumber({ session }),
    invoiceType: "project_final",
    invoiceDate: new Date(),
    ...payload,
  });
  return statement.save({ session });
};

module.exports = { syncProjectFinalInvoice };
