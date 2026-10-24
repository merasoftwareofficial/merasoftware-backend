const mongoose = require('mongoose');
const Reservation = require('../models/offerReservationModel');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { calculateBenefit, fail } = require('./salesPackages');
const HOUR = 60 * 60 * 1000;
const safeSlug = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;

function reservationView(row, now = Date.now()) {
  return { id: String(row._id), offerSlug: row.offerSlug, title: row.offerSnapshot.title,
    reservedPrice: row.reservedPrice, regularPrice: row.regularPrice,
    terms: row.offerSnapshot.resolvedTerms || [], reservedAt: row.reservedAt, expiresAt: row.expiresAt,
    status: row.confirmedAt ? 'confirmed' : new Date(row.expiresAt).getTime() <= now ? 'expired' : 'reserved',
    projectId: row.projectId ? String(row.projectId) : null, confirmationStatus: row.confirmationStatus };
}
async function activeOwner(userId, session) {
  const user = await User.findById(userId).session(session || null);
  if (!user || user.isGuest || user.isActive === false || user.deletedAt) fail('An active permanent account is required', 403);
  return user;
}
async function listReservations(userId) {
  await activeOwner(userId);
  const now = Date.now();
  const rows = await Reservation.find({ userId }).sort({ reservedAt: -1 }).lean();
  return { reservations: rows.map(row => reservationView(row, now)), serverNow: new Date(now) };
}

async function reserveOffer({ userId, offerSlug, quoteKey }) {
  if (process.env.OFFER_RESERVATIONS_ENABLED !== 'true') fail('Offer reservations are not enabled yet', 503);
  if (!safeSlug(offerSlug)) fail('Choose a valid offer');
  await activeOwner(userId);
  // A retry remains successful even after the public deadline/catalogue changes.
  const previous = await Reservation.findOne({ userId, offerSlug });
  if (previous) return { reservation: reservationView(previous), reused: true, serverNow: new Date() };
  const { offers } = await fetchWebsiteCatalogue();
  const offer = offers.find(row => row.slug === offerSlug);
  const price = offer ? calculateBenefit(Number(offer.mainPrice), offer).finalPrice : null;
  return mongoose.connection.transaction(async session => {
    const user = await activeOwner(userId, session);
    // Serialize concurrent offers for one owner, so two requests cannot create two leads.
    await User.updateOne({ _id: userId }, { $inc: { __v: 1 } }, { session });
    const existing = await Reservation.findOne({ userId, offerSlug }).session(session);
    if (existing) return { reservation: reservationView(existing), reused: true, serverNow: new Date() };
    const now = new Date();
    const remaining = Date.parse(offer?.endsAt) - now.getTime();
    if (!offer || offer.status !== 'published' || !Number.isFinite(remaining) || remaining <= 0 || remaining > 24 * HOUR
      || (offer.targets && !offer.targets.includes('projects'))) fail('Reservation is available only in the final 24 hours of a live project offer', 409);
    if (typeof quoteKey !== 'string' || !quoteKey || quoteKey !== offer.quoteKey) fail('Offer price or terms changed. Review the offer before reserving.', 409);
    let lead = null;
    if (!user.roles.includes('customer') && user.roles.includes('member')) {
      lead = await Lead.findOne({ reservationUserId: userId }).session(session);
      if (lead?.deletedAt || lead?.convertedToUserId) fail('The linked lead needs team review before another reservation', 409);
      if (!lead) [lead] = await Lead.create([{ name: user.name || user.email, email: user.email, phone: user.phone || '',
        source: 'Offer reservation', reservationUserId: userId }], { session });
    }
    const [row] = await Reservation.create([{ userId, offerSlug, offerSnapshot: offer,
      regularPrice: Number(offer.mainPrice), reservedPrice: price, reservedAt: now,
      expiresAt: new Date(now.getTime() + 72 * HOUR), origin: 'customer', leadId: lead?._id }], { session });
    return { reservation: reservationView(row), reused: false, serverNow: now };
  });
}
// Called inside the existing project-creation transaction, never as a second commit.
async function attachProjectReservation({ order, offer, session }) {
  if (!offer || process.env.OFFER_RESERVATIONS_ENABLED !== 'true') return null;
  await User.updateOne({ _id: order.userId }, { $inc: { __v: 1 } }, { session });
  let row = await Reservation.findOne({ userId: order.userId, offerSlug: offer.slug }).session(session);
  const now = new Date();
  if (row) {
    if (row.projectId && String(row.projectId) !== String(order._id)) fail('This reservation is already attached to a project', 409);
    if (row.expiresAt <= now && !row.confirmedAt) fail('This reservation expired. Historical application requires the admin force protocol.', 409);
    if (row.offerSnapshot.quoteKey !== offer.quoteKey) fail('Select the saved reservation to keep its original price and terms', 409);
  } else {
    if (offer.status !== 'published' || Date.parse(offer.endsAt) <= now.getTime()) fail('Offer expired before the project was saved', 409);
    [row] = await Reservation.create([{ userId: order.userId, offerSlug: offer.slug, offerSnapshot: offer,
      regularPrice: Number(offer.mainPrice), reservedPrice: calculateBenefit(Number(offer.mainPrice), offer).finalPrice,
      reservedAt: now, expiresAt: new Date(now.getTime() + 72 * HOUR), origin: 'admin_project', projectId: order._id }], { session });
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
  const receivedAt = invoice.paidDate || new Date();
  if (receivedAt > row.expiresAt) return; // Late-payment commercial handling remains a separate revision decision.
  row.confirmedAt = receivedAt;
  await row.save({ session });
}
module.exports = { reserveOffer, listReservations, reservationView, attachProjectReservation, confirmReservationPayment };
