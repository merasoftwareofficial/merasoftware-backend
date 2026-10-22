const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { readPackages, quotePackage, offerEligible, calculateBenefit, money, fail } = require('./salesPackages');
const { freezePaymentPolicy } = require('./offerPaymentPolicy');

// Resolve the commercial agreement before writing an order, invoice or payment.
async function resolveProjectPricing({ body, category, basePrice, features, referenceTotal }) {
  if (!body.packageId && !body.offerSlug) return null; // Existing custom-project pricing stays available.
  const { offers } = await fetchWebsiteCatalogue();
  const extrasTotal = money(features.reduce((sum, item) => sum + item.price, 0));
  let packageItem = null, quote, scope, packageQuoteKey = null;
  if (body.packageId) {
    packageItem = (await readPackages()).find(item => item.id === body.packageId && item.status === 'published');
    if (!packageItem || packageItem.category !== category) fail('This package is unavailable for the selected project category');
    const quoted = quotePackage(packageItem, offers);
    if (!body.packageQuoteKey || body.packageQuoteKey !== quoted.quoteKey) fail('Package, offer or terms changed. Refresh packages and review the new price.', 409);
    if (body.offerSlug && body.offerSlug !== quoted.quote.offer?.slug) fail('The selected offer does not match this package', 409);
    quote = quoted.quote; scope = packageItem.inclusions; packageQuoteKey = quoted.quoteKey;
  } else {
    const offer = offers.find(item => item.slug === body.offerSlug);
    if (!offerEligible(offer, category, null)) fail('The selected offer is expired or does not apply to this project category');
    if (!body.offerQuoteKey || body.offerQuoteKey !== offer.quoteKey) fail('Offer changed. Refresh offers and review the price.', 409);
    const regularPrice = Number(offer.mainPrice);
    quote = { regularPrice, ...calculateBenefit(regularPrice, offer), offer, terms: offer.resolvedTerms || [] };
    scope = offer.inclusions || [];
  }
  const adminDiscount = body.adminDiscount === undefined ? 0 : Number(body.adminDiscount);
  if (!Number.isFinite(adminDiscount) || adminDiscount < 0 || money(adminDiscount) !== adminDiscount) fail('Enter a valid additional admin discount');
  const discountReason = String(body.discountReason || '').trim();
  if (adminDiscount > 0 && (!discountReason || discountReason.length > 500)) fail('Explain the additional admin discount');
  const calculatedTotal = money(quote.finalPrice + extrasTotal - adminDiscount);
  if (calculatedTotal < 0) fail('Additional discount exceeds the project amount');
  if (money(Number(body.sellingPrice)) !== calculatedTotal) fail('Project price changed. Review the current package and extras before creating it.', 409);
  const now = new Date();
  // Recheck at the final decision point, including requests crossing the deadline.
  if (quote.offer && Date.parse(quote.offer.endsAt) <= now.getTime()) fail('Offer has expired. Refresh the price before continuing.', 409);
  return {
    paymentPolicy: freezePaymentPolicy(quote.offer, now),
    finalPrice: calculatedTotal,
    referenceTotal: money(quote.regularPrice + extrasTotal),
    basePrice: quote.regularPrice,
    agreement: {
      version: 1, agreedAt: now, currency: 'INR',
      package: packageItem ? { id: packageItem.id, name: packageItem.name, category: packageItem.category, description: packageItem.description, linkedPlanIds: packageItem.linkedPlanIds, quoteKey: packageQuoteKey } : null,
      regularPrice: quote.regularPrice, offerDiscount: quote.discountAmount, packagePrice: quote.finalPrice,
      extrasTotal, adminDiscount, discountReason, finalPrice: calculatedTotal,
      scope: [...scope], terms: [...quote.terms],
      extras: features.map(item => ({ name: item.name, quantity: item.quantity, unitPrice: item.unitPrice, price: item.price })),
      offer: quote.offer ? {
        slug: quote.offer.slug, title: quote.offer.title, endsAt: quote.offer.endsAt,
        pricingRule: quote.offer.pricingRule, mainPrice: quote.offer.mainPrice, offerPrice: quote.offer.offerPrice,
        benefitValue: quote.offer.benefitValue, terms: quote.offer.resolvedTerms || [], appliedAt: now,
      } : null,
    },
  };
}
module.exports = { resolveProjectPricing };
