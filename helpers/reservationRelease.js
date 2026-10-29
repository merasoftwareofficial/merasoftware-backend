const mongoose = require('mongoose');
const Reservation = require('../models/offerReservationModel');
const Order = require('../models/orderProductModel');
const Transaction = require('../models/transactionModel');
const User = require('../models/userModel');
const Invoice = require('../models/invoiceModel');

// Only unused, unpaid reservations are reusable. Financial history is never reset.
async function releaseProjectReservation({ projectId, actorId = null, deleting = false, session }) {
  const rows = await Reservation.find({ projectId }).session(session);
  for (const row of rows) {
    await User.updateOne({ _id: row.userId }, { $inc: { __v: 1 } }, { session });
    const order = await Order.findById(projectId).session(session);
    if (order && String(order.userId) !== String(row.userId)) continue;
    if (order && !deleting && order.orderVisibility !== 'cancelled') continue;
    if (row.confirmedAt || row.resolution?.status === 'force_applied' || Number(row.resolution?.walletCredit || 0) > 0) continue;
    // Even refunded completed payments require deliberate financial review, not automatic reuse.
    if (await Transaction.exists({ orderId: projectId, type: 'payment', status: { $in: ['pending', 'completed'] } }).session(session)) continue;
    if (await Invoice.exists({ orderId: projectId, invoiceType: 'project', $or: [{ status: 'paid' }, { amountPaid: { $gt: 0 } }] }).session(session)) continue;
    if (order && (Number(order.paidAmount || 0) > 0 || order.paymentComplete)) continue;
    row.releases.push({ projectId, actorId, at: new Date(), reason: deleting ? 'project_deleted' : order ? 'project_cancelled' : 'missing_project',
      resolution: row.resolution?.toObject?.() || row.resolution || null });
    row.projectId = null;
    row.resolution = null;
    row.pricingNextCheckAt = new Date(0);
    row.pricingLockedUntil = null;
    await row.save({ session });
    // Preserve the old order's agreement; its reservation link is no longer active.
    if (order) await Order.updateOne({ _id: projectId, offerReservationId: row._id }, { $unset: { offerReservationId: 1 } }, { session });
  }
}

// Repair historical cancelled/missing links through the same guarded, transactional operation.
async function repairUserReservationLinks(userId) {
  const rows = await Reservation.find({ userId, projectId: { $ne: null }, confirmedAt: null }).select('projectId').lean();
  for (const row of rows) {
    const order = await Order.findById(row.projectId).select('orderVisibility').lean();
    if (order && order.orderVisibility !== 'cancelled') continue;
    await mongoose.connection.transaction(session => releaseProjectReservation({ projectId: row.projectId, session }));
  }
}
module.exports = { releaseProjectReservation, repairUserReservationLinks };
