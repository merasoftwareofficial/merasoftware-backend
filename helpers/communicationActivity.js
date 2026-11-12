const Order = require('../models/orderProductModel');
const User = require('../models/userModel');
const Reservation = require('../models/offerReservationModel');
const { Broadcast } = require('../models/broadcastModel');

// A bounded read of committed business records. This is intentionally not called
// an audit log: older records and other actions have not all recorded transitions.
// Each row comes from a record that proves the event itself, not from a message:
//   package order created - the order's createdAt
//   plan started          - serviceStartNotifiedAt, claimed only while the plan was active (a suppressed
//                           or failed start message does not change it)
//   offer reserved        - the reservation's reservedAt
//   broadcast accepted    - acceptanceCompletedAt
async function recentActivity({ limit = 20 } = {}) {
  limit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 20));
  const [orders, started, reservations, broadcasts] = await Promise.all([
    Order.find({ isServicePlan: true, 'salesPackage.package.id': { $exists: true, $ne: null } })
      .sort({ createdAt: -1, _id: -1 }).limit(limit)
      .select('userId createdAt orderItems servicePlanStatus salesPackage.package').lean(),
    Order.find({ isServicePlan: true, serviceStartNotifiedAt: { $ne: null } })
      .sort({ serviceStartNotifiedAt: -1, _id: -1 }).limit(limit)
      .select('userId serviceStartNotifiedAt orderItems servicePlanStatus salesPackage.package').lean(),
    Reservation.find({}).sort({ reservedAt: -1, _id: -1 }).limit(limit)
      .select('userId reservedAt offerSlug offerSnapshot.title closureStatus').lean(),
    Broadcast.find({ acceptanceCompletedAt: { $ne: null } }).sort({ createdAt: -1, _id: -1 }).limit(limit)
      .select('createdBy createdAt audience channel state').lean(),
  ]);
  const users = await User.find({ _id: { $in: [...orders, ...started, ...reservations].map(row => row.userId).concat(broadcasts.map(row => row.createdBy)) } }).select('name email').lean();
  const names = new Map(users.map(user => [String(user._id), user.name || user.email || '']));
  const planName = order => order.orderItems?.[0]?.name || order.salesPackage?.package?.name || 'Plan';
  return [...orders.map(order => ({ id: String(order._id), kind: 'package-order', at: order.createdAt,
    title: 'Monthly package order created', person: names.get(String(order.userId)) || 'Customer',
    detail: planName(order), status: order.servicePlanStatus || '',
    relatedEvent: 'plan.started', application: 'portal' })),
  ...started.map(order => ({ id: String(order._id), kind: 'plan-started', at: order.serviceStartNotifiedAt,
    title: 'Plan started', person: names.get(String(order.userId)) || 'Customer',
    detail: planName(order), status: order.servicePlanStatus || '',
    relatedEvent: 'plan.started', application: 'portal' })),
  ...reservations.map(row => ({ id: String(row._id), kind: 'offer-reserved', at: row.reservedAt,
    title: 'Offer reserved', person: names.get(String(row.userId)) || 'Customer',
    detail: row.offerSnapshot?.title || row.offerSlug || 'Offer', status: row.closureStatus || '',
    relatedEvent: 'offer.reserved', application: 'portal' })),
  ...broadcasts.map(row => ({ id: String(row._id), kind: 'broadcast', at: row.createdAt, title: 'Broadcast accepted',
    person: names.get(String(row.createdBy)) || 'Admin', detail: row.audience || '', status: row.state || '', application: 'portal' }))]
    .sort((a, b) => new Date(b.at) - new Date(a.at) || b.id.localeCompare(a.id)).slice(0, limit);
}
module.exports = { recentActivity };
