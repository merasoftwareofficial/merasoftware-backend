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
        // A start request pauses the clock (helpers/reservationStart.js): never closed while it waits for the team.
        { startRequestedAt: null },
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
    // Ended with no project: the offer, and the lead unless another reservation runs, go Not Now (helpers/reservationStage.js).
    // The decision above is final, so this runs once; a failure here is logged and never undoes it.
    if (!['used', 'failed'].includes(outcome.status)) {
      try { outcome.stage = await require('./reservationStage').onExpired(row, { now }); }
      catch (error) { console.error('[reservation closure] stage after expiry:', error.message); }
    }
    results.push({ id: String(row._id), ...outcome });
  }
  return results;
}

// The Communication tab's Reservation box: counts and the reservations still running. A paused one
// (start requested) is running whatever its old deadline says, and is listed first, oldest request first.
async function reservationOverview({ now = new Date(), limit = 100 } = {}) {
  const open = { projectId: null, confirmedAt: null };
  const runningQuery = { ...open, $or: [{ startRequestedAt: { $ne: null } }, { extendedUntil: null, expiresAt: { $gt: now } }, { extendedUntil: { $gt: now } }] };
  const [running, used, expired, closures] = await Promise.all([
    Reservation.find(runningQuery).sort({ startRequestedAt: -1, expiresAt: 1 }).limit(limit)
      .select('userId offerSnapshot.title reservedAt expiresAt extendedUntil origin startRequestedAt').lean(),
    Reservation.countDocuments({ $or: [{ projectId: { $ne: null } }, { confirmedAt: { $ne: null } }] }),
    Reservation.countDocuments({ ...open, startRequestedAt: null, ...duePast(now) }),
    Reservation.aggregate([{ $match: { closureStatus: { $in: ['sent', 'not-sent', 'late', 'failed'] } } }, { $group: { _id: '$closureStatus', count: { $sum: 1 } } }]),
  ]);
  // Open "Start my project" requests on packages without an offer (helpers/packageStart.js), oldest first.
  const starts = await require('../models/packageStartRequestModel').find({ closedAt: null }).sort({ requestedAt: 1 }).limit(limit)
    .select('userId packageSnapshot requestedAt').lean();
  const users = await User.find({ _id: { $in: [...running, ...starts].map(row => row.userId) } }).select('name email phone').lean();
  const runningCount = running.length < limit ? running.length
    : await Reservation.countDocuments(runningQuery);
  // Paused first, the longest-waiting request at the top; then by deadline.
  running.sort((a, b) => (a.startRequestedAt ? 0 : 1) - (b.startRequestedAt ? 0 : 1)
    || (a.startRequestedAt && b.startRequestedAt ? new Date(a.startRequestedAt) - new Date(b.startRequestedAt) : 0)
    || new Date(a.extendedUntil || a.expiresAt) - new Date(b.extendedUntil || b.expiresAt));
  return {
    serverNow: now,
    counts: { running: runningCount, used, expired, closures: Object.fromEntries(closures.map(row => [row._id, row.count])) },
    running: running.map(row => {
      const user = users.find(item => String(item._id) === String(row.userId));
      // Digits only, the WhatsApp queue's format, which the website's phoneLabel shows as +91 98765 43210.
      return { id: String(row._id), customer: user?.name || user?.email || '', phone: normalizePhone(user?.phone) || '', offer: row.offerSnapshot?.title || '',
        reservedAt: row.reservedAt, deadline: row.extendedUntil || row.expiresAt, extended: !!row.extendedUntil, startRequestedAt: row.startRequestedAt || null,
        hours: Math.round((new Date(row.expiresAt) - new Date(row.reservedAt)) / 3600000) };
    }),
    packageStarts: starts.map(row => {
      const user = users.find(item => String(item._id) === String(row.userId));
      return { id: String(row._id), customer: user?.name || user?.email || '', phone: normalizePhone(user?.phone) || '',
        package: row.packageSnapshot?.name || '', price: row.packageSnapshot?.price ?? null, choice: row.packageSnapshot?.choice || null,
        billing: row.packageSnapshot?.billing || null, userId: String(row.userId), requestedAt: row.requestedAt };
    }),
  };
}

module.exports = { closeDueReservations, reservationOverview, LATE_MS };
