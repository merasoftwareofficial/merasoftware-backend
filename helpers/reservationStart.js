const mongoose = require('mongoose');
const Reservation = require('../models/offerReservationModel');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { fail } = require('./salesPackages');
const { CLIENT_LEAD_ORDER, ensureWonLead, isClient } = require('./wonLead');

// "Start my project" on a reserved offer (merasoftware/src/docs/reservation-countdown.md, owner decisions 7 Nov 2026).
// The customer (member or client) confirms once on the offer card. Then:
//   - the clock pauses: no reminder, no closing message, the deadline is not in force (offerReservations.js isPaused)
//   - the person's one lead gets a follow-up line (no status change)
//   - the team gets offer.start.request.admin and the customer offer.start.request.received, each once per request
//   - while nobody acts, the team is reminded once a day, at most 3 times
// Only the team ends the pause: a project created on the reservation, or "Extend deadline" (resume).
// After a resume the customer may ask again; each request has its own messages.
const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_ALERTS = 3;
const LOCK_MS = 2 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const enabled = () => process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED === 'true';

// The person's one lead: a client's Won lead (wonLead.js clientLeadFor order), else the member's linked lead.
async function leadFor(row, session = null) {
  const lead = await Lead.findOne({ convertedToUserId: row.userId, deletedAt: null }).sort(CLIENT_LEAD_ORDER).session(session)
    || await Lead.findOne({ reservationUserId: row.userId, deletedAt: null }).session(session)
    || (row.leadId && await Lead.findOne({ _id: row.leadId, deletedAt: null }).session(session));
  return lead || null;
}
// A line on the lead's follow-up timeline. It never changes the lead's status (owner rule).
async function noteLead(row, note, session = null) {
  const lead = await leadFor(row, session);
  if (!lead) return null;
  const now = new Date();
  await Lead.updateOne({ _id: lead._id }, { $push: { followUps: { note, badge: lead.status, date: now, createdAt: now } } }, { session });
  return lead;
}

async function requestProjectStart({ reservationId, userId }) {
  if (process.env.OFFER_RESERVATIONS_ENABLED !== 'true') fail('Offer reservations are not enabled yet', 503);
  if (!mongoose.isValidObjectId(reservationId)) fail('Choose a reservation');
  const { activeOwner, deadlineOf, isPaused, reservationView, indiaTime } = require('./offerReservations');
  const user = await activeOwner(userId);
  const row = await Reservation.findOne({ _id: reservationId, userId }).lean();
  if (!row) fail('Reservation not found', 404);
  // A repeat click returns the saved request; it never sends its messages again.
  if (isPaused(row)) return { reservation: reservationView(row), requested: false };
  if (row.projectId || row.confirmedAt) fail('A project has already been started on this reservation.', 409);
  const now = new Date();
  const remainingMs = deadlineOf(row).getTime() - now.getTime();
  if (remainingMs <= 0) fail('This reservation has ended.', 409);
  // Atomic against the closing job: the deadline must still be ahead and the row not being closed.
  const updated = await Reservation.findOneAndUpdate({ $and: [
    { _id: row._id, startRequestedAt: null, projectId: null, confirmedAt: null, expiresAt: row.expiresAt, extendedUntil: row.extendedUntil || null },
    { $or: [{ extendedUntil: null, expiresAt: { $gt: now } }, { extendedUntil: { $gt: now } }] },
    { $or: [{ closureLockedUntil: null }, { closureLockedUntil: { $lte: now } }] },
  ] }, { $set: { startRequestedAt: now, pausedRemainingMs: remainingMs }, $push: { startRequests: { at: now, remainingMs } } }, { new: true }).lean();
  if (!updated) {
    const fresh = await Reservation.findById(row._id).lean();
    if (isPaused(fresh)) return { reservation: reservationView(fresh), requested: false };
    fail('This reservation can no longer be started here. Please contact us.', 409);
  }
  try {
    // A client without a lead gets the Won lead every client has (wonLead.js); a member's was made at reserve.
    if (isClient(user)) await ensureWonLead(user);
    await noteLead(updated, `Wants to start the project on ${updated.offerSnapshot.title} (reserved ₹${Number(updated.reservedPrice).toLocaleString('en-IN')}). `
      + `Requested from the offer page; reservation paused with ${timeLeftWords(remainingMs)} left (deadline was ${indiaTime(deadlineOf(updated))}).`);
  } catch (error) { console.error('[reservation start] lead follow-up:', error.message); }
  return { reservation: reservationView(updated), requested: true };
}

// "about 23 hours", "about 45 minutes": the words the messages use for the time that is (or was) left.
function timeLeftWords(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

// What the two start messages need besides the reservation: which request, the lead, client or member.
async function messageContext(row, index, extra = {}) {
  const user = await User.findById(row.userId).lean();
  const lead = await leadFor(row);
  return { user, reservation: { ...row, startRequest: row.startRequests[index], requestNumber: index + 1, leadId: lead?._id || null,
    isClient: isClient(user), ...extra } };
}

// Sends each request's two messages once (dedupe keys per request). Called right after the request and by the job.
async function deliverStartNotices({ reservationId = null, now = new Date(), limit = 10 } = {}) {
  if (!enabled()) return [];
  const rows = await Reservation.find({ ...(reservationId ? { _id: reservationId } : {}), startRequests: { $elemMatch: { noticesAt: null,
    $or: [{ noticeNextAttemptAt: null }, { noticeNextAttemptAt: { $lte: now } }] } } }).limit(limit).lean();
  const results = [];
  for (const row of rows) {
    for (let index = 0; index < row.startRequests.length; index++) {
      const entry = row.startRequests[index];
      if (entry.noticesAt || (entry.noticeNextAttemptAt && entry.noticeNextAttemptAt > now)) continue;
      const path = `startRequests.${index}`;
      // The lock: only one caller sends a request's messages at a time.
      const claimed = await Reservation.updateOne({ _id: row._id, [`${path}.noticesAt`]: null, [`${path}.noticeNextAttemptAt`]: entry.noticeNextAttemptAt ?? null },
        { $set: { [`${path}.noticeNextAttemptAt`]: new Date(now.getTime() + LOCK_MS) } });
      if (!claimed.modifiedCount) continue;
      try {
        const { user, reservation } = await messageContext(row, index);
        const send = require('./emailController').sendReservationMail;
        const team = await send('offer.start.request.admin', reservation, user, `offer-start-request:${row._id}:${index + 1}`);
        const customer = user && !user.deletedAt && user.isActive !== false
          ? await send('offer.start.request.received', reservation, user, `offer-start-received:${row._id}:${index + 1}`) : 'not-sent';
        await Reservation.updateOne({ _id: row._id }, { $set: { [`${path}.noticesAt`]: new Date(), [`${path}.noticeFailure`]: '' } });
        results.push({ id: String(row._id), request: index + 1, team, customer });
      } catch (error) {
        await Reservation.updateOne({ _id: row._id }, { $set: { [`${path}.noticeFailure`]: error.message, [`${path}.noticeNextAttemptAt`]: new Date(now.getTime() + RETRY_MS) } });
        results.push({ id: String(row._id), request: index + 1, failed: error.message });
      }
    }
  }
  return results;
}

// A request nobody acted on: the team is told again after each full day, at most 3 times.
async function alertPendingStarts({ now = new Date(), limit = 20 } = {}) {
  if (!enabled()) return [];
  const rows = await Reservation.find({ startRequestedAt: { $lte: new Date(now.getTime() - DAY) }, projectId: null, confirmedAt: null })
    .sort({ startRequestedAt: 1 }).limit(limit).lean();
  const results = [];
  for (const row of rows) {
    const index = row.startRequests.length - 1;
    const entry = row.startRequests[index];
    const alerts = entry?.alerts || 0;
    const days = Math.floor((now - new Date(row.startRequestedAt)) / DAY);
    if (!entry || entry.ended || alerts >= MAX_ALERTS || days <= alerts) continue;
    const path = `startRequests.${index}.alerts`;
    const claimed = await Reservation.updateOne({ _id: row._id, startRequestedAt: row.startRequestedAt, [path]: entry.alerts ?? 0 }, { $set: { [path]: alerts + 1 } });
    if (!claimed.modifiedCount) continue;
    try {
      const { user, reservation } = await messageContext(row, index, { waitingDays: days });
      const status = await require('./emailController').sendReservationMail('offer.start.request.admin', reservation, user,
        `offer-start-pending:${row._id}:${index + 1}:${alerts + 1}`);
      results.push({ id: String(row._id), alert: alerts + 1, status });
    } catch (error) {
      // Not sent: give the alert back so the next run tries again.
      await Reservation.updateOne({ _id: row._id, [path]: alerts + 1 }, { $set: { [path]: alerts } });
      results.push({ id: String(row._id), alert: alerts + 1, failed: error.message });
    }
  }
  return results;
}

module.exports = { requestProjectStart, deliverStartNotices, alertPendingStarts, noteLead, leadFor, timeLeftWords, MAX_ALERTS };
