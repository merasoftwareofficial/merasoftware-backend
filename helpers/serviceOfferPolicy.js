const { createHash } = require('node:crypto');
const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { freezePaymentPolicy } = require('./offerPaymentPolicy');
const eligible = (offer, plan, now = Date.now()) => offer?.status === 'published'
  && Date.parse(offer.endsAt) > now && offer.targets?.includes('service_plans')
  && offer.planIds?.includes(String(plan._id)) && offer.paymentPolicy && offer.paymentPolicy.mode !== 'current'
  && (offer.paymentPolicy.mode !== 'limited_uploads' || plan.servicePlan?.capability === 'upload_data');
function quote(offer, plan) {
  const paymentPolicy = freezePaymentPolicy(offer);
  const quoteKey = createHash('sha256').update(JSON.stringify({ offerKey: offer.quoteKey, planId: String(plan._id), servicePlan: plan.servicePlan, price: plan.sellingPrice ?? plan.price })).digest('hex');
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
