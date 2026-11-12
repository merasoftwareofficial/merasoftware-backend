const Reservation = require('../models/offerReservationModel');
const { EmailPolicy } = require('../models/emailControlModel');

// The existing reservation and stage claim remain the source of truth at each handoff.
const EVENTS = new Set(['offer.reservation.dayPassed', 'offer.reservation.reminder', 'offer.reservation.sixHours', 'offer.reservation.lastHour', 'offer.start.request.admin', 'offer.reservation.expired']);
async function maySendReservationReminder({ event, application, dedupeKey }, now = new Date()) {
  if (!EVENTS.has(event) || application !== 'portal') return true;
  if (event === 'offer.reservation.expired') {
    const expired = /^offer-reservation-expired:([a-f\d]{24})$/i.exec(dedupeKey || '');
    if (!expired) return false;
    const row = await Reservation.findById(expired[1]).lean();
    if (!row || row.projectId || row.confirmedAt || row.startRequestedAt) return false;
    const deadline = new Date(row.extendedUntil || row.expiresAt);
    if (!Number.isFinite(+deadline) || deadline > now || +now - +deadline > 24 * 3600000) return false;
    const policy = await EmailPolicy.findOne({ event }).select('mode').lean();
    return policy?.mode !== 'off';
  }
  if (event === 'offer.start.request.admin') {
    if (/^offer-start-request:[a-f\d]{24}:\d+$/i.test(dedupeKey || '')) return true;
    const pending = /^offer-start-pending:([a-f\d]{24}):(\d+):([1-3])$/i.exec(dedupeKey || '');
    if (!pending) return false;
    const row = await Reservation.findById(pending[1]).lean();
    const index = Number(pending[2]) - 1, request = row?.startRequests?.[index];
    if (!row || row.projectId || row.confirmedAt || row.teamRemindersPaused || !row.startRequestedAt || !request || request.ended || index !== row.startRequests.length - 1 || +new Date(row.startRequestedAt) !== +new Date(request.at) || Number(request.alerts || 0) < Number(pending[3])) return false;
    const policy = await EmailPolicy.findOne({ event }).select('mode').lean();
    return policy?.mode !== 'off';
  }
  const match = /^offer-reservation-reminder:([a-f\d]{24}):(day|24h|6h|1h):(.+)$/i.exec(dedupeKey || '');
  if (!match) return false;
  const row = await Reservation.findById(match[1]).lean();
  if (!row || !row.remindersEnabled || row.remindersPaused || row.projectId || row.confirmedAt || row.startRequestedAt) return false;
  const deadline = new Date(row.extendedUntil || row.expiresAt);
  if (!Number.isFinite(deadline.getTime()) || deadline.toISOString() !== match[3] || deadline <= now || !row.remindersSent?.includes(`${match[2]}:${match[3]}`)) return false;
  const reminder = require('./reservationReminders');
  const stage = match[2] === 'day' ? reminder.dayPassedDue(row, deadline, now) : reminder.dueStage(row, deadline, now);
  if (stage?.event !== event || stage.key !== match[2]) return false;
  const policy = await EmailPolicy.findOne({ event }).select('mode').lean();
  return policy?.mode !== 'off';
}
module.exports = { EVENTS, maySendReservationReminder };
