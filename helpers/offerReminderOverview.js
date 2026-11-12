const Invoice = require('../models/invoiceModel');
const Order = require('../models/orderProductModel');
const User = require('../models/userModel');
const { EmailPolicy, EmailHistory } = require('../models/emailControlModel');
const { DAY } = require('./offerPaymentPolicy');
const { isInstallmentDue } = require('./projectDuePayment');

// This is an invoice list, not a scheduler. It never creates missing invoices or
// marks overdue records. The worker remains authoritative for all delivery decisions.
async function offerReminderOverview({ page = 1, pageSize = 20, view = 'active', now = new Date() } = {}) {
  page = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
  pageSize = Math.max(1, Math.min(50, Number.parseInt(pageSize, 10) || 20));
  view = view === 'completed' ? 'completed' : 'active';
  const query = [
    { $match: { invoiceType: { $in: ['project', 'plan_renewal'] }, status: { $in: view === 'completed' ? ['paid', 'cancelled'] : ['unpaid', 'partially_paid', 'overdue'] } } },
    { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'orders' } },
    { $unwind: '$orders' },
    { $match: { 'orders.paymentPolicy': { $ne: null }, 'orders.orderVisibility': { $ne: 'cancelled' }, 'orders.servicePlanStatus': { $ne: 'pending_activation' } } },
    { $sort: { dueDate: 1, _id: 1 } },
    { $facet: { rows: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }, { $project: { userId: 1, orderId: 1, invoiceNumber: 1, amount: 1, amountPaid: 1, status: 1, dueDate: 1, offerRemindersPaused: 1, installmentNumber: 1, serviceCycleNumber: 1, orders: 1 } }], total: [{ $count: 'count' }] } },
  ];
  const [result, policy] = await Promise.all([Invoice.aggregate(query), EmailPolicy.findOne({ event: 'offer.payment.reminder' }).select('mode').lean()]);
  const rows = result[0]?.rows || [];
  const users = await User.find({ _id: { $in: rows.map(row => row.userId) } }).select('name email isActive deletedAt').lean();
  const byId = new Map(users.map(user => [String(user._id), user]));
  const keys = rows.flatMap(invoice => (invoice.orders.paymentPolicy?.reminderOffsets || []).map(offset => `offer-reminder:${invoice._id}:${offset}`));
  const history = keys.length ? await EmailHistory.find({ dedupeKey: { $in: keys } }).select('dedupeKey status sentAt updatedAt draftId').lean() : [];
  const { Queue } = require('../whatsapp/src/models.js');
  const queue = history.length ? await Queue.find({ emailDraftId: { $in: history.map(item => item.draftId) } }).select('emailDraftId status').lean() : [];
  const historyByKey = new Map(history.map(item => [item.dedupeKey, item]));
  return {
    page, pageSize, view, total: result[0]?.total[0]?.count || 0, serverNow: now,
    remindersEnabled: policy?.mode !== 'off', cronEnabled: process.env.ENABLE_CRONS === 'true',
    rows: rows.map(invoice => {
      const order = invoice.orders, customer = byId.get(String(invoice.userId));
      let reason = view === 'completed' ? 'This invoice is closed; no payment reminder is due.' : invoice.offerRemindersPaused ? 'Payment reminders are paused for this invoice.' : '';
      if (!reason && order.isServicePlan && Number(invoice.serviceCycleNumber) > 1 && order.paymentPolicy.cycleScope !== 'every_cycle') reason = 'Offer terms apply to the first cycle only.';
      else if (!reason && invoice.installmentNumber && invoice.installmentNumber !== order.currentInstallment) reason = 'This is not the current installment.';
      else if (!reason && invoice.installmentNumber) {
        const installment = (order.installments || []).find(item => item.installmentNumber === invoice.installmentNumber);
        if (installment && !isInstallmentDue(order, installment, now)) reason = 'This installment is not due yet.';
      }
      if (!reason && (!customer?.email || customer.isActive === false || customer.deletedAt)) reason = 'Customer account or email is unavailable.';
      const offsets = order.paymentPolicy.reminderOffsets || [];
      if (!reason && !offsets.length) reason = 'No reminder days in the saved agreement.';
      const due = new Date(invoice.dueDate);
      const future = Number.isFinite(+due) ? offsets.map(offset => ({ offset, at: new Date(+due + offset * DAY) })).filter(item => item.at > now).sort((a, b) => a.at - b.at) : [];
      return { id: String(invoice._id), userId: String(invoice.userId), remindersPaused: !!invoice.offerRemindersPaused, orderId: String(invoice.orderId), customer: customer?.name || customer?.email || 'Customer', invoiceNumber: invoice.invoiceNumber,
        dueDate: invoice.dueDate, status: invoice.status, outstanding: Math.max(0, Number(invoice.amount || 0) - Number(invoice.amountPaid || 0)),
        offsets, reason, nextMilestone: reason ? null : future[0] || null,
        reminderHistory: offsets.flatMap(offset => {
          const entry = historyByKey.get(`offer-reminder:${invoice._id}:${offset}`);
          return entry ? [{ offset, status: entry.status, at: entry.sentAt || entry.updatedAt || null,
            whatsapp: queue.filter(item => String(item.emailDraftId) === String(entry.draftId)).map(item => item.status) }] : [];
        }) };
    }),
  };
}
module.exports = { offerReminderOverview };
