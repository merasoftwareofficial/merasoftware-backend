const mongoose = require('mongoose');
const Order = require('../models/orderProductModel');
const User = require('../models/userModel');
const { initializeProjectTimeline } = require('./projectNodeService');
const { createProjectInvoice, buildLineItemsFromOrder } = require('./paymentRecording');
const { syncProjectFinalInvoice } = require('./projectFinalInvoice');
const { paymentDueDate } = require('./offerPaymentPolicy');
const { recordAdminProjectPaymentInSession } = require('./projectPaymentSettlement');

// External catalogue reads/validation happen before this short financial commit.
// No network delivery or request-scoped email draft is created in a retryable callback.
async function persistAdminProject({ orderData, startingNodeTitle, actorId, recordPayment, preparedEvidence, sourceOffer }) {
  const projectId = new mongoose.Types.ObjectId();
  return mongoose.connection.transaction(async session => {
    const actor = await User.findById(actorId).session(session);
    if (!actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) throw Object.assign(new Error('Current portal admin access required'), { statusCode: 403 });
    const client = await User.findById(orderData.userId).session(session);
    if (!client || client.isActive === false || client.deletedAt || client.isGuest) throw Object.assign(new Error('Client is unavailable'), { statusCode: 400 });
    if (orderData.projectCreationKey) {
      const existing = await Order.findOne({ projectCreationKey: orderData.projectCreationKey }).session(session);
      if (existing) {
        if (existing.projectCreationHash !== orderData.projectCreationHash || !existing.projectCreationComplete) throw Object.assign(new Error('Project request changed or is incomplete'), { statusCode: 409 });
        return { order: existing, reused: true };
      }
    }
    const order = new Order({ ...orderData, _id: projectId });
    await require('./offerReservations').attachProjectReservation({ order, offer: sourceOffer, session });
    initializeProjectTimeline({ order, startingNodeTitle, actorId });
    await order.save({ session });
    const installment = order.isPartialPayment ? order.installments[0] : null;
    const invoiceDate = new Date();
    const dueDate = order.paymentPolicy ? paymentDueDate(order.paymentPolicy, invoiceDate) : installment?.dueDate || invoiceDate;
    if (installment) installment.dueDate = dueDate;
    const invoice = await createProjectInvoice({ customerId: order.userId, orderId: order._id,
      amount: installment ? installment.amount : order.totalAmount,
      lineItems: buildLineItemsFromOrder(order), installmentNumber: installment?.installmentNumber,
      invoiceDate, dueDate, session });
    if (order.paymentComplete && Number(order.totalAmount) === 0) {
      invoice.status = 'paid'; invoice.paidDate = invoiceDate;
      await invoice.save({ session });
    }
    await require('./offerReservations').confirmReservationPayment({ order, invoice, session });
    if (recordPayment) {
      await recordAdminProjectPaymentInSession({ order, actorId, payment: recordPayment, preparedEvidence, session });
    } else {
      await order.save({ session });
      await syncProjectFinalInvoice(order, { session });
    }
    order.projectCreationComplete = true;
    await order.save({ session });
    return { order, invoice, reused: false };
  });
}

module.exports = { persistAdminProject };
