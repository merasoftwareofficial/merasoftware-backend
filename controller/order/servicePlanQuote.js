const Product = require('../../models/productModel');
const { quoteServicePlan, planQuoteKey, priceRange } = require('../../helpers/servicePlanPricing');
const { ON_SALE, readSaleCatalogue } = require('../../helpers/servicePlanPublicCatalogue');
const { requireIntegration } = require('../../helpers/integrationAuth');

// Quotes for the plan builder (portal) and the public plans page (website). Every price comes from
// helpers/servicePlanPricing.js; the purchase re-quotes and refuses a quoteKey that changed.

const respond = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (error) {
    if (!error.statusCode) console.error('Plan quote failed:', error);
    res.status(error.statusCode || 500).json({ success: false, error: true, message: error.statusCode ? error.message : 'Could not work out the price. Please try again.' });
  }
};

async function quoteFor(body = {}) {
  const plan = await Product.findOne({ ...ON_SALE, _id: body.planId }).lean().catch(() => null);
  if (!plan) throw Object.assign(new Error('This plan is not available'), { statusCode: 404 });
  const quote = quoteServicePlan(plan, {
    purchase: body.purchase,
    tenureMonths: body.tenureMonths,
    files: body.files,
    updates: body.updates,
    releaseMode: body.releaseMode,
  });
  return { planId: String(plan._id), quote, quoteKey: planQuoteKey(plan, quote) };
}

// What the public page may show of a plan: its name, card range and the choices it offers.
const publicPlan = (plan) => {
  const sp = plan.servicePlan || {};
  return {
    _id: String(plan._id),
    serviceName: plan.serviceName,
    description: plan.formattedDescriptions?.[0]?.content || '',
    categoryKey: sp.categoryKey || null,
    priceRange: (() => { try { return priceRange(plan); } catch { return null; } })(),
    pricingMode: sp.pricingMode === 'flexible' ? 'flexible' : 'fixed',
    capability: sp.capability,
    purchaseType: sp.purchaseType,
    dependency: sp.dependency,
    files: sp.pricingMode === 'flexible' ? sp.files : undefined,
    ratePerFile: sp.pricingMode === 'flexible' ? sp.ratePerFile : undefined,
    slabs: sp.pricingMode === 'flexible' ? (sp.slabs || []).map(({ fromFile, ratePerFile }) => ({ fromFile, ratePerFile })) : undefined,
    updatesPerMonth: sp.pricingMode === 'flexible' ? sp.updatesPerMonth : undefined,
    filesLimit: sp.filesLimit,
    portalAccessCount: sp.portalAccessCount,
    limitScope: sp.limitScope,
    allowOneTime: sp.pricingMode === 'flexible' ? Boolean(sp.allowOneTime) : sp.purchaseType === 'one_time',
    oneTimeValidityDays: sp.oneTimeValidityDays || null,
    maxTenureMonths: sp.maxTenureMonths || 12,
    billingOptions: (sp.billingOptions || []).map(({ billingCycle, discountPercent }) => ({ billingCycle, discountPercent: discountPercent || 0 })),
    releaseMode: sp.releaseMode || 'all_at_once',
    customerCanChooseRelease: Boolean(sp.customerCanChooseRelease),
  };
};

// POST /api/customer/service-plan-quote (signed-in customer, plan builder).
const customerQuote = respond(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ success: true, data: await quoteFor(req.body) });
});

// Browser-safe, customer-authenticated catalogue. Keeps the nested portal plan shape.
const customerCatalogue = respond(async (req, res) => {
  if (req.userRole !== 'customer') return res.status(403).json({ success: false, error: true, message: 'Switch to your customer role to browse services.' });
  res.set('Cache-Control', 'no-store').json({ success: true, data: await readSaleCatalogue() });
});

// GET /api/integration/plan-catalogue (website server): plans on sale + active categories.
const integrationCatalogue = respond(async (req, res) => {
  requireIntegration(req);
  const { plans, categories } = await readSaleCatalogue();
  res.set('Cache-Control', 'no-store').json({
    success: true,
    data: {
      plans: plans.map(publicPlan),
      categories,
    },
  });
});

// PATCH /api/integration/plan-catalogue/quote (website estimator; PATCH = salesBackend's body verb).
const integrationQuote = respond(async (req, res) => {
  requireIntegration(req);
  const { quote } = await quoteFor(req.body);
  res.set('Cache-Control', 'no-store').json({ success: true, data: { planId: req.body.planId, quote } });
});

module.exports = { customerQuote, customerCatalogue, integrationCatalogue, integrationQuote, publicPlan };
