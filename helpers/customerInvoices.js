const MonthlyInvoice = require('../models/monthlyInvoiceModel');
const Invoice = require('../models/invoiceModel');

// Shared projection for full payment workspace and scoped customer reads.
async function readCustomerInvoices(filter) {
  const [monthly, project] = await Promise.all([
      MonthlyInvoice
        .find(filter)
        .select("orderId invoiceNumber amount status invoiceDate dueDate paidDate paymentMethod transactionReference createdAt")
        .populate({ path: "orderId", select: "productId projectSnapshot servicePlanSnapshot orderItems", populate: { path: "productId", select: "serviceName" } })
        .sort({ createdAt: -1 }),
      Invoice
        .find(filter)
        .select("orderId invoiceNumber invoiceType amount amountPaid status invoiceDate dueDate paidDate installmentNumber serviceCycleNumber lineItems paymentMethod transactionReference createdAt")
        .populate({ path: "orderId", select: "productId projectSnapshot servicePlanSnapshot orderItems", populate: { path: "productId", select: "serviceName" } })
        .sort({ createdAt: -1 }),
  ]);
  return [...monthly, ...project].sort((a, b) => new Date(b.invoiceDate) - new Date(a.invoiceDate));
}
module.exports = readCustomerInvoices;
