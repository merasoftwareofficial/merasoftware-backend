const mongoose = require('mongoose');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const User = require('../models/userModel');
const { markProjectInvoicePaid, createProjectInvoice, buildLineItemsFromOrder } = require('./paymentRecording');
const { setOrderPaidAmount, getOrderTotal, getInvoiceAmountReceived, deriveInvoiceStatus } = require('./orderPaymentTotals');
const { syncProjectFinalInvoice } = require('./projectFinalInvoice');
const { deductWalletInstant, refundWalletInstant } = require('./transactionService');
const { markOrderApproved } = require('./orderLifecycle');
const { logRejected, ACTOR_TYPE } = require('./orderLifecycleLog');

const same = (a, b) => String(a?._id || a) === String(b?._id || b);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const cents = amount => Math.round(Number(amount) * 100);
function validAmount(amount) {
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || Math.abs(Number(amount) * 100 - cents(amount)) > 0.00001) fail('Enter a positive payment amount with at most two decimal places');
}

// Route project payments here; services and legacy monthly plans keep their own ledger.
async function projectForTransaction(transaction) {
  if (!transaction || transaction.type !== 'payment') return null;
  const invoice = transaction.invoiceId ? await Invoice.findById(transaction.invoiceId) : null;
  const orderId = transaction.orderId || invoice?.orderId;
  return orderId ? Order.findOne({ _id: orderId, isWebsiteProject: true, isServicePlan: { $ne: true } }) : null;
}

async function dueInvoice(order, input, session) {
  let invoice = input.invoiceId ? await Invoice.findById(input.invoiceId).session(session) : null;
  if (input.invoiceId && (!invoice || invoice.invoiceType !== 'project' || !same(invoice.orderId, order._id) || !same(invoice.userId, order.userId))) fail('Choose a payable invoice belonging to this project and customer');
  const number = invoice?.installmentNumber || input.installmentNumber;
  if (input.installmentNumber != null && invoice?.installmentNumber != null && Number(input.installmentNumber) !== Number(invoice.installmentNumber)) fail('Payment installment does not match the invoice');
  let installment = null;
  if (order.isPartialPayment) {
    installment = order.installments.find(row => Number(row.installmentNumber) === Number(number || order.currentInstallment));
    if (!installment || installment.paid || Number(installment.installmentNumber) !== Number(order.currentInstallment)) fail('Only the current unpaid installment can be paid');
    if (installment.progressThreshold != null && Number(order.projectProgress || 0) < Number(installment.progressThreshold)) fail('This installment is not due at the current project stage');
  } else if (number != null) fail('This project does not have installment payments');
  if (!invoice) invoice = await Invoice.findOne({ orderId: order._id, invoiceType: 'project', installmentNumber: installment?.installmentNumber || null }).session(session);
  if (!invoice) invoice = await createProjectInvoice({
    customerId: order.userId, orderId: order._id,
    amount: installment ? installment.amount : getOrderTotal(order),
    lineItems: buildLineItemsFromOrder(order), installmentNumber: installment?.installmentNumber,
    dueDate: installment?.dueDate || new Date(), session,
  });
  if (['paid', 'cancelled'].includes(invoice.status)) fail('This invoice is already settled or cancelled');
  return { invoice, installment };
}

async function applyReceived(order, invoice, installment, transaction, session, actorType, alreadySettled = false) {
  const result = alreadySettled ? { invoice, transaction } : await markProjectInvoicePaid({ invoice, customerId: order.userId,
    paymentMethod: transaction.paymentMethod, transactionReference: transaction.upiTransactionId || transaction.transactionId,
    actorId: transaction.verifiedBy, amount: transaction.amount, existingTransaction: transaction, session });
  await setOrderPaidAmount(order, { session });
  order.paymentComplete = cents(order.remainingAmount) === 0;
  if (installment) {
    installment.paid = result.invoice.status === 'paid';
    installment.paidDate = installment.paid ? result.invoice.paidDate : null;
    installment.paymentStatus = 'none';
    installment.transactionId = transaction.transactionId;
    const next = order.installments.find(row => !row.paid);
    if (next) order.currentInstallment = next.installmentNumber;
  }
  if (result.invoice.status === 'paid' && markOrderApproved(order, { actorId: transaction.verifiedBy || order.userId, actorType })) order.rejectionReason = null;
  // The same order write conflicts with uploads and future price revisions.
  order.uploadRevision = Number(order.uploadRevision || 0) + 1;
  await order.save({ session });
  await syncProjectFinalInvoice(order, { session });
  return { invoice: result.invoice, order };
}

async function approveProjectPayment(transactionId, actorId) {
  return mongoose.connection.transaction(async session => {
    const transaction = await Transaction.findOne({ transactionId }).session(session);
    if (!transaction || transaction.status !== 'pending') fail('Payment is unavailable or already decided');
    const actor = await User.findById(actorId).session(session);
    if (!actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) fail('Current portal admin access required', 403);
    const linked = transaction.invoiceId ? await Invoice.findById(transaction.invoiceId).session(session) : null;
    const order = await Order.findById(transaction.orderId || linked?.orderId).session(session);
    if (!order?.isWebsiteProject || order.isServicePlan || !same(order.userId, transaction.userId)) fail('Payment does not belong to this customer project');
    validAmount(transaction.amount);
    const { invoice, installment } = await dueInvoice(order, transaction, session);
    if (cents(transaction.amount) > cents(invoice.amount) - cents(invoice.amountPaid)) fail('Transaction amount exceeds the invoice balance');
    const user = await User.findById(transaction.userId).session(session);
    if (!user) fail('Transaction customer not found', 404);
    if (transaction.paymentMethod === 'wallet') {
      const debited = await User.updateOne({ _id: user._id, walletBalance: { $gte: transaction.amount } }, { $inc: { walletBalance: -transaction.amount } }, { session });
      if (!debited.modifiedCount) fail('Insufficient wallet balance');
    }
    transaction.status = 'completed'; transaction.paymentStatus = 'approved';
    transaction.verifiedBy = actorId; transaction.verificationDate = new Date();
    transaction.rejectionReason = null; transaction.rejectedAt = null; transaction.rejectedBy = null;
    transaction.orderId = order._id;
    if (installment) transaction.installmentNumber = installment.installmentNumber;
    await transaction.save({ session });
    const result = await applyReceived(order, invoice, installment, transaction, session, ACTOR_TYPE.ADMIN);
    return { ...result, transaction, walletBalance: (await User.findById(user._id).session(session)).walletBalance };
  });
}

async function payProjectWallet(userId, body) {
  validAmount(body.amount);
  const transactionId = body.parentTransactionId ? `${body.parentTransactionId}-W` : `WPAY${new mongoose.Types.ObjectId()}`;
  return mongoose.connection.transaction(async session => {
    const order = await Order.findOne({ _id: body.orderId, userId, isWebsiteProject: true, isServicePlan: { $ne: true } }).session(session);
    if (!order || order.orderVisibility === 'cancelled') fail('Project is unavailable for payment');
    const previous = await Transaction.findOne({ transactionId }).session(session);
    if (previous) {
      if (!same(previous.userId, userId) || !same(previous.orderId, order._id) || cents(previous.amount) !== cents(body.amount)
        || (body.invoiceId && !same(previous.invoiceId, body.invoiceId))
        || (body.installmentNumber != null && Number(previous.installmentNumber) !== Number(body.installmentNumber))
        || previous.status !== 'completed') fail('Payment retry does not match the original payment', 409);
      const balance = (await User.findById(userId).session(session))?.walletBalance;
      const invoice = previous.invoiceId ? await Invoice.findById(previous.invoiceId).session(session) : null;
      return { order, invoice, transaction: previous, walletBalance: balance };
    }
    const { invoice, installment } = await dueInvoice(order, body, session);
    if (cents(body.amount) > cents(invoice.amount) - cents(invoice.amountPaid)) fail('Payment amount must not exceed the invoice balance');
    const { transaction, newBalance } = await deductWalletInstant({ userId, transactionId, amount: Number(body.amount),
      orderId: order._id, installmentNumber: installment?.installmentNumber,
      parentTransactionId: body.parentTransactionId || null, sourceType: 'invoice',
      description: `Payment (wallet) for invoice ${invoice.invoiceNumber}`, session });
    const result = await applyReceived(order, invoice, installment, transaction, session, ACTOR_TYPE.CUSTOMER);
    return { ...result, transaction, walletBalance: newBalance };
  });
}

async function rejectProjectPayment(transactionId, actorId, reason) {
  return mongoose.connection.transaction(async session => {
    const actor = await User.findById(actorId).session(session);
    if (!actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) fail('Current portal admin access required', 403);
    const transaction = await Transaction.findOne({ transactionId }).session(session);
    if (!transaction || transaction.status !== 'pending') fail('Payment is unavailable or already decided');
    const source = transaction.invoiceId ? await Invoice.findById(transaction.invoiceId).session(session) : null;
    const order = await Order.findById(transaction.orderId || source?.orderId).session(session);
    if (!order?.isWebsiteProject || order.isServicePlan || !same(order.userId, transaction.userId)) fail('Payment does not belong to this customer project');
    if (source && (source.invoiceType !== 'project' || !same(source.orderId, order._id) || !same(source.userId, order.userId))) fail('Invalid project invoice');
    const now = new Date();
    transaction.status = 'rejected'; transaction.paymentStatus = 'rejected';
    transaction.rejectionReason = reason; transaction.rejectedAt = now; transaction.rejectedBy = actorId;
    transaction.verifiedBy = actorId; transaction.verificationDate = now;
    await transaction.save({ session });
    const parents = [transaction.transactionId, transaction.parentTransactionId].filter(Boolean);
    const portions = await Transaction.find({ orderId: order._id, userId: order.userId, parentTransactionId: { $in: parents },
      type: 'payment', paymentMethod: 'wallet', status: 'completed' }).session(session);
    const invoices = new Map();
    for (const portion of portions) {
      await refundWalletInstant({ userId: order.userId, transactionId: `${portion.transactionId}-REFUND`,
        amount: portion.amount, orderId: order._id, invoiceId: portion.invoiceId,
        parentTransactionId: portion.parentTransactionId, description: `Refund for rejected payment ${transactionId}`, session });
      if (portion.invoiceId) {
        const invoice = await Invoice.findById(portion.invoiceId).session(session);
        if (!invoice || invoice.invoiceType !== 'project' || !same(invoice.orderId, order._id)) fail('Paired wallet payment has an invalid invoice');
        invoices.set(String(invoice._id), invoice);
      }
    }
    for (const invoice of invoices.values()) {
      invoice.amountPaid = Math.max(0, await getInvoiceAmountReceived(invoice._id, { session }));
      invoice.status = deriveInvoiceStatus(invoice.amountPaid, invoice.amount);
      if (invoice.status !== 'paid') invoice.paidDate = null;
      await invoice.save({ session });
      const installment = order.installments.find(row => Number(row.installmentNumber) === Number(invoice.installmentNumber));
      if (installment) { installment.paid = invoice.status === 'paid'; installment.paidDate = invoice.paidDate; }
    }
    await setOrderPaidAmount(order, { session });
    order.paymentComplete = cents(order.remainingAmount) === 0;
    const first = order.installments.find(row => !row.paid);
    if (first) order.currentInstallment = first.installmentNumber;
    const rejectedInstallment = order.installments.find(row => Number(row.installmentNumber) === Number(transaction.installmentNumber || source?.installmentNumber));
    if (rejectedInstallment && !rejectedInstallment.paid) rejectedInstallment.paymentStatus = 'rejected';
    if (cents(order.paidAmount) === 0 && order.orderVisibility !== 'cancelled') {
      const fromVisibility = order.orderVisibility;
      order.orderVisibility = 'payment-rejected';
      if (fromVisibility !== 'payment-rejected') logRejected(order, { actorId, actorType: ACTOR_TYPE.ADMIN, reason, fromVisibility });
    }
    order.rejectionReason = reason;
    order.uploadRevision = Number(order.uploadRevision || 0) + 1;
    await order.save({ session });
    await syncProjectFinalInvoice(order, { session });
    return { order, transaction };
  });
}

async function recordAdminProjectPaymentInSession({ order, actorId, payment, preparedEvidence, session }) {
  const { invoice, installment } = await dueInvoice(order, {}, session);
  const amount = (cents(invoice.amount) - cents(invoice.amountPaid)) / 100;
  validAmount(amount);
  const result = await markProjectInvoicePaid({ invoice, customerId: order.userId,
    paymentMethod: payment.paymentMethod, transactionReference: payment.transactionReference,
    paymentDetails: payment.paymentDetails || {}, preparedEvidence,
    notes: payment.notes, actorId, amount, session });
  return applyReceived(order, result.invoice, installment, result.transaction, session, ACTOR_TYPE.ADMIN, true);
}

async function recordAdminProjectPayment({ orderId, actorId, payment, preparedEvidence }) {
  return mongoose.connection.transaction(async session => {
    const actor = await User.findById(actorId).session(session);
    if (!actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) fail('Current portal admin access required', 403);
    const order = await Order.findById(orderId).session(session);
    if (!order?.isWebsiteProject || order.isServicePlan) fail('Project not found', 404);
    if (order.orderVisibility !== 'pending-approval') fail(`Order is already ${order.orderVisibility}`);
    if (await Transaction.exists({ orderId: order._id, type: 'payment', status: 'completed' }).session(session)) fail('This project already has a recorded payment. Use the payment ledger.');
    return recordAdminProjectPaymentInSession({ order, actorId, payment, preparedEvidence, session });
  });
}

async function rejectAdminProject({ orderId, actorId, reason }) {
  return mongoose.connection.transaction(async session => {
    const actor = await User.findById(actorId).session(session);
    if (!actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) fail('Current portal admin access required', 403);
    const order = await Order.findById(orderId).session(session);
    if (!order?.isWebsiteProject || order.isServicePlan) fail('Project not found', 404);
    if (order.orderVisibility !== 'pending-approval') fail(`Order is already ${order.orderVisibility}`);
    // A competing receipt must never be overwritten by an approval-screen rejection.
    if (await Transaction.exists({ orderId: order._id, type: 'payment', status: 'completed' }).session(session)) fail('This project has received payment. Use the payment ledger.');
    const fromVisibility = order.orderVisibility;
    order.orderVisibility = 'payment-rejected'; order.rejectionReason = reason;
    logRejected(order, { actorId, actorType: ACTOR_TYPE.ADMIN, reason, fromVisibility });
    order.uploadRevision = Number(order.uploadRevision || 0) + 1;
    await order.save({ session });
    return order;
  });
}

module.exports = { projectForTransaction, approveProjectPayment, payProjectWallet, rejectProjectPayment,
  recordAdminProjectPayment, recordAdminProjectPaymentInSession, rejectAdminProject };
