const invoiceModel = require("../models/invoiceModel");
const generateInvoiceNumber = require("./generateInvoiceNumber");

const getCyclePrice = (service, invoices) =>
  Number(service?.serviceCyclePrice || invoices.find((invoice) => Number(invoice.amount) > 0)?.amount || 0);

const syncServiceBillingStatement = async (service) => {
  if (!service?.isServicePlan || !service?._id || !Number(service.serviceTotalCycles)) return null;

  const invoices = await invoiceModel.find({
    orderId: service._id,
    invoiceType: { $in: ["project", "plan_renewal"] },
  });
  const cyclePrice = getCyclePrice(service, invoices);
  const amount = cyclePrice * Number(service.serviceTotalCycles);
  const amountPaid = invoices.reduce((total, invoice) => total + Number(invoice.amountPaid || 0), 0);
  const status = amountPaid >= amount ? "paid" : amountPaid > 0 ? "partially_paid" : "unpaid";
  const existing = await invoiceModel.findOne({ orderId: service._id, invoiceType: "service_statement" });
  const payload = {
    amount,
    amountPaid: Math.min(amount, amountPaid),
    status,
    dueDate: service.servicePlanEndDate || service.serviceCurrentCycleEnd || new Date(),
    lineItems: [{ name: service.servicePlanSnapshot?.serviceName || service.orderItems?.[0]?.name || "Service Plan", price: amount }],
    notes: `Service billing statement: ${Number(service.serviceCompletedCycles || 0)} of ${Number(service.serviceTotalCycles)} cycles paid.`,
    paidDate: status === "paid" ? existing?.paidDate || new Date() : null,
  };

  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    return existing;
  }

  return invoiceModel.create({
    userId: service.userId,
    orderId: service._id,
    invoiceNumber: await generateInvoiceNumber(),
    invoiceType: "service_statement",
    invoiceDate: new Date(),
    ...payload,
  });
};

module.exports = { syncServiceBillingStatement };
