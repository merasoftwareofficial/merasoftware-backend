const mongoose = require('mongoose');
const Reservation = require('../models/offerReservationModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const Revision = require('../models/projectPricingRevisionModel');
const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { offerEligible, calculateBenefit, money, fail } = require('./salesPackages');
const { buildLineItemsFromOrder } = require('./paymentRecording');
const { setOrderPaidAmount, getOrderAmountReceived, deriveInvoiceStatus, getInvoiceAmountReceived } = require('./orderPaymentTotals');
const { syncProjectFinalInvoice } = require('./projectFinalInvoice');
const { buildInstallments } = require('./projectInstallments');
const { deadlineOf, PENDING_PAYMENT } = require('./offerReservations');
const { createHash } = require('node:crypto');
const Preview = require('../models/reservationActionPreviewModel');

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
function expiredTerms(agreement, currentOffer, category, now, offerSlug = agreement.offer?.slug) {
  const regularPrice = Number(agreement.regularPrice);
  const live = currentOffer && currentOffer.slug === offerSlug && offerEligible(currentOffer, category, now.getTime()) ? currentOffer : null;
  let packagePrice = regularPrice;
  if (live) {
    // A package's fixed offer price carries its own extra-scope charge; keep it from the agreement.
    const packageExtra = agreement.offerScopeExtra ?? (agreement.package && agreement.offer?.pricingRule === 'fixed_price'
      ? money(Number(agreement.packagePrice) - Number(agreement.offer.offerPrice)) : 0);
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
  const oldOfferTerms = new Set(agreement.offer?.terms || []);
  const baseTerms = agreement.baseTerms || (agreement.terms || []).filter(term => !oldOfferTerms.has(term));
  let offerTerms = [...(offer?.resolvedTerms || [])];
  if (reason === 'force_apply') {
    offerTerms = offerTerms.filter(term => !/^Offer valid until\s/i.test(term));
    offerTerms.push('Reserved offer applied by admin override. The original public expiry does not grant a new reservation period.');
  }
  return { ...agreement, packagePrice: terms.packagePrice, offerDiscount: money(Number(agreement.regularPrice) - terms.packagePrice), finalPrice: terms.finalPrice,
    baseTerms, terms: [...new Set([...baseTerms, ...offerTerms])],
    offerScopeExtra: agreement.offerScopeExtra ?? (agreement.package && agreement.offer?.pricingRule === 'fixed_price'
      ? money(Number(agreement.packagePrice) - Number(agreement.offer.offerPrice)) : 0),
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
  const now = new Date();
  const revision = Number(order.pricingRevision || 0) + 1;
  const before = { finalPrice: order.totalAmount, agreement, installments: (order.installments || []).map(row => ({ installmentNumber: row.installmentNumber, amount: row.amount })),
    invoice: { id: invoice._id, amount: invoice.amount, lineItems: invoice.lineItems.map(item => ({ name: item.name, price: item.price })) } };
  const bills = await Invoice.find({ orderId: order._id, invoiceType: 'project', status: { $ne: 'cancelled' } }).session(session);
  if (bills.some(bill => bill.status === 'paid')) fail('Settled installment history needs review before repricing', 409);
  before.invoices = bills.map(bill => ({ id: bill._id, amount: bill.amount, amountPaid: bill.amountPaid, status: bill.status, lineItems: bill.lineItems.toObject() }));
  const allocation = await require('./projectReceiptReallocation').reallocateProjectReceipts({ order, invoices: bills, installments: plan,
    finalPrice: terms.finalPrice, revision, session });
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
  for (const bill of bills) {
    if (bill.status === 'paid') continue; // Issued settled bills are historical documents.
    bill.amount = plan ? plan[bill.installmentNumber - 1].amount : invoiceAmount;
    bill.lineItems = buildLineItemsFromOrder(order);
    bill.amountPaid = await getInvoiceAmountReceived(bill._id, { session });
    const derived = bill.amount === 0 ? 'paid' : deriveInvoiceStatus(bill.amountPaid, bill.amount);
    bill.status = bill.status === 'overdue' && derived === 'unpaid' ? 'overdue' : derived;
    bill.paidDate = bill.status === 'paid' ? bill.paidDate || now : null;
    await bill.save({ session });
    const installment = order.installments?.find(item => item.installmentNumber === bill.installmentNumber);
    if (installment) { installment.paid = bill.status === 'paid'; installment.paidDate = bill.paidDate; }
  }
  if (plan) order.currentInstallment = order.installments.find(item => !item.paid)?.installmentNumber || order.currentInstallment;
  const updatedFirst = bills.find(bill => String(bill._id) === String(invoice._id));
  if (updatedFirst.status === 'paid') require('./orderLifecycle').markOrderApproved(order, { actorId });
  await order.save({ session });
  await syncProjectFinalInvoice(order, { session });
  const after = { finalPrice: terms.finalPrice, agreement: nextAgreement, installments: plan ? plan.map(row => ({ installmentNumber: row.installmentNumber, amount: row.amount })) : [],
    invoices: bills.map(bill => ({ id: bill._id, amount: bill.amount, amountPaid: bill.amountPaid, status: bill.status, lineItems: bill.lineItems.toObject() })),
    walletCredit: allocation.walletCredit, invoice: { id: updatedFirst._id, amount: updatedFirst.amount, lineItems: updatedFirst.lineItems.map(item => ({ name: item.name, price: item.price })) } };
  const [doc] = await Revision.create([{ orderId: order._id, userId: order.userId, reservationId: reservation._id, revision, reason,
    source: terms.source, before, after, offerQuoteKey: terms.quoteKey, actorId, note }], { session });
  return { status: 'repriced', revisionId: doc._id, finalPrice: terms.finalPrice, walletCredit: allocation.walletCredit };
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
      terms = expiredTerms(agreement, currentOffer, order.projectSnapshot.category, now, fresh.offerSlug);
    } catch (error) {
      fresh.resolution = { status: 'needs_review', source: null, note: error.message, at: now };
      await fresh.save({ session }); return { status: 'needs_review', note: error.message };
    }
    const proposed = revisedAgreement(agreement, terms, 0, 'reservation_expired', now);
    const offerState = value => value ? [value.slug, value.title, value.endsAt, value.pricingRule, value.mainPrice, value.offerPrice, value.benefitValue, value.terms] : null;
    if (cents(terms.finalPrice) === cents(order.totalAmount) && JSON.stringify(agreement.terms) === JSON.stringify(proposed.terms)
      && JSON.stringify(offerState(agreement.offer)) === JSON.stringify(offerState(proposed.offer))) {
      if (!fresh.resolution) { fresh.resolution = { status: 'unchanged', source: terms.source, at: now }; await fresh.save({ session }); }
      return { status: 'unchanged', source: terms.source };
    }
    const result = await applyPricingRevision({ order, reservation: fresh, terms, reason: 'reservation_expired', session });
    fresh.resolution = result.status === 'repriced'
      ? { status: 'repriced', source: terms.source, revisionId: result.revisionId, walletCredit: result.walletCredit, at: now }
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

// Catalogue I/O stays outside the financial transaction. If a deadline crosses
// or a competing revision wins, abort and prepare again before touching money.
async function withCurrentReservationPrice(orderId, operation) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const decision = await ensureReservationPriceCurrent(orderId);
    const order = enabled() && await Order.findById(orderId).select('pricingRevision offerReservationId').lean();
    const row = order?.offerReservationId && await Reservation.findById(order.offerReservationId).lean();
    const prepared = row ? { checked: ['repriced', 'unchanged', 'closed'].includes(decision.status),
      revision: Number(order.pricingRevision || 0), deadline: deadlineOf(row).getTime() } : null;
    try {
      return await mongoose.connection.transaction(session => operation(session, prepared));
    } catch (error) {
      if (error.code !== 'RESERVATION_PRICE_RECHECK') throw error;
    }
  }
  fail('Project payment terms changed. Refresh the payment details and try again.', 409);
}
async function guardReservationPayment(order, session, prepared, submittedAt = null) {
  if (!enabled() || !order.offerReservationId) return;
  const row = await Reservation.findById(order.offerReservationId).session(session);
  if (!row || !isDue(row, new Date()) || (submittedAt && new Date(submittedAt) <= deadlineOf(row)) || await inTimePending(row, session)) return;
  if (!prepared?.checked || prepared.revision !== Number(order.pricingRevision || 0) || prepared.deadline !== deadlineOf(row).getTime()) {
    throw Object.assign(new Error('Reservation price must be checked again'), { code: 'RESERVATION_PRICE_RECHECK' });
  }
}

const dueQuery = now => ({ projectId: { $ne: null }, confirmedAt: null, 'resolution.status': { $nin: STOPPED }, 'resolution.closedAt': null,
  $or: [{ extendedUntil: null, expiresAt: { $lte: now } }, { extendedUntil: { $lte: now } }] });

// Scheduled batch: one catalogue read, per-item error isolation.
async function reconcileDueReservations({ limit = 50, now = new Date() } = {}) {
  if (!enabled()) return [];
  const candidates = { ...dueQuery(now), $and: [
    { $or: [{ pricingNextCheckAt: null }, { pricingNextCheckAt: { $lte: now } }] },
    { $or: [{ pricingLockedUntil: null }, { pricingLockedUntil: { $lte: now } }] },
  ] };
  const rows = await Reservation.find(candidates).sort({ pricingNextCheckAt: 1, expiresAt: 1, _id: 1 }).limit(limit).select('_id').lean();
  if (!rows.length) return [];
  const claimed = [];
  for (const row of rows) {
    const claim = await Reservation.findOneAndUpdate({ ...candidates, _id: row._id }, { $set: { pricingLockedUntil: new Date(now.getTime() + 120000) } }, { new: true });
    if (claim) claimed.push(claim);
  }
  let catalogue = null;
  if (claimed.length) { try { catalogue = await fetchWebsiteCatalogue(); } catch { /* Retry later; outages cannot change a price. */ } }
  const results = [];
  for (const row of claimed) {
    let result;
    try { result = catalogue ? await reconcileReservation(row._id, { now, catalogue }) : { status: 'unavailable' }; }
    catch (error) { result = { status: 'error', note: error.message }; }
    results.push({ id: String(row._id), ...result });
    await Reservation.updateOne({ _id: row._id, pricingLockedUntil: row.pricingLockedUntil }, { $set: {
      pricingLockedUntil: null, pricingNextCheckAt: new Date(now.getTime() + (['unavailable', 'error', 'under_review'].includes(result.status) ? 60000 : 300000)),
    } });
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
  return mongoose.connection.transaction(async session => {
    await require('./offerReservations').currentAdmin(actorId, session);
    const { reservation, order, invoice, terms } = await loadForceApply({ reservationId, orderId, session });
    const stateHash = await forceStateHash({ reservation, order, invoice, session });
    const [token] = await Preview.create([{ actorId, orderId, reservationId, stateHash, expiresAt: new Date(Date.now() + 15 * 60000) }], { session });
    const plan = order.isPartialPayment ? buildInstallments(terms.finalPrice, order.installments.length) : null;
    const received = await getOrderAmountReceived(order._id, { session });
    return { reservationId: String(reservation._id), orderId: String(order._id), offerSlug: reservation.offerSlug, offerTitle: reservation.offerSnapshot.title,
      previewToken: String(token._id), pricingRevision: Number(order.pricingRevision || 0), deadline: deadlineOf(reservation), expiresAt: reservation.expiresAt,
      before: { finalPrice: order.totalAmount, received, firstBill: invoice.amount, installments: (order.installments || []).map(row => row.amount) },
      after: { finalPrice: terms.finalPrice, walletCredit: Math.max(0, cents(received) - cents(terms.finalPrice)) / 100,
        firstBill: plan ? plan[0].amount : terms.finalPrice, installments: plan ? plan.map(row => row.amount) : [] },
      note: 'Validity is overridden by an admin; the original reservation deadline stays in history and no new 72 hours start.' };
  });
}

async function forceStateHash({ reservation, order, invoice, session }) {
  const payments = await Transaction.find({ orderId: order._id }).select('_id type status paymentStatus amount invoiceId createdAt').sort({ _id: 1 }).session(session).lean();
  return createHash('sha256').update(JSON.stringify({ orderId: order._id, userId: order.userId,
    price: order.totalAmount, pricingRevision: order.pricingRevision || 0, paymentRevision: order.uploadRevision || 0,
    visibility: order.orderVisibility, agreement: order.projectSnapshot?.salesAgreement,
    invoice: { id: invoice._id, amount: invoice.amount, received: invoice.amountPaid, status: invoice.status },
    reservation: { id: reservation._id, projectId: reservation.projectId, deadline: deadlineOf(reservation), confirmedAt: reservation.confirmedAt,
      resolution: reservation.resolution, extensions: reservation.extensions }, payments })).digest('hex');
}

// Protocol: current admin, preview revision unchanged, a reason, and the offer slug typed to confirm.
async function forceApplyReservation({ reservationId, orderId, actorId, reason, confirmSlug, expectedRevision, previewToken }) {
  const note = String(reason || '').trim();
  if (!note || note.length > 300) fail('Enter a reason for the force-apply (up to 300 characters)');
  return mongoose.connection.transaction(async session => {
    await require('./offerReservations').currentAdmin(actorId, session);
    const { reservation, order, invoice, agreement, terms } = await loadForceApply({ reservationId, orderId, session });
    if (confirmSlug !== reservation.offerSlug) fail('Type the offer code exactly to confirm', 400);
    if (Number(expectedRevision) !== Number(order.pricingRevision || 0)) fail('The project price changed since the preview. Refresh and review again.', 409);
    if (!mongoose.isValidObjectId(previewToken)) fail('Open a fresh preview before applying the reserved price', 409);
    const stateHash = await forceStateHash({ reservation, order, invoice, session });
    const consumed = await Preview.findOneAndUpdate({ _id: previewToken, actorId, orderId, reservationId, stateHash,
      usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: new Date() } }, { new: true, session });
    if (!consumed) fail('Project payment or reservation changed since the preview. Refresh and review again.', 409);
    if (!order.projectSnapshot.salesAgreement) { order.projectSnapshot.salesAgreement = agreement; order.markModified('projectSnapshot'); }
    order.offerReservationId = reservation._id;
    const result = await applyPricingRevision({ order, reservation, terms, reason: 'force_apply', actorId, note, session });
    if (result.status !== 'repriced') fail(result.note || 'This project needs a manual review', 409);
    reservation.projectId = order._id;
    reservation.resolution = { status: 'force_applied', source: 'reserved_terms', revisionId: result.revisionId, walletCredit: result.walletCredit, note, at: new Date() };
    await reservation.save({ session });
    return { orderId: String(order._id), finalPrice: result.finalPrice, revisionId: String(result.revisionId) };
  });
}

module.exports = { expiredTerms, reservedTerms, applyPricingRevision, reconcileReservation, reconcileOrderReservation,
  ensureReservationPriceCurrent, reconcileDueReservations, reconcileUserReservations, firstInvoice, isDue,
  forceApplyPreview, forceApplyReservation, withCurrentReservationPrice, guardReservationPayment };
