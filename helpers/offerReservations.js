const mongoose = require('mongoose');
const Reservation = require('../models/offerReservationModel');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const Transaction = require('../models/transactionModel');
const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { calculateBenefit, fail } = require('./salesPackages');
const { parsePhone } = require('./phoneNumber');
const { claimInquiryLead } = require('./leadPhone');
const HOUR = 60 * 60 * 1000;
const safeSlug = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
// The existing payment state for a submitted project payment awaiting admin approval.
const PENDING_PAYMENT = { type: 'payment', status: 'pending', paymentStatus: 'pending-approval' };

// The deadline in force: an admin extension, otherwise the original 72 hours.
const deadlineOf = row => new Date(row.extendedUntil || row.expiresAt);

// underReview: a payment submitted before the deadline still awaits approval (read-only state).
function reservationView(row, now = Date.now(), underReview = false) {
  const deadline = deadlineOf(row);
  return { id: String(row._id), offerSlug: row.offerSlug, title: row.offerSnapshot.title,
    reservedPrice: row.reservedPrice, regularPrice: row.regularPrice,
    terms: row.offerSnapshot.resolvedTerms || [], reservedAt: row.reservedAt, expiresAt: row.expiresAt, periodEndsAt: row.periodEndsAt,
    deadline, extendedUntil: row.extendedUntil || null,
    status: row.confirmedAt ? 'confirmed' : underReview ? 'under_review' : deadline.getTime() <= now ? 'expired' : 'reserved',
    resolution: row.resolution?.status || null,
    walletCredit: Number(row.resolution?.walletCredit || 0),
    projectId: row.projectId ? String(row.projectId) : null, confirmationStatus: row.confirmationStatus };
}
// Rows whose linked project has a payment submitted before the deadline that still awaits approval.
async function reviewedReservationIds(userId, rows, session = null) {
  const open = rows.filter(row => row.projectId && !row.confirmedAt);
  if (!open.length) return new Set();
  const pending = await Transaction.find({ ...PENDING_PAYMENT, userId, orderId: { $in: open.map(row => row.projectId) } }).select('orderId createdAt').session(session).lean();
  return new Set(open.filter(row => pending.some(payment => String(payment.orderId) === String(row.projectId)
    && new Date(payment.createdAt) <= deadlineOf(row))).map(row => String(row._id)));
}
async function activeOwner(userId, session) {
  const user = await User.findById(userId).session(session || null);
  if (!user || user.isGuest || user.isActive === false || user.deletedAt) fail('An active permanent account is required', 403);
  return user;
}
async function listReservations(userId) {
  await activeOwner(userId);
  await require('./reservationRelease').repairUserReservationLinks(userId);
  // Bring any due unpaid project to its post-deadline price before showing it (no-op unless enabled).
  await require('./reservationRepricing').reconcileUserReservations(userId);
  const now = Date.now();
  const rows = await Reservation.find({ userId }).sort({ reservedAt: -1 }).lean();
  const underReview = await reviewedReservationIds(userId, rows);
  const linkedProjects = await require('../models/orderProductModel').find({ _id: { $in: rows.filter(row => row.projectId).map(row => row.projectId) } })
    .select('_id orderVisibility').lean();
  const openProjects = new Set(linkedProjects.filter(order => order.orderVisibility !== 'cancelled').map(order => String(order._id)));
  return { reservations: rows.map(row => ({ ...reservationView(row, now, underReview.has(String(row._id))),
    reuseNeedsReview: Boolean(row.projectId && !openProjects.has(String(row.projectId))) })), serverNow: new Date(now) };
}
// How many hours before an offer ends public Reserve opens. Each offer sets it on the website
// (owner decision 25 Oct 2026; website src/lib/offers.ts reserveWindowHours, 1–720). Offers
// without the field keep the original 24 hours. The website mirrors this rule only to show or
// hide its button (src/lib/offer-reservation-rules.ts); this check stays the authority.
const DEFAULT_RESERVE_WINDOW_HOURS = 24;
const reserveWindowHours = offer => Number.isInteger(offer?.reserveWindowHours) && offer.reserveWindowHours >= 1 && offer.reserveWindowHours <= 720
  ? offer.reserveWindowHours : DEFAULT_RESERVE_WINDOW_HOURS;
const indiaTime = value => `${new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} IST`;
// Why a public reservation is refused right now, in words the customer understands; null = allowed.
function reservationRefusal(offer, now) {
  const endsAt = Date.parse(offer?.endsAt);
  if (!offer || offer.status !== 'published' || !Number.isFinite(endsAt)) return 'This offer is not available.';
  if (endsAt <= now) return 'This offer has ended.';
  if (offer.targets && !offer.targets.includes('projects')) return 'This offer cannot be reserved. Please enquire about it instead.';
  const opensAt = endsAt - reserveWindowHours(offer) * HOUR;
  if (now < opensAt) return `Reservation opens on ${indiaTime(opensAt)}.`;
  return null;
}
// An expired, unpaid, unattached reservation may be followed by one new reservation in a later
// offer period (owner decision 11). Anything else is returned unchanged on a repeat request.
const renewable = (row, now) => !row.confirmedAt && !row.projectId && deadlineOf(row).getTime() <= now;

async function reserveOffer({ userId, offerSlug, quoteKey, countryCode, phone }) {
  if (process.env.OFFER_RESERVATIONS_ENABLED !== 'true') fail('Offer reservations are not enabled yet', 503);
  if (!safeSlug(offerSlug)) fail('Choose a valid offer');
  const enteredPhone = phone ? parsePhone({ countryCode, phone }) : null;
  await activeOwner(userId);
  // A retry remains successful even after the public deadline/catalogue changes.
  const previous = await Reservation.findOne({ userId, offerSlug }).sort({ reservedAt: -1 });
  if (previous && !renewable(previous, Date.now())) return { reservation: reservationView(previous), reused: true, serverNow: new Date() };
  const { offers } = await fetchWebsiteCatalogue();
  const offer = offers.find(row => row.slug === offerSlug);
  const periodEndsAt = offer ? new Date(offer.endsAt) : null;
  if (previous && (!periodEndsAt || periodEndsAt <= new Date(previous.periodEndsAt))) return { reservation: reservationView(previous), reused: true, serverNow: new Date() };
  const price = offer ? calculateBenefit(Number(offer.mainPrice), offer).finalPrice : null;
  return mongoose.connection.transaction(async session => {
    const user = await activeOwner(userId, session);
    // Serialize concurrent offers for one owner, so two requests cannot create two leads.
    await User.updateOne({ _id: userId }, { $inc: { __v: 1 } }, { session });
    const existing = periodEndsAt && await Reservation.findOne({ userId, offerSlug, periodEndsAt }).session(session);
    if (existing) return { reservation: reservationView(existing), reused: true, serverNow: new Date() };
    const now = new Date();
    const refusal = reservationRefusal(offer, now.getTime());
    if (refusal) fail(refusal, 409);
    if (typeof quoteKey !== 'string' || !quoteKey || quoteKey !== offer.quoteKey) fail('Offer price or terms changed. Review the offer before reserving.', 409);
    // Owner rule: no lead and no reservation without a phone. Older accounts add it here once.
    if (!user.phone) {
      if (!enteredPhone) fail('Add your mobile number to reserve this offer', 428);
      user.phone = enteredPhone; user.phoneVerified = false;
      await user.save({ session });
    }
    let lead = null;
    if (!user.roles.includes('customer') && user.roles.includes('member')) {
      lead = await Lead.findOne({ reservationUserId: userId }).session(session);
      if (lead?.deletedAt || lead?.convertedToUserId) fail('The linked lead needs team review before another reservation', 409);
      if (!lead) lead = await claimInquiryLead(user.phone, { name: user.name || user.email, email: user.email, reservationUserId: userId }, { session });
      if (!lead) [lead] = await Lead.create([{ name: user.name || user.email, email: user.email, phone: user.phone,
        source: 'Offer reservation', reservationUserId: userId }], { session });
      else if (!lead.phone) { lead.phone = user.phone; await lead.save({ session }); }
    }
    const [row] = await Reservation.create([{ userId, offerSlug, periodEndsAt, offerSnapshot: offer,
      regularPrice: Number(offer.mainPrice), reservedPrice: price, reservedAt: now,
      expiresAt: new Date(now.getTime() + 72 * HOUR), origin: 'customer', leadId: lead?._id }], { session });
    return { reservation: reservationView(row), reused: false, serverNow: now };
  });
}
// Called inside the existing project-creation transaction, never as a second commit.
// reservationId: the customer's saved reservation the admin explicitly selected, if any.
async function attachProjectReservation({ order, offer, reservationId = null, session }) {
  if (!offer || process.env.OFFER_RESERVATIONS_ENABLED !== 'true') return null;
  await User.updateOne({ _id: order.userId }, { $inc: { __v: 1 } }, { session });
  const now = new Date();
  let row = reservationId
    ? await Reservation.findOne({ _id: reservationId, userId: order.userId }).session(session)
    : await Reservation.findOne({ userId: order.userId, offerSlug: offer.slug, periodEndsAt: new Date(offer.endsAt) }).session(session);
  if (reservationId && !row) fail('This customer reservation is unavailable', 409);
  if (row) {
    if (row.projectId && String(row.projectId) !== String(order._id)) fail('This reservation is already attached to a project', 409);
    if (deadlineOf(row) <= now && !row.confirmedAt) fail('This reservation expired. Historical application requires the admin force protocol.', 409);
    if (row.offerSnapshot.quoteKey !== offer.quoteKey) fail('Select the saved reservation to keep its original price and terms', 409);
  } else {
    if (offer.status !== 'published' || Date.parse(offer.endsAt) <= now.getTime()) fail('Offer expired before the project was saved', 409);
    // The reservation keeps this project's own scope price (a package quote differs from the offer's main price).
    const agreement = order.projectSnapshot?.salesAgreement;
    const regularPrice = Number(agreement?.regularPrice ?? offer.mainPrice);
    const reservedPrice = Number(agreement?.packagePrice ?? calculateBenefit(regularPrice, offer).finalPrice);
    [row] = await Reservation.create([{ userId: order.userId, offerSlug: offer.slug, periodEndsAt: new Date(offer.endsAt), offerSnapshot: offer,
      regularPrice, reservedPrice, reservedAt: now, expiresAt: new Date(now.getTime() + 72 * HOUR), origin: 'admin_project', projectId: order._id }], { session });
  }
  row.projectId = order._id;
  order.offerReservationId = row._id;
  await row.save({ session });
  return row;
}
async function confirmReservationPayment({ order, invoice, session }) {
  if (!order.offerReservationId || invoice.status !== 'paid' || (invoice.installmentNumber && invoice.installmentNumber !== 1)) return;
  // Persist the receipt milestone in the financial commit. Later installments cannot clear it.
  const row = await Reservation.findOne({ _id: order.offerReservationId, userId: order.userId, projectId: order._id }).session(session);
  if (!row || row.confirmedAt) return;
  // Owner rule: a payment counts when it was submitted, not when an admin approved it.
  // Settlement has already linked every completed part to this invoice; the full amount
  // stood submitted when its latest part was. A free invoice has no parts.
  const parts = await Transaction.find({ invoiceId: invoice._id, type: 'payment', status: 'completed' }).select('createdAt').session(session).lean();
  const submittedAt = parts.length ? new Date(Math.max(...parts.map(part => new Date(part.createdAt).getTime()))) : invoice.paidDate || new Date();
  // A late payment settles the (already repriced, or about to be repriced) bill without a lock.
  if (submittedAt > deadlineOf(row) || row.resolution) return;
  row.confirmedAt = submittedAt;
  await row.save({ session });
}
// Server-side role check for reservation admin commands; UI visibility is never authorization.
async function currentAdmin(actorId, session = null) {
  const actor = await User.findById(actorId).session(session);
  if (!actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) fail('Current portal admin access required', 403);
  return actor;
}

// Owner decision 7: admin-only extension, any length, reason + audit, only before any repricing.
// The original expiresAt stays as history; the customer is told the exact new deadline.
async function extendReservation({ reservationId, actorId, until, reason }) {
  const deadline = new Date(until);
  const note = String(reason || '').trim();
  if (!mongoose.isValidObjectId(reservationId)) fail('Choose a reservation');
  if (!Number.isFinite(deadline.getTime()) || deadline <= new Date()) fail('Choose a new deadline in the future');
  if (!note || note.length > 300) fail('Enter a reason for the extension (up to 300 characters)');
  const row = await mongoose.connection.transaction(async session => {
    await currentAdmin(actorId, session);
    const fresh = await Reservation.findById(reservationId).session(session);
    if (!fresh) fail('Reservation not found', 404);
    if (fresh.confirmedAt) fail('This reservation is already price-locked', 409);
    if (fresh.resolution?.closedAt) fail('The first bill of this project is already settled or closed', 409);
    if (fresh.resolution && fresh.resolution.status !== 'unchanged') fail('The price was already revised. Use force-apply to restore the reserved price.', 409);
    const current = deadlineOf(fresh);
    if (deadline <= current) fail('The new deadline must be later than the current deadline', 409);
    fresh.extensions.push({ from: current, to: deadline, reason: note, actorId, at: new Date() });
    fresh.extendedUntil = deadline;
    fresh.resolution = null;
    await fresh.save({ session });
    await require('../models/reservationNoticeModel').create([{ reservationId: fresh._id, version: fresh.extensions.length, deadline }], { session });
    return fresh;
  });
  let notice = 'off';
  if (process.env.OFFER_RESERVATION_CONFIRMATIONS_ENABLED === 'true') {
    try {
      notice = await require('./offerReservationConfirmation').deliverExtensionNotice(row._id, row.extensions.length);
    } catch (error) { notice = 'failed'; console.error('[reservation extension notice]', error.message); }
  }
  return { reservation: reservationView(row), notice };
}
module.exports = { reserveOffer, listReservations, reservationView, attachProjectReservation, confirmReservationPayment,
  extendReservation, currentAdmin, deadlineOf, reviewedReservationIds, activeOwner, reservationRefusal, reserveWindowHours, PENDING_PAYMENT };
