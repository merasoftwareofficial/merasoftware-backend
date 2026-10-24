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
      else if (row.expiresAt <= now) status = 'expired';
      else status = await require('./emailController').sendReservationConfirmation(row, user);
    } catch (error) { failure = error.message; }
    await Reservation.updateOne({ _id: row._id, confirmationLockedUntil: row.confirmationLockedUntil }, { $set: {
      confirmationStatus: status, confirmationFailure: failure, confirmationLockedUntil: null,
      confirmationNextAttemptAt: new Date(Date.now() + 5 * 60000),
    } });
  }
}
module.exports = { drainReservationConfirmations };
