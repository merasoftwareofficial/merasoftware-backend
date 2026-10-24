const mongoose = require('mongoose');
const Reservation = require('../models/offerReservationModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const Revision = require('../models/projectPricingRevisionModel');
const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { offerEligible, calculateBenefit, money, fail } = require('./salesPackages');
const { buildLineItemsFromOrder } = require('./paymentRecording');
const { setOrderPaidAmount, getInvoiceAmountReceived, deriveInvoiceStatus } = require('./orderPaymentTotals');
const { syncProjectFinalInvoice } = require('./projectFinalInvoice');
const { buildInstallments } = require('./projectInstallments');
const { deadlineOf, PENDING_PAYMENT } = require('./offerReservations');

// Reservation expiry repricing (owner decisions 4–5, 24 Oct 2026). One shared operation for the
// scheduled job, payment entry points and admin screens. Separate activation switch.
const enabled = () => process.env.OFFER_RESERVATION_REPRICING_ENABLED === 'true';
const cents = value => Math.round(Number(value) * 100);
const STOPPED = ['needs_review', 'force_applied'];

// Due: linked project, no price lock, deadline passed, automation not stopped or closed.
const isDue = (row, now) => Boolean(row?.projectId) && !row.confirmedAt && deadlineOf(row) <= now
  && !STOPPED.includes(row.resolution?.status) && !row.resolution?.closedAt;

const firstInvoice = (order, session) => Invoice.findOne({ orderId: order._id, invoiceType: 'project',
  installmentNumber: order.isPartialPayment ? 1 : null }).session(session);

// A payment submitted before the deadline and still awaiting approval holds the reserved price.
const inTimePending = (row, session) => Transaction.exists({ ...PENDING_PAYMENT, userId: row.userId, orderId: row.projectId,
  createdAt: { $lte: deadlineOf(row) } }).session(session);

// Owner decision 4: the same offer still live (edited/extended) → its current terms; otherwise the
// saved normal price for the same scope. Saved extras and the admin's signed adjustment are kept.
function expiredTerms(agreement, currentOffer, category, now) {
  const regularPrice = Number(agreement.regularPrice);
  const live = currentOffer && currentOffer.slug === agreement.offer?.slug && offerEligible(currentOffer, category, now.getTime()) ? currentOffer : null;
  let packagePrice = regularPrice;
  if (live) {
    // A package's fixed offer price carries its own extra-scope charge; keep it from the agreement.
    const packageExtra = agreement.package && agreement.offer?.pricingRule === 'fixed_price'
      ? money(Number(agreement.packagePrice) - Number(agreement.offer.offerPrice)) : 0;
    packagePrice = calculateBenefit(regularPrice, live, packageExtra).finalPrice;
  }
  const finalPrice = money(packagePrice + Number(agreement.extrasTotal || 0) + Number(agreement.priceAdjustment || 0));
  if (finalPrice < 0) fail('Revised price would be negative');
  return { source: live ? 'offer_extended' : 'normal_price', offer: live, packagePrice, finalPrice, quoteKey: live?.quoteKey || null };
}

// The reservation's own saved price and terms (force-apply, owner decision 13: saved terms).
function reservedTerms(agreement, reservation) {
  const snapshot = reservation.offerSnapshot;
  const finalPrice = money(Number(reservation.reservedPrice) + Number(agreement.extrasTotal || 0) + Number(agreement.priceAdjustment || 0));
  if (finalPrice < 0) fail('Revised price would be negative');
  return { source: 'reserved_terms', offer: snapshot, packagePrice: Number(reservation.reservedPrice), finalPrice, quoteKey: snapshot.quoteKey || null };
}

function revisedAgreement(agreement, terms, revision, reason, now) {
  const offer = terms.offer;
  return { ...agreement, packagePrice: terms.packagePrice, offerDiscount: money(Number(agreement.regularPrice) - terms.packagePrice), finalPrice: terms.finalPrice,
    offer: offer ? { slug: offer.slug, title: offer.title, endsAt: offer.endsAt, pricingRule: offer.pricingRule, mainPrice: offer.mainPrice,
      offerPrice: offer.offerPrice, benefitValue: offer.benefitValue, terms: offer.resolvedTerms || [], appliedAt: now } : null,
    revision: { number: revision, reason, source: terms.source, at: now, previousFinalPrice: agreement.finalPrice } };
}

// Writes one immutable revision and every projection of the price in the caller's transaction.
// Settled money is never rewritten: only the unpaid first bill, installments and summary change.
async function applyPricingRevision({ order, reservation, terms, reason, actorId = null, note = '', session }) {
  const agreement = order.projectSnapshot?.salesAgreement;
  const invoice = await firstInvoice(order, session);
  if (!agreement || !invoice || ['paid', 'cancelled'].includes(invoice.status)) fail('The first bill is already settled; the price is locked', 409);
  const plan = order.isPartialPayment ? buildInstallments(terms.finalPrice, order.installments.length) : null;
  const invoiceAmount = plan ? plan[0].amount : terms.finalPrice;
  const received = await getInvoiceAmountReceived(invoice._id, { session });
  // Owner decision 20 asks for wallet credit; until that flow exists, never cut below received money.
  if (cents(received) > cents(invoiceAmount)) return { status: 'needs_review', note: 'Money already received on the first bill exceeds the revised amount' };
  const now = new Date();
  const revision = Number(order.pricingRevision || 0) + 1;
  const before = { finalPrice: order.totalAmount, agreement, installments: (order.installments || []).map(row => ({ installmentNumber: row.installmentNumber, amount: row.amount })),
    invoice: { id: invoice._id, amount: invoice.amount, lineItems: invoice.lineItems.map(item => ({ name: item.name, price: item.price })) } };
  const nextAgreement = revisedAgreement(agreement, terms, revision, reason, now);
  order.projectSnapshot.salesAgreement = nextAgreement;
  order.projectSnapshot.finalPrice = terms.finalPrice;
  order.markModified('projectSnapshot');
  order.price = terms.finalPrice; order.totalAmount = terms.finalPrice;
  if (plan) order.installments.forEach((row, index) => { row.amount = plan[index].amount; });
  order.pricingRevision = revision;
  // Same order write fence as payments and uploads: a racing settlement conflicts and rereads.
  order.uploadRevision = Number(order.uploadRevision || 0) + 1;
  await setOrderPaidAmount(order, { session });
  order.paymentComplete = cents(order.remainingAmount) === 0;
  await order.save({ session });
  invoice.amount = invoiceAmount;
  invoice.lineItems = buildLineItemsFromOrder(order);
  invoice.amountPaid = received;
  const derived = deriveInvoiceStatus(received, invoiceAmount);
  invoice.status = invoice.status === 'overdue' && derived === 'unpaid' ? 'overdue' : derived;
  await invoice.save({ session });
  await syncProjectFinalInvoice(order, { session });
  const after = { finalPrice: terms.finalPrice, agreement: nextAgreement, installments: plan ? plan.map(row => ({ installmentNumber: row.installmentNumber, amount: row.amount })) : [],
    invoice: { id: invoice._id, amount: invoice.amount, lineItems: invoice.lineItems.map(item => ({ name: item.name, price: item.price })) } };
  const [doc] = await Revision.create([{ orderId: order._id, userId: order.userId, reservationId: reservation._id, revision, reason,
    source: terms.source, before, after, offerQuoteKey: terms.quoteKey, actorId, note }], { session });
  return { status: 'repriced', revisionId: doc._id, finalPrice: terms.finalPrice };
}

// Brings one expired, unpaid reservation's project to its post-deadline price. Idempotent: the
// same catalogue state never writes a second revision; a later offer change can write one.
async function reconcileReservation(reservationId, { now = new Date(), catalogue = null } = {}) {
  if (!enabled()) return { status: 'disabled' };
  const row = await Reservation.findById(reservationId).lean();
  if (!isDue(row, now)) return { status: 'not_due' };
  if (await inTimePending(row, null)) return { status: 'under_review' };
  // External catalogue is read outside the transaction. An outage never changes a price.
  let offers;
  try { offers = (catalogue || await fetchWebsiteCatalogue()).offers; }
  catch { return { status: 'unavailable' }; }
  const currentOffer = offers.find(offer => offer.slug === row.offerSlug) || null;
  return mongoose.connection.transaction(async session => {
    const fresh = await Reservation.findById(row._id).session(session);
    if (!isDue(fresh, now)) return { status: 'not_due' };
    const order = await Order.findOne({ _id: fresh.projectId, offerReservationId: fresh._id }).session(session);
    const close = async status => {
      fresh.resolution = { ...(fresh.resolution?.toObject?.() || { status: 'unchanged', source: null, at: now }), closedAt: now };
      await fresh.save({ session }); return { status };
    };
    if (!order || order.orderVisibility === 'cancelled') return close('closed');
    const invoice = await firstInvoice(order, session);
    if (!invoice || ['paid', 'cancelled'].includes(invoice.status)) return close('closed');
    if (await inTimePending(fresh, session)) return { status: 'under_review' };
    const agreement = order.projectSnapshot?.salesAgreement;
    let terms;
    try {
      if (!agreement?.regularPrice) fail('This project has no saved agreement to reprice');
      terms = expiredTerms(agreement, currentOffer, order.projectSnapshot.category, now);
    } catch (error) {
      fresh.resolution = { status: 'needs_review', source: null, note: error.message, at: now };
      await fresh.save({ session }); return { status: 'needs_review', note: error.message };
    }
    if (cents(terms.finalPrice) === cents(order.totalAmount)) {
      if (!fresh.resolution) { fresh.resolution = { status: 'unchanged', source: terms.source, at: now }; await fresh.save({ session }); }
      return { status: 'unchanged', source: terms.source };
    }
    const result = await applyPricingRevision({ order, reservation: fresh, terms, reason: 'reservation_expired', session });
    fresh.resolution = result.status === 'repriced'
      ? { status: 'repriced', source: terms.source, revisionId: result.revisionId, at: now }
      : { status: 'needs_review', source: terms.source, note: result.note, at: now };
    await fresh.save({ session });
    return { ...result, source: terms.source };
  });
}

async function reconcileOrderReservation(orderId) {
  if (!enabled() || !mongoose.isValidObjectId(orderId)) return { status: 'disabled' };
  const order = await Order.findById(orderId).select('offerReservationId').lean();
  return order?.offerReservationId ? reconcileReservation(order.offerReservationId) : { status: 'not_due' };
}

// Payment entry points call this first, so money after a deadline settles the current price.
// When the price check is unavailable for a due reservation, the payment waits rather than
// silently settling an outdated amount.
async function ensureReservationPriceCurrent(orderId) {
  const result = await reconcileOrderReservation(orderId);
  if (result.status === 'unavailable') fail('Price check is temporarily unavailable. Please try again in a few minutes.', 503);
  return result;
}

const dueQuery = now => ({ projectId: { $ne: null }, confirmedAt: null, 'resolution.status': { $nin: STOPPED }, 'resolution.closedAt': null,
  $or: [{ extendedUntil: null, expiresAt: { $lte: now } }, { extendedUntil: { $lte: now } }] });

// Scheduled batch: one catalogue read, per-item error isolation.
async function reconcileDueReservations({ limit = 50, now = new Date() } = {}) {
  if (!enabled()) return [];
  const rows = await Reservation.find(dueQuery(now)).sort({ expiresAt: 1 }).limit(limit).select('_id').lean();
  if (!rows.length) return [];
  let catalogue;
  try { catalogue = await fetchWebsiteCatalogue(); } catch { return rows.map(row => ({ id: String(row._id), status: 'unavailable' })); }
  const results = [];
  for (const row of rows) {
    try { results.push({ id: String(row._id), ...await reconcileReservation(row._id, { now, catalogue }) }); }
    catch (error) { results.push({ id: String(row._id), status: 'error', note: error.message }); }
  }
  return results;
}

async function reconcileUserReservations(userId) {
  if (!enabled()) return;
  const rows = await Reservation.find({ ...dueQuery(new Date()), userId }).select('_id').lean();
  for (const row of rows) await reconcileReservation(row._id).catch(error => console.error('[reservation repricing]', error.message));
}

// ---- Admin force-apply (owner decisions 13, 17–19): the reservation's saved price and terms on
// one project of the same customer, through the same revision pipeline as expiry repricing.

// A project created without an offer has no agreement; the reserved scope becomes its agreement
// and its extras are kept. The preview shows this before anything is written.
function agreementFor(order, reservation) {
  const saved = order.projectSnapshot?.salesAgreement;
  if (saved?.regularPrice != null) return saved;
  const extras = (order.projectSnapshot?.features || []).map(item => ({ name: item.name, quantity: item.quantity || 1, unitPrice: item.unitPrice, price: Number(item.price || 0) }));
  return { version: 2, agreedAt: order.createdAt, currency: 'INR', package: null,
    regularPrice: Number(reservation.regularPrice), offerDiscount: 0, packagePrice: Number(reservation.regularPrice),
    extrasTotal: money(extras.reduce((sum, item) => sum + item.price, 0)), priceAdjustment: 0, adjustmentLabel: '',
    finalPrice: Number(order.totalAmount), scope: [...(reservation.offerSnapshot.inclusions || [])], terms: [...(reservation.offerSnapshot.resolvedTerms || [])],
    extras, offer: null, createdForForceApply: true };
}

async function loadForceApply({ reservationId, orderId, session }) {
  if (!mongoose.isValidObjectId(reservationId) || !mongoose.isValidObjectId(orderId)) fail('Choose a reservation and a project');
  const reservation = await Reservation.findById(reservationId).session(session);
  const order = await Order.findById(orderId).session(session);
  if (!reservation || !order) fail('Reservation or project not found', 404);
  if (String(reservation.userId) !== String(order.userId)) fail('This reservation belongs to a different customer', 409);
  if (!order.isWebsiteProject || order.isServicePlan || order.orderVisibility === 'cancelled') fail('Force-apply works only on an open project', 409);
  if (reservation.projectId && String(reservation.projectId) !== String(order._id)) fail('This reservation is already used on another project', 409);
  if (order.offerReservationId && String(order.offerReservationId) !== String(reservation._id)) fail('This project is linked to a different reservation', 409);
  if (reservation.confirmedAt) fail('This reservation already locked its price', 409);
  if (reservation.resolution?.status === 'force_applied') fail('This reservation was already force-applied', 409);
  const categories = reservation.offerSnapshot.applicableCategories || [];
  if (!categories.includes(order.projectSnapshot?.category)) fail('The reserved offer does not cover this project category', 409);
  const invoice = await firstInvoice(order, session);
  if (!invoice || ['paid', 'cancelled'].includes(invoice.status)) fail('The first bill is already settled; the price is locked', 409);
  const agreement = agreementFor(order, reservation);
  const terms = reservedTerms(agreement, reservation);
  if (cents(terms.finalPrice) === cents(order.totalAmount)) fail('The project already has the reserved price', 409);
  return { reservation, order, invoice, agreement, terms };
}

async function forceApplyPreview({ reservationId, orderId, actorId }) {
  await require('./offerReservations').currentAdmin(actorId);
  const { reservation, order, invoice, terms } = await loadForceApply({ reservationId, orderId, session: null });
  const plan = order.isPartialPayment ? buildInstallments(terms.finalPrice, order.installments.length) : null;
  return { reservationId: String(reservation._id), orderId: String(order._id), offerSlug: reservation.offerSlug, offerTitle: reservation.offerSnapshot.title,
    pricingRevision: Number(order.pricingRevision || 0), deadline: deadlineOf(reservation), expiresAt: reservation.expiresAt,
    before: { finalPrice: order.totalAmount, firstBill: invoice.amount, installments: (order.installments || []).map(row => row.amount) },
    after: { finalPrice: terms.finalPrice, firstBill: plan ? plan[0].amount : terms.finalPrice, installments: plan ? plan.map(row => row.amount) : [] },
    note: 'Validity is overridden by an admin; the original reservation deadline stays in history and no new 72 hours start.' };
}

// Protocol: current admin, preview revision unchanged, a reason, and the offer slug typed to confirm.
async function forceApplyReservation({ reservationId, orderId, actorId, reason, confirmSlug, expectedRevision }) {
  const note = String(reason || '').trim();
  if (!note || note.length > 300) fail('Enter a reason for the force-apply (up to 300 characters)');
  return mongoose.connection.transaction(async session => {
    await require('./offerReservations').currentAdmin(actorId, session);
    const { reservation, order, agreement, terms } = await loadForceApply({ reservationId, orderId, session });
    if (confirmSlug !== reservation.offerSlug) fail('Type the offer code exactly to confirm', 400);
    if (Number(expectedRevision) !== Number(order.pricingRevision || 0)) fail('The project price changed since the preview. Refresh and review again.', 409);
    if (!order.projectSnapshot.salesAgreement) { order.projectSnapshot.salesAgreement = agreement; order.markModified('projectSnapshot'); }
    order.offerReservationId = reservation._id;
    const result = await applyPricingRevision({ order, reservation, terms, reason: 'force_apply', actorId, note, session });
    if (result.status !== 'repriced') fail(result.note || 'This project needs a manual review', 409);
    reservation.projectId = order._id;
    reservation.resolution = { status: 'force_applied', source: 'reserved_terms', revisionId: result.revisionId, note, at: new Date() };
    await reservation.save({ session });
    return { orderId: String(order._id), finalPrice: result.finalPrice, revisionId: String(result.revisionId) };
  });
}

module.exports = { expiredTerms, reservedTerms, applyPricingRevision, reconcileReservation, reconcileOrderReservation,
  ensureReservationPriceCurrent, reconcileDueReservations, reconcileUserReservations, firstInvoice, isDue,
  forceApplyPreview, forceApplyReservation };
