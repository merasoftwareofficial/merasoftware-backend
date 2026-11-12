const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { readPackages, quotePackage, quoteChoice, offerEligible, calculateBenefit, money, fail } = require('./salesPackages');
const { addMonths } = require('./projectInstallments');
const { freezePaymentPolicy } = require('./offerPaymentPolicy');

// A package quoted for a project: with a reservation, at the offer it froze (as it was when reserved), even
// after the offer ended or the package let it go; with an ended offer the admin applies (endedOfferFor below),
// at that offer as it was on its last moment; otherwise at the live package and offers.
const quotePackageForProject = (packageItem, reserved, offers, endedOffer = null) => {
  if (reserved) return quotePackage({ ...packageItem, offerSlug: reserved.offerSlug, regularPrice: Number(reserved.offerSnapshot.mainPrice ?? packageItem.regularPrice), offerExtraPrice: 0 }, [reserved.offerSnapshot], new Date(reserved.reservedAt).getTime());
  if (endedOffer) return quotePackage(packageItem, [endedOffer], Date.parse(endedOffer.endsAt) - 1);
  return quotePackage(packageItem, offers);
};

// The package's OWN offer once it has ended (owner decision 12 Nov 2026: an admin may still sell a package at
// its ended offer, with a reason; only the offer the package is linked to, never another one). It must still be
// published (an archived offer was withdrawn) and have applied to this package's category while it ran.
// `offers` is the website's whole catalogue (fetchWebsiteCatalogue keeps ended offers).
function endedOfferFor(packageItem, offers, now = Date.now()) {
  const offer = (offers || []).find(row => row.slug === packageItem?.offerSlug);
  if (!offer || !offer.endsAt || Date.parse(offer.endsAt) > now) return null;
  return offerEligible(offer, packageItem.category, Date.parse(offer.endsAt) - 1) ? offer : null;
}

// Resolve the commercial agreement before writing an order, invoice or payment.
// `actorId`: the admin creating the project (adminCreateProjectOrder.js), recorded when an ended offer is applied.
async function resolveProjectPricing({ body, category, basePrice, features, referenceTotal, userId, actorId = null }) {
  if (body.offerReservationId && !body.offerSlug) fail("Select the reserved offer before creating this project", 400);
  if (!body.packageId && !body.offerSlug) return null; // Existing custom-project pricing stays available.
  if (body.offerSlug && userId) await require('./reservationRelease').repairUserReservationLinks(userId);
  let reserved = null;
  if (body.offerReservationId) {
    if (process.env.OFFER_RESERVATIONS_ENABLED !== 'true') fail('Offer reservations are not enabled yet', 503);
    if (!require('mongoose').isValidObjectId(body.offerReservationId) || !userId) fail('Select a reserved offer for this customer');
    reserved = await require('../models/offerReservationModel').findOne({ _id: body.offerReservationId, userId }).lean();
    // A reservation goes only with its own package (package.md §5 item 7), whose offer it froze.
    if (reserved && body.packageId && reserved.offerSnapshot?.packageId !== body.packageId) fail('This reservation belongs to another package', 409);
    const { deadlineOf, isPaused } = require('./offerReservations');
    // A paused reservation (the customer asked to start) is still open whatever its old deadline says.
    if (!reserved || reserved.offerSlug !== body.offerSlug || reserved.projectId || (!isPaused(reserved) && deadlineOf(reserved) <= new Date())) fail('This customer reservation is unavailable or expired', 409);
  }
  // An ended offer the admin applies anyway (endedOfferFor): only with a package, never with a reservation
  // (an expired reservation is extended instead), and always with a written reason kept on the agreement.
  let endedOffer = null;
  const endedOfferReason = String(body.endedOfferReason || '').trim();
  if (body.endedOfferSlug) {
    if (reserved) fail('Use either the reservation or the ended offer, not both');
    if (!body.packageId) fail('An ended offer can only be applied to a package');
    if (!actorId) fail('Only an admin can apply an ended offer', 403);
    if (!endedOfferReason || endedOfferReason.length > 300) fail('Enter why the ended offer is applied (up to 300 characters)');
  }
  const { offers } = reserved ? { offers: [reserved.offerSnapshot] } : await fetchWebsiteCatalogue();
  const extrasTotal = money(features.reduce((sum, item) => sum + item.price, 0));
  let packageItem = null, quote, scope, packageQuoteKey = null, monthly = null;
  if (body.packageId) {
    packageItem = (await readPackages()).find(item => item.id === body.packageId && item.status === 'published');
    if (!packageItem || packageItem.category !== category) fail('This package is unavailable for the selected project category');
    if (body.endedOfferSlug) {
      endedOffer = endedOfferFor(packageItem, offers);
      if (!endedOffer || endedOffer.slug !== body.endedOfferSlug) fail('This package has no ended offer to apply. Refresh packages.', 409);
    }
    // With a reservation the package is quoted with the frozen offer, as it was when reserved, even after
    // the offer ended or the package let it go; the reservation's own key is the version check.
    const quoted = quotePackageForProject(packageItem, reserved, offers, endedOffer);
    if (reserved) {
      if (!quoted.quote.offer) fail('This reservation does not apply to this package', 409);
      if (!body.offerQuoteKey || body.offerQuoteKey !== reserved.offerSnapshot.quoteKey) fail('Offer changed. Refresh offers and review the price.', 409);
    } else if (!body.packageQuoteKey || body.packageQuoteKey !== quoted.quoteKey) fail('Package, offer or terms changed. Refresh packages and review the new price.', 409);
    if (body.offerSlug && body.offerSlug !== quoted.quote.offer?.slug) fail('The selected offer does not match this package', 409);
    quote = quoted.quote; scope = packageItem.inclusions; packageQuoteKey = quoted.quoteKey;
    // A monthly package (src/docs/monthlypackage.md) is priced for the customer's cycle and length by the one
    // choice quote (the plan engine); its totals stand in for the one price in the agreement.
    if (packageItem.billing === 'monthly') {
      if (features.length || (body.priceAdjustment !== undefined && Number(body.priceAdjustment) !== 0)) fail('A monthly package is sold as it is, without extra features or a price adjustment');
      monthly = quoteChoice(packageItem, quoted, body.monthlyChoice || {});
      quote = { ...quote, regularPrice: monthly.regularPrice, discountAmount: monthly.discountAmount, finalPrice: monthly.finalPrice };
    }
  } else {
    const offer = offers.find(item => item.slug === body.offerSlug);
    if (!offerEligible(offer, category, reserved ? new Date(reserved.reservedAt).getTime() : Date.now())) fail('The selected offer is expired or does not apply to this project category');
    if (!body.offerQuoteKey || body.offerQuoteKey !== offer.quoteKey) fail('Offer changed. Refresh offers and review the price.', 409);
    const regularPrice = Number(offer.mainPrice);
    quote = { regularPrice, ...calculateBenefit(regularPrice, offer), offer, terms: offer.resolvedTerms || [] };
    scope = offer.inclusions || [];
  }
  // The offer never locks the selling price. Any difference from the calculated price is an
  // explicit signed adjustment whose label is printed for the client on the agreement/invoice.
  const priceAdjustment = body.priceAdjustment === undefined ? 0 : Number(body.priceAdjustment);
  if (!Number.isFinite(priceAdjustment) || money(priceAdjustment) !== priceAdjustment) fail('Enter a valid price adjustment');
  const adjustmentLabel = priceAdjustment === 0 ? '' : String(body.adjustmentLabel || '').trim();
  if (priceAdjustment !== 0 && (!adjustmentLabel || adjustmentLabel.length > 120)) fail('Enter a label for the price adjustment (shown on the invoice)');
  const calculatedTotal = money(quote.finalPrice + extrasTotal + priceAdjustment);
  if (calculatedTotal < 0) fail('Price adjustment exceeds the project amount');
  // Still catches a feature/offer price that changed while the form was open.
  if (money(Number(body.sellingPrice)) !== calculatedTotal) fail('Project price changed. Review the current package and extras before creating it.', 409);
  const now = new Date();
  const term = monthly ? { ...monthly.monthly, unitPrice: monthly.unitPrice, regularUnitPrice: monthly.regularUnitPrice,
    startsAt: now, endsAt: addMonths(now, monthly.monthly.tenureMonths) } : null;
  // Recheck at the final decision point, including requests crossing the deadline.
  if (quote.offer && !reserved && !endedOffer && Date.parse(quote.offer.endsAt) <= now.getTime()) fail('Offer has expired. Refresh the price before continuing.', 409);
  return {
    // An ended offer is not attached to the reservation system (offerReservations.js attachProjectReservation
    // refuses an ended offer): the agreement keeps the offer and how it was applied, no reservation row is made.
    sourceOffer: endedOffer ? null : quote.offer || null,
    sourceReservationId: reserved?._id || null,
    paymentPolicy: freezePaymentPolicy(quote.offer, now),
    finalPrice: calculatedTotal,
    referenceTotal: money(quote.regularPrice + extrasTotal),
    basePrice: quote.regularPrice,
    monthly: term,
    agreement: {
      version: 2, agreedAt: now, currency: 'INR',
      package: packageItem ? { id: packageItem.id, name: packageItem.name, category: packageItem.category, description: packageItem.description, linkedPlanIds: packageItem.linkedPlanIds, quoteKey: packageQuoteKey,
        // A package priced from its category and add-ons: the parts it was sold with, frozen here so the invoice can
        // list them whatever the package or the catalogue becomes later (helpers/generateInvoiceDocumentPdf.js).
        ...(packageItem.pricing ? { pricing: JSON.parse(JSON.stringify(packageItem.pricing)) } : {}),
        // How it was sold, frozen for this project (package.md decision 7); projectUploadGate.js reads portalUploads.
        ...(packageItem.billing ? { billing: packageItem.billing, portalUploads: packageItem.portalUploads,
          ...(packageItem.paymentOptions ? { paymentOptions: [...packageItem.paymentOptions] } : {}),
          // The monthly term the client bought: cycle, length, prices, start and end. A monthly package is
          // sold as a plan order (packagePlanOrder.js), which keeps this agreement in order.salesPackage.
          ...(term ? { monthly: term } : {}) } : {}) } : null,
      regularPrice: quote.regularPrice, offerDiscount: quote.discountAmount, packagePrice: quote.finalPrice,
      offerScopeExtra: packageItem?.offerExtraPrice || 0,
      extrasTotal, priceAdjustment, adjustmentLabel, finalPrice: calculatedTotal,
      scope: [...scope], terms: [...quote.terms], baseTerms: [...(packageItem?.terms || [])],
      extras: features.map(item => ({ name: item.name, quantity: item.quantity, unitPrice: item.unitPrice, price: item.price })),
      offer: quote.offer ? {
        slug: quote.offer.slug, title: quote.offer.title, endsAt: quote.offer.endsAt,
        pricingRule: quote.offer.pricingRule, mainPrice: quote.offer.mainPrice, offerPrice: quote.offer.offerPrice,
        benefitValue: quote.offer.benefitValue, terms: quote.offer.resolvedTerms || [], appliedAt: now,
        ...(endedOffer ? { appliedAfterEnd: { reason: endedOfferReason, by: actorId ? String(actorId) : null, at: now } } : {}),
      } : null,
    },
  };
}
module.exports = { resolveProjectPricing, quotePackageForProject, endedOfferFor };
