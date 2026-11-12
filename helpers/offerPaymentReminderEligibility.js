const mongoose = require('mongoose');
const Invoice = require('../models/invoiceModel');
const Order = require('../models/orderProductModel');
const User = require('../models/userModel');
const { EmailPolicy } = require('../models/emailControlModel');
const { DAY } = require('./offerPaymentPolicy');
const { isInstallmentDue } = require('./projectDuePayment');
const cents = value => Math.round(Number(value) * 100);
async function maySendOfferPaymentReminder(draft, now = new Date()) {
  if (draft.event !== 'offer.payment.reminder' || draft.application !== 'portal') return true;
  const context = draft.offerReminderContext;
  if (!context || !mongoose.isValidObjectId(context.invoiceId) || !Number.isInteger(context.offset) || !Number.isFinite(cents(context.expectedAmount)) || cents(context.expectedAmount) <= 0) return false;
  if (draft.dedupeKey && draft.dedupeKey !== `offer-reminder:${context.invoiceId}:${context.offset}`) return false;
  const invoice = await Invoice.findById(context.invoiceId).lean();
  if (!invoice || !['project', 'plan_renewal'].includes(invoice.invoiceType) || !['unpaid', 'partially_paid', 'overdue'].includes(invoice.status) || invoice.offerRemindersPaused) return false;
  const outstanding = Math.max(0, Number(invoice.amount) - Number(invoice.amountPaid || 0));
  if (!Number.isFinite(outstanding) || cents(outstanding) !== cents(context.expectedAmount) || +new Date(invoice.dueDate) !== +new Date(context.dueAt)) return false;
  const order = await Order.findById(invoice.orderId).lean();
  if (!order?.paymentPolicy || order.orderVisibility === 'cancelled' || order.servicePlanStatus === 'pending_activation') return false;
  if (order.isServicePlan && Number(invoice.serviceCycleNumber) > 1 && order.paymentPolicy.cycleScope !== 'every_cycle') return false;
  if (invoice.installmentNumber && invoice.installmentNumber !== order.currentInstallment) return false;
  if (invoice.installmentNumber) {
    const installment = (order.installments || []).find(row => row.installmentNumber === invoice.installmentNumber);
    if (installment && !isInstallmentDue(order, installment, now)) return false;
  }
  const due = +new Date(invoice.dueDate);
  const dueOffsets = (order.paymentPolicy.reminderOffsets || []).filter(offset => due + offset * DAY <= +now).sort((a, b) => b - a);
  if (!dueOffsets.length || dueOffsets[0] !== context.offset) return false;
  const customer = await User.findById(order.userId).select('email isActive deletedAt').lean();
  if (!customer?.email || customer.isActive === false || customer.deletedAt) return false;
  if (draft.to?.length && !draft.to.every(email => String(email).toLowerCase() === customer.email.toLowerCase())) return false;
  const policy = await EmailPolicy.findOne({ event: draft.event }).select('mode').lean();
  return policy?.mode !== 'off';
}
module.exports = { maySendOfferPaymentReminder };
