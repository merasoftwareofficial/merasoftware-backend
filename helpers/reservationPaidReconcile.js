const mongoose = require('mongoose');
const Reservation = require('../models/offerReservationModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const { deadlineOf, currentAdmin } = require('./offerReservations');
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const cents = amount => Math.round(Number(amount) * 100);

// This is a manual audit/reconciliation of an already paid project, not repricing or an offer application.
async function inspect(reservation, order, session = null) {
  if (!reservation || !order || String(reservation.userId) !== String(order.userId)) return null;
  if (reservation.projectId || reservation.confirmedAt || reservation.startRequestedAt || reservation.closureDecidedAt || ['sent', 'not-sent', 'late', 'failed'].includes(reservation.closureStatus) || order.offerReservationId || !['visible', 'approved'].includes(order.orderVisibility) || !order.isWebsiteProject || order.isServicePlan) return null;
  if (!Number.isFinite(cents(order.totalAmount)) || cents(order.totalAmount) <= 0 || cents(order.totalAmount) !== cents(reservation.reservedPrice)) return null;
  const orderAt = +new Date(order.createdAt), reservedAt = +new Date(reservation.reservedAt), deadline = +deadlineOf(reservation);
  if (![orderAt, reservedAt, deadline].every(Number.isFinite) || orderAt < reservedAt || orderAt > deadline) return null;
  const invoice = await Invoice.findOne({ orderId: order._id, invoiceType: 'project', status: 'paid' }).session(session).lean();
  if (!invoice || !Number.isFinite(cents(invoice.amount)) || !Number.isFinite(cents(invoice.amountPaid)) || cents(invoice.amount) !== cents(order.totalAmount) || cents(invoice.amountPaid) < cents(invoice.amount)) return null;
  if (await Transaction.exists({ orderId: order._id, type: 'refund', status: { $in: ['pending', 'completed', 'refunded'] } }).session(session)) return null;
  const payments = await Transaction.find({ invoiceId: invoice._id, orderId: order._id, type: 'payment', status: 'completed' }).select('amount createdAt').session(session).lean();
  if (!payments.length || payments.some(row => !Number.isFinite(cents(row.amount)) || cents(row.amount) <= 0 || !Number.isFinite(+new Date(row.createdAt))) || payments.reduce((sum, row) => sum + cents(row.amount), 0) < cents(invoice.amount)) return null;
  const paidAt = new Date(Math.max(...payments.map(row => +new Date(row.createdAt))));
  if (!Number.isFinite(+paidAt) || paidAt > deadlineOf(reservation)) return null;
  const existingOffer = order.projectSnapshot?.salesAgreement?.offer || order.salesPackage?.offer;
  if (existingOffer?.slug && existingOffer.slug !== reservation.offerSlug) return null;
  const category = order.projectSnapshot?.category || '';
  const categories = Array.isArray(reservation.offerSnapshot?.applicableCategories) ? reservation.offerSnapshot.applicableCategories : [];
  return { id: String(order._id), createdAt: order.createdAt, totalAmount: order.totalAmount, paidAt, category,
    offerCategories: categories, categoryMismatch: !category || !categories.includes(category), offerRecorded: !!existingOffer?.slug,
    itemNames: (order.orderItems || []).map(item => item.name).filter(Boolean).slice(0, 5) };
}
async function candidates(reservationId) {
  if (!mongoose.isValidObjectId(reservationId)) fail('Choose a reservation.', 400);
  const reservation = await Reservation.findById(reservationId).lean();
  if (!reservation || reservation.projectId || reservation.confirmedAt) fail('Reservation is unavailable.');
  const orders = await Order.find({ userId: reservation.userId, isWebsiteProject: true, isServicePlan: { $ne: true }, offerReservationId: null, orderVisibility: { $in: ['visible', 'approved'] } }).sort({ createdAt: -1 }).limit(100).lean();
  const rows = await Promise.all(orders.map(order => inspect(reservation, order)));
  return { offerSlug: reservation.offerSlug, offerTitle: reservation.offerSnapshot?.title || '', reservedPrice: reservation.reservedPrice, candidates: rows.filter(Boolean), limited: orders.length === 100 };
}
async function reconcile({ reservationId, orderId, actorId, confirmSlug, reason, acknowledgeMismatch }) {
  if (!mongoose.isValidObjectId(reservationId) || !mongoose.isValidObjectId(orderId)) fail('Choose a reservation and project.', 400);
  const note = String(reason || '').trim();
  if (!note || note.length > 300) fail('Enter a reason (up to 300 characters).', 400);
  return mongoose.connection.transaction(async session => {
    await currentAdmin(actorId, session);
    const reservation = await Reservation.findById(reservationId).session(session);
    const order = await Order.findById(orderId).session(session);
    const checked = await inspect(reservation, order, session);
    if (!checked || confirmSlug !== reservation.offerSlug) fail('Reservation or project changed; refresh and review again.');
    if (checked.categoryMismatch && acknowledgeMismatch !== true) fail('Confirm the category mismatch before linking.');
    reservation.projectId = order._id;
    reservation.confirmedAt = checked.paidAt;
    reservation.closureStatus = 'used';
    reservation.manualReconciliation = { actorId, at: new Date(), reason: note, categoryMismatch: checked.categoryMismatch };
    const linked = await Order.updateOne({ _id: order._id, userId: reservation.userId, offerReservationId: null, orderVisibility: { $in: ['visible', 'approved'] } }, { $set: { offerReservationId: reservation._id } }, { session });
    if (!linked.modifiedCount) fail('Project changed; refresh and review again.');
    await reservation.save({ session });
    await require('./reservationStage').onProjectAttached(reservation, { session, actor: actorId });
    return { reservationId: String(reservation._id), orderId: String(order._id) };
  });
}
module.exports = { candidates, reconcile };
