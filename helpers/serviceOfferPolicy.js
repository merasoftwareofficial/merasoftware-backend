const { createHash } = require('node:crypto');
const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { freezePaymentPolicy } = require('./offerPaymentPolicy');
const eligible = (offer, plan, now = Date.now()) => offer?.status === 'published'
  && Date.parse(offer.endsAt) > now && offer.targets?.includes('service_plans')
  && offer.planIds?.includes(String(plan._id)) && offer.paymentPolicy && offer.paymentPolicy.mode !== 'current'
  && (offer.paymentPolicy.mode !== 'limited_uploads' || plan.servicePlan?.capability === 'upload_data');
// The plan's settings in one canonical form, so the key is the same whether the plan was read as
// a lean row (offer listing) or a model document (purchase). A document adds empty nested objects
// and default empty arrays (files: {}, slabs: []) that a stored row does not have; dropping empty
// values and sorting keys makes both read the same, while any real setting change still changes it.
const canonical = (value) => {
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort()
      .map((key) => [key, canonical(value[key])])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === null ? undefined : value;
};
const planSettings = (plan) => canonical(JSON.parse(JSON.stringify(plan.servicePlan || {}))) || {};
function quote(offer, plan) {
  const paymentPolicy = freezePaymentPolicy(offer);
  const quoteKey = createHash('sha256').update(JSON.stringify({ offerKey: offer.quoteKey, planId: String(plan._id), servicePlan: planSettings(plan), price: plan.sellingPrice ?? plan.price })).digest('hex');
  return { slug: offer.slug, title: offer.title, endsAt: offer.endsAt, paymentPolicy, quoteKey };
}
async function listServiceOffers(plan) {
  const { offers } = await fetchWebsiteCatalogue();
  return offers.filter(offer => eligible(offer, plan)).map(offer => quote(offer, plan));
}
async function resolveServiceOffer(plan, body) {
  if (!body.offerSlug) return null;
  const offers = await listServiceOffers(plan);
  const result = offers.find(offer => offer.slug === body.offerSlug);
  if (!result) throw new Error('This payment offer is expired or unavailable for this plan');
  if (body.offerQuoteKey !== result.quoteKey) throw new Error('Plan or offer changed. Refresh the offers before purchasing.');
  return result.paymentPolicy;
}
module.exports = { listServiceOffers, resolveServiceOffer, eligible };
