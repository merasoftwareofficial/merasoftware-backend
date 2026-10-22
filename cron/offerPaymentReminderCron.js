const cron = require('node-cron');
const Invoice = require('../models/invoiceModel');
const Order = require('../models/orderProductModel');
const User = require('../models/userModel');
const { DAY } = require('../helpers/offerPaymentPolicy');
const { sendScheduledOfferReminder } = require('../helpers/emailController');
async function processOfferPaymentReminders(now = new Date()) {
  await require('../helpers/offerProjectInvoices').ensureOfferProjectInvoices();
  const invoices = await Invoice.find({ invoiceType: { $in: ['project', 'plan_renewal'] }, status: { $in: ['unpaid', 'partially_paid', 'overdue'] } });
  for (const invoice of invoices) {
    const order = await Order.findById(invoice.orderId);
    if (!order?.paymentPolicy || order.orderVisibility === 'cancelled' || order.servicePlanStatus === 'pending_activation') continue;
    // First-purchase-only terms never opt later cycles into scheduled offer mail.
    if (order.isServicePlan && Number(invoice.serviceCycleNumber) > 1 && order.paymentPolicy.cycleScope !== 'every_cycle') continue;
    if (invoice.installmentNumber && invoice.installmentNumber !== order.currentInstallment) continue;
    if (invoice.installmentNumber) {
      const installment = order.installments.find(item => item.installmentNumber === invoice.installmentNumber);
      if (installment?.progressThreshold != null && Number(order.projectProgress || 0) < installment.progressThreshold) continue;
    }
    if (new Date(invoice.dueDate) < now && invoice.status !== 'overdue') {
      await Invoice.updateOne({ _id: invoice._id, status: invoice.status }, { $set: { status: 'overdue' } });
    }
    const customer = await User.findById(order.userId).select('name email isActive deletedAt').lean();
    if (!customer?.email || customer.isActive === false || customer.deletedAt) continue;
    const offsets = order.paymentPolicy.reminderOffsets || [];
    // Catch up at most the latest due milestone, avoiding a burst after downtime.
    const dueOffsets = offsets.filter(offset => new Date(invoice.dueDate).getTime() + offset * DAY <= now.getTime()).sort((a, b) => b - a);
    if (dueOffsets.length) await sendScheduledOfferReminder(invoice, customer, dueOffsets[0]);
  }
}
const scheduleOfferPaymentReminders = () => cron.schedule('*/15 * * * *', () => processOfferPaymentReminders().catch(error => console.error('Offer reminder job failed:', error.message)), { timezone: 'Asia/Kolkata' });
module.exports = { processOfferPaymentReminders, scheduleOfferPaymentReminders };
