const Lead = require('../models/leadModel');
const Target = require('../models/offerTargetModel');
const Reservation = require('../models/offerReservationModel');
const { RESERVATION, NOT_NOW, WON } = require('./leadStatuses');

// The stages an offer reservation sets (merasoftware/src/docs/reservation-countdown.md, owner decisions 8 Nov 2026).
// The reservation itself, its countdown, start request, project and payment rules stay in offerReservations.js;
// this file only moves stages, and only from Reservation, so a stage the admin chose is never overwritten.
//   reserved   – a lead (not a client yet) goes to Reservation, whatever its stage; a client keeps its behaviour.
//                That offer's stage goes to Reservation for both.
//   project    – a project made on the reservation: that offer is Matured (as Bought this offer).
//   expired    – no project by the deadline: the offer goes Not Now, and the lead too unless another of the
//                person's reservations is still running. No Not Now review: the closing message already went.
// The person is found as the start request finds them (reservationStart.js leadFor): a client's Won lead, else the
// member's lead.

const line = (note, badge, offerSlug, at = new Date()) => ({ note, badge, date: at, createdAt: at, ...(offerSlug ? { offerSlug } : {}) });
const title = row => row.offerSnapshot?.title || row.offerSlug;

/** That offer's stage for this person: created when missing, never moved off Matured. Returns true when it changed. */
async function setOfferStage(lead, row, stage, { from = null, session = null, extra = {} } = {}) {
  const filter = { leadId: lead._id, offerSlug: row.offerSlug, stage: from ? from : { $ne: WON } };
  const changed = await Target.updateOne(filter, { $set: { stage, offerTitle: title(row), ...extra } }, { session });
  if (changed.modifiedCount) return true;
  if (from || await Target.exists({ leadId: lead._id, offerSlug: row.offerSlug }).session(session)) return false;
  await Target.create([{ leadId: lead._id, offerSlug: row.offerSlug, offerTitle: title(row), stage, ...extra }], { session });
  return true;
}

/** Inside the reserve transaction. Returns the lead whose stage moved off Negative or Dead, for the final message check. */
async function onReserved(row, { session } = {}) {
  const { leadFor } = require('./reservationStart');
  const lead = await leadFor(row, session);
  if (!lead) return null;
  const { indiaTime } = require('./offerReservations');
  const note = `Reserved ${title(row)}. The reservation ends on ${indiaTime(row.extendedUntil || row.expiresAt)}.`;
  await setOfferStage(lead, row, RESERVATION, { session });
  if (lead.convertedToUserId) {
    await Lead.updateOne({ _id: lead._id }, { $push: { followUps: line(note, RESERVATION, row.offerSlug) } }, { session });
    return null;
  }
  await Lead.updateOne({ _id: lead._id }, { $set: { status: RESERVATION }, $push: { followUps: line(note, RESERVATION) } }, { session });
  return lead.status !== RESERVATION ? lead._id : null;
}

/** Inside the project-creation transaction: the offer this project was made on is Matured for the person. */
async function onProjectAttached(row, { session, actor = null } = {}) {
  const lead = await require('./reservationStart').leadFor(row, session);
  if (!lead) return false;
  const now = new Date();
  const changed = await setOfferStage(lead, row, WON, { session, extra: { boughtAt: now, boughtBy: actor } });
  if (changed) await Lead.updateOne({ _id: lead._id }, { $push: { followUps: line(`Bought ${title(row)}: a project was created on the reservation.`, WON, row.offerSlug, now) } }, { session });
  return changed;
}

/** Another reservation of this person still running (paused ones count). */
const otherRunning = (row, now) => Reservation.exists({ _id: { $ne: row._id }, userId: row.userId, projectId: null, confirmedAt: null,
  $or: [{ startRequestedAt: { $ne: null } }, { extendedUntil: null, expiresAt: { $gt: now } }, { extendedUntil: { $gt: now } }] });

/** After the closing decision, for a reservation that ended with no project. */
async function onExpired(row, { now = new Date() } = {}) {
  const lead = await require('./reservationStart').leadFor(row);
  if (!lead) return { offer: false, lead: false };
  const offer = await setOfferStage(lead, row, NOT_NOW, { from: RESERVATION });
  let moved = false;
  if (!lead.convertedToUserId && lead.status === RESERVATION && !await otherRunning(row, now)) {
    const changed = await Lead.updateOne({ _id: lead._id, status: RESERVATION }, { $set: { status: NOT_NOW },
      $push: { followUps: line(`The reservation for ${title(row)} ended without a project. Moved to Not Now.`, NOT_NOW, null, now) } });
    moved = changed.modifiedCount > 0;
  }
  if (offer && !moved) await Lead.updateOne({ _id: lead._id }, { $push: { followUps: line(`The reservation for ${title(row)} ended without a project.`, NOT_NOW, row.offerSlug, now) } });
  return { offer, lead: moved };
}

module.exports = { onReserved, onProjectAttached, onExpired };
