const Product = require('../../models/productModel');
const { isAdmin } = require('./planCategories');
const { savePlan, listPlanCatalogue, previewPlan } = require('../../helpers/servicePlanCatalogue');
const { retirePlan, restorePlan, purgePlan, setProductHidden } = require('../../helpers/servicePlanLifecycle');
const { quoteServicePlan, planQuoteKey } = require('../../helpers/servicePlanPricing');

// Website admin plan catalogue (salesBackend pattern: GET reads, PATCH saves).
const forbidden = (res) => res.status(403).json({ message: 'Forbidden', error: true, success: false });
const respondError = (res, error, fallback) => {
  if (!error.statusCode) console.error(`${fallback}:`, error);
  return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : fallback, error: true, success: false });
};
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

const listPlanCatalogueController = async (req, res) => {
  try {
    if (!await isAdmin(req)) return forbidden(res);
    return res.set('Cache-Control', 'no-store').json({ message: 'Plan catalogue', success: true, error: false, data: await listPlanCatalogue() });
  } catch (error) {
    return respondError(res, error, 'Failed to load plans');
  }
};

// Off-sale actions on one plan (helpers/servicePlanLifecycle.js; the website can only send PATCH).
const ACTIONS = {
  retire: (body, actorId) => retirePlan({ planId: body.planId, actorId }),
  restore: (body) => restorePlan({ planId: body.planId }),
  purge: (body, actorId) => purgePlan({ planId: body.planId, mode: body.mode === 'hard' ? 'hard' : 'archive', confirmName: body.confirmName, actorId }),
  hide: async (body) => ({ message: 'Plan hidden', data: await setProductHidden({ productId: body.planId, hidden: true }) }),
  unhide: async (body) => ({ message: 'Plan shown to customers', data: await setProductHidden({ productId: body.planId, hidden: false }) }),
};

// { creating: true, ...settings } creates a plan; { planId, ...settings } replaces its settings;
// { action: retire | restore | purge | hide | unhide, planId } takes it off sale or back.
const savePlanController = async (req, res) => {
  try {
    if (!await isAdmin(req)) return forbidden(res);
    const body = req.body || {};
    if (body.action !== undefined) {
      const run = ACTIONS[body.action];
      if (!run) fail('Unknown plan action');
      const product = body.planId ? await Product.findById(body.planId).select('isServicePlan category').lean().catch(() => null) : null;
      if (!product || !product.isServicePlan || product.category !== 'service_plan') fail('Plan not found', 404);
      const result = await run(body, req.userId);
      return res.json({ message: result.message, success: true, error: false, data: result.data });
    }
    const data = await savePlan(body);
    return res.json({ message: body.creating === true ? 'Plan created' : 'Plan saved', success: true, error: false, data });
  } catch (error) {
    return respondError(res, error, 'Failed to save plan');
  }
};

// PATCH /api/admin/plan-catalogue/quote — admin price check, only through quoteServicePlan().
//   { planId, purchase, tenureMonths, files, updates, releaseMode } quotes a saved plan (hidden
//   too; not retired or deleted) and returns the quoteKey that "start plan for client" needs.
//   { settings: { ...plan form fields }, purchase, ... } quotes unsaved form settings (no key).
const quotePlanController = async (req, res) => {
  try {
    if (!await isAdmin(req)) return forbidden(res);
    const body = req.body || {};
    const choice = { purchase: body.purchase, tenureMonths: body.tenureMonths, files: body.files, updates: body.updates, releaseMode: body.releaseMode };
    if (body.settings && typeof body.settings === 'object') {
      const plan = await previewPlan(body.settings);
      return res.set('Cache-Control', 'no-store').json({ success: true, error: false, data: { planId: null, quote: quoteServicePlan(plan, choice) } });
    }
    const plan = await Product.findOne({ _id: body.planId, category: 'service_plan', isServicePlan: true, retiredAt: null, archivedAt: null }).lean().catch(() => null);
    if (!plan) fail('This plan is not available', 404);
    const quote = quoteServicePlan(plan, choice);
    return res.set('Cache-Control', 'no-store').json({ success: true, error: false, data: { planId: String(plan._id), quote, quoteKey: planQuoteKey(plan, quote) } });
  } catch (error) {
    return respondError(res, error, 'Could not work out the price');
  }
};

module.exports = { listPlanCatalogueController, savePlanController, quotePlanController };
