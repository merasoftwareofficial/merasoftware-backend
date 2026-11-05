const Reservation = require('../models/offerReservationModel');
const User = require('../models/userModel');
const { normalizePhone } = require('./whatsappQueue');

// The closing message of an offer reservation (merasoftware/src/docs/reservation-countdown.md).
// When a reservation's deadline (admin extension included) passes, it is decided once:
//   used     – a project is attached (or its first bill is paid): the project message already told them
//   late     – the deadline passed over 24 h ago (the job was off): never a burst of old messages
//   sent     – offer.reservation.expired went by the action's "Send via"
//   not-sent – that route can't reach this person, or the action is Off
// The decision is final, so a project cancelled and released later never triggers a late message.
// Only rows created with closureStatus 'pending' are touched: reservations made before this shipped are not.
const LATE_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const LOCK_MS = 2 * 60 * 1000;
const FINAL = { sent: 'sent', 'not-sent': 'not-sent', paused: 'not-sent', expired: 'not-sent' };

const duePast = now => ({ $or: [{ extendedUntil: null, expiresAt: { $lte: now } }, { extendedUntil: { $lte: now } }] });

async function decide(row, now) {
  if (row.projectId || row.confirmedAt) return { status: 'used' };
  const { deadlineOf } = require('./offerReservations');
  if (now - deadlineOf(row) > LATE_MS) return { status: 'late' };
  const user = await User.findById(row.userId).lean();
  if (!user || user.isGuest || user.isActive === false || user.deletedAt) return { status: 'not-sent', failure: 'The account is not active.' };
  const result = await require('./emailController').sendReservationMail('offer.reservation.expired', row, user, `offer-reservation-expired:${row._id}`);
  return { status: FINAL[result] || 'not-sent', failure: result === 'paused' ? 'Messages for this action are Off.' : '' };
}

async function closeDueReservations({ now = new Date(), limit = 20 } = {}) {
  if (process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED !== 'true') return [];
  const results = [];
  for (let index = 0; index < limit; index++) {
    const row = await Reservation.findOneAndUpdate({
      $and: [
        { $or: [{ closureStatus: 'pending' }, { closureStatus: 'failed', closureNextAttemptAt: { $lte: now } }] },
        duePast(now),
        { $or: [{ closureLockedUntil: null }, { closureLockedUntil: { $lte: now } }] },
      ],
    }, { $set: { closureLockedUntil: new Date(now.getTime() + LOCK_MS) } }, { new: true, sort: { expiresAt: 1 } }).lean();
    if (!row) break;
    let outcome;
    try { outcome = await decide(row, now); }
    catch (error) { outcome = { status: 'failed', failure: error.message }; }
    await Reservation.updateOne({ _id: row._id, closureLockedUntil: row.closureLockedUntil }, { $set: {
      closureStatus: outcome.status, closureFailure: outcome.failure || '', closureLockedUntil: null,
      closureNextAttemptAt: outcome.status === 'failed' ? new Date(now.getTime() + RETRY_MS) : null,
      closureDecidedAt: outcome.status === 'failed' ? null : now,
    } });
    results.push({ id: String(row._id), ...outcome });
  }
  return results;
}

// The Communication tab's Reservation box: counts and the reservations still running.
async function reservationOverview({ now = new Date(), limit = 100 } = {}) {
  const open = { projectId: null, confirmedAt: null };
  const [running, used, expired, closures] = await Promise.all([
    Reservation.find({ ...open, $or: [{ extendedUntil: null, expiresAt: { $gt: now } }, { extendedUntil: { $gt: now } }] })
      .sort({ expiresAt: 1 }).limit(limit).select('userId offerSnapshot.title reservedAt expiresAt extendedUntil origin').lean(),
    Reservation.countDocuments({ $or: [{ projectId: { $ne: null } }, { confirmedAt: { $ne: null } }] }),
    Reservation.countDocuments({ ...open, ...duePast(now) }),
    Reservation.aggregate([{ $match: { closureStatus: { $in: ['sent', 'not-sent', 'late', 'failed'] } } }, { $group: { _id: '$closureStatus', count: { $sum: 1 } } }]),
  ]);
  const users = await User.find({ _id: { $in: running.map(row => row.userId) } }).select('name email phone').lean();
  const runningCount = running.length < limit ? running.length
    : await Reservation.countDocuments({ ...open, $or: [{ extendedUntil: null, expiresAt: { $gt: now } }, { extendedUntil: { $gt: now } }] });
  return {
    serverNow: now,
    counts: { running: runningCount, used, expired, closures: Object.fromEntries(closures.map(row => [row._id, row.count])) },
    running: running.map(row => {
      const user = users.find(item => String(item._id) === String(row.userId));
      // Digits only, the WhatsApp queue's format, which the website's phoneLabel shows as +91 98765 43210.
      return { id: String(row._id), customer: user?.name || user?.email || '', phone: normalizePhone(user?.phone) || '', offer: row.offerSnapshot?.title || '',
        reservedAt: row.reservedAt, deadline: row.extendedUntil || row.expiresAt, extended: !!row.extendedUntil,
        hours: Math.round((new Date(row.expiresAt) - new Date(row.reservedAt)) / 3600000) };
    }),
  };
}

module.exports = { closeDueReservations, reservationOverview, LATE_MS };
