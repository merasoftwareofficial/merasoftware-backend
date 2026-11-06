const Reservation = require('../models/offerReservationModel');
const User = require('../models/userModel');

// Reminders before a reservation ends (merasoftware/src/docs/reservation-countdown.md, owner decisions 7 Nov 2026):
//   offer.reservation.reminder  when 24 hours are left
//   offer.reservation.lastHour  when 1 hour is left
// Only for a running reservation the customer has not acted on: no project, no locked price, no start request
// (a request pauses the clock). Only reservations made after this shipped (remindersEnabled).
// Rules:
//   - one key per stage and deadline ("24h:<ISO>"): an extension gets its own reminders, a deadline never one twice
//   - a missed run never sends both: only the stage the time left is in now (1 hour wins)
//   - a stage is skipped when the countdown started too close to it, e.g. a 12-hour reservation gets no
//     24-hour reminder, a 25-hour one neither (it would arrive with the start message)
const HOUR = 3600000;
const STAGES = [
  { key: '1h', before: HOUR, event: 'offer.reservation.lastHour' },
  { key: '24h', before: 24 * HOUR, event: 'offer.reservation.reminder' },
];
const enabled = () => process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED === 'true';

// When the current countdown started: the reserve time, or the latest extension (a resume included).
const countdownStart = row => new Date(Math.max(new Date(row.reservedAt).getTime(),
  ...(row.extensions || []).map(item => new Date(item.at).getTime()).filter(Number.isFinite)));

function dueStage(row, deadline, now) {
  const left = deadline - now;
  if (left <= 0) return null;
  const stage = STAGES.find(item => left <= item.before);
  if (!stage) return null;
  if (deadline - countdownStart(row) <= stage.before + HOUR) return null;
  return stage;
}

async function sendDueReminders({ now = new Date(), limit = 50 } = {}) {
  if (!enabled()) return [];
  const { deadlineOf } = require('./offerReservations');
  const soon = new Date(now.getTime() + STAGES[STAGES.length - 1].before);
  const rows = await Reservation.find({ remindersEnabled: true, projectId: null, confirmedAt: null, startRequestedAt: null,
    $or: [{ extendedUntil: null, expiresAt: { $gt: now, $lte: soon } }, { extendedUntil: { $gt: now, $lte: soon } }] })
    .sort({ expiresAt: 1 }).limit(limit).lean();
  const results = [];
  for (const row of rows) {
    const deadline = deadlineOf(row);
    const stage = dueStage(row, deadline, now);
    if (!stage) continue;
    const key = `${stage.key}:${deadline.toISOString()}`;
    if (row.remindersSent?.includes(key)) continue;
    // Claimed only while the reservation is still untouched by a project or a start request.
    const claimed = await Reservation.updateOne({ _id: row._id, remindersSent: { $ne: key }, projectId: null, confirmedAt: null, startRequestedAt: null },
      { $addToSet: { remindersSent: key } });
    if (!claimed.modifiedCount) continue;
    try {
      const user = await User.findById(row.userId).lean();
      if (!user || user.isGuest || user.isActive === false || user.deletedAt) { results.push({ id: String(row._id), stage: stage.key, status: 'not-sent' }); continue; }
      const status = await require('./emailController').sendReservationMail(stage.event, { ...row, reminderNow: now }, user,
        `offer-reservation-reminder:${row._id}:${key}`);
      results.push({ id: String(row._id), stage: stage.key, status });
    } catch (error) {
      // Not sent: release the key so the next run tries again (the dedupe key keeps it once-only).
      await Reservation.updateOne({ _id: row._id }, { $pull: { remindersSent: key } });
      results.push({ id: String(row._id), stage: stage.key, failed: error.message });
    }
  }
  return results;
}

module.exports = { sendDueReminders, dueStage, STAGES };
