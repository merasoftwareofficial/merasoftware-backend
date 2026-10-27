const { isAdmin } = require('./planCategories');
const { savePlan, listPlanCatalogue } = require('../../helpers/servicePlanCatalogue');

// Website admin plan catalogue (salesBackend pattern: GET reads, PATCH saves).
const forbidden = (res) => res.status(403).json({ message: 'Forbidden', error: true, success: false });
const respondError = (res, error, fallback) => {
  if (!error.statusCode) console.error(`${fallback}:`, error);
  return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : fallback, error: true, success: false });
};

const listPlanCatalogueController = async (req, res) => {
  try {
    if (!await isAdmin(req)) return forbidden(res);
    return res.set('Cache-Control', 'no-store').json({ message: 'Plan catalogue', success: true, error: false, data: await listPlanCatalogue() });
  } catch (error) {
    return respondError(res, error, 'Failed to load plans');
  }
};

// { creating: true, ...settings } creates a plan; { planId, ...settings } replaces its settings.
const savePlanController = async (req, res) => {
  try {
    if (!await isAdmin(req)) return forbidden(res);
    const data = await savePlan(req.body);
    return res.json({ message: req.body?.creating === true ? 'Plan created' : 'Plan saved', success: true, error: false, data });
  } catch (error) {
    return respondError(res, error, 'Failed to save plan');
  }
};

module.exports = { listPlanCatalogueController, savePlanController };
