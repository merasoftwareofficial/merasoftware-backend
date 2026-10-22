const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const { createProjectInvoice, buildLineItemsFromOrder } = require('./paymentRecording');
const { paymentDueDate } = require('./offerPaymentPolicy');
// Materialise only the installment that is due, never a summary or a future bill.
async function ensureOfferProjectInvoices() {
  const orders = await Order.find({ isWebsiteProject: true, isPartialPayment: true, paymentPolicy: { $ne: null }, orderVisibility: { $nin: ['cancelled', 'payment-rejected'] } });
  for (const order of orders) {
    const target = order.installments.find(item => item.installmentNumber === order.currentInstallment && !item.paid);
    if (!target || (target.progressThreshold != null && Number(order.projectProgress || 0) < target.progressThreshold)) continue;
    if (await Invoice.exists({ orderId: order._id, invoiceType: 'project', installmentNumber: target.installmentNumber })) continue;
    try {
      await createProjectInvoice({ customerId: order.userId, orderId: order._id, amount: target.amount, lineItems: buildLineItemsFromOrder(order),
        installmentNumber: target.installmentNumber, dueDate: target.dueDate || paymentDueDate(order.paymentPolicy, order.paymentPolicy.appliedAt),
        paymentPolicyKey: `${order._id}:installment:${target.installmentNumber}` });
    } catch (error) { if (error.code !== 11000) throw error; }
  }
}
module.exports = { ensureOfferProjectInvoices };
