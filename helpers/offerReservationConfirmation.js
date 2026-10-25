const Reservation = require('../models/offerReservationModel');
const User = require('../models/userModel');

// This drains confirmations only; it neither schedules nor sends payment reminders.
async function drainReservationConfirmations() {
  if (process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED !== 'true') return;
  for (let index = 0; index < 10; index++) {
    const now = new Date();
    const row = await Reservation.findOneAndUpdate({
      confirmationStatus: { $in: ['pending', 'failed', 'paused'] }, confirmationNextAttemptAt: { $lte: now },
      $or: [{ confirmationLockedUntil: null }, { confirmationLockedUntil: { $lte: now } }],
    }, { $set: { confirmationLockedUntil: new Date(now.getTime() + 120000) } }, { new: true });
    if (!row) break;
    let status = 'failed', failure = '';
    try {
      const user = await User.findById(row.userId).lean();
      if (!user || user.isGuest || user.isActive === false || user.deletedAt) status = 'paused';
      else if (require('./offerReservations').deadlineOf(row) <= now) status = 'expired';
      else status = await require('./emailController').sendReservationConfirmation(row, user);
    } catch (error) { failure = error.message; }
    await Reservation.updateOne({ _id: row._id, confirmationLockedUntil: row.confirmationLockedUntil }, { $set: {
      confirmationStatus: status, confirmationFailure: failure, confirmationLockedUntil: null,
      confirmationNextAttemptAt: new Date(Date.now() + 5 * 60000),
    } });
  }
  const notices = await require('../models/reservationNoticeModel').find({ status: { $in: ['pending', 'paused', 'failed'] },
    nextAttemptAt: { $lte: new Date() }, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }] }).sort({ nextAttemptAt: 1 }).limit(10).lean();
  for (const notice of notices) await deliverExtensionNotice(notice.reservationId, notice.version);
}
async function deliverExtensionNotice(reservationId, version) {
  if (process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED !== 'true') return 'off';
  const Notice = require('../models/reservationNoticeModel');
  const now = new Date();
  const notice = await Notice.findOneAndUpdate({ reservationId, version, status: { $in: ['pending', 'paused', 'failed'] },
    $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] }, { $set: { lockedUntil: new Date(now.getTime() + 120000) } }, { new: true });
  if (!notice) return (await Notice.findOne({ reservationId, version }).lean())?.status || 'failed';
  let status = 'failed', failure = '';
  try {
    const row = await Reservation.findById(reservationId).lean();
    const user = row && await User.findById(row.userId).lean();
    if (!row || row.extensions.length !== version) status = 'superseded';
    else if (!user || user.isGuest || user.isActive === false || user.deletedAt) status = 'paused';
    else if (notice.deadline <= now) status = 'expired';
    else status = await require('./emailController').sendReservationMail('offer.reservation.extended', { ...row, extendedUntil: notice.deadline }, user,
      `offer-reservation-extended:${reservationId}:${version}`);
  } catch (error) { failure = error.message; }
  await Notice.updateOne({ _id: notice._id, lockedUntil: notice.lockedUntil }, { $set: {
    status, failure, lockedUntil: null, nextAttemptAt: new Date(Date.now() + 5 * 60000),
  } });
  return status;
}
module.exports = { drainReservationConfirmations, deliverExtensionNotice };
