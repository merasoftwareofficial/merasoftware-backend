const User = require('../../models/userModel');
const { listPlanCategories, planCategoryUsage, savePlanCategory, useProjectCategory } = require('../../helpers/planCategories');

// Admin plan categories. Called by the website admin control panel (salesBackend pattern:
// GET reads, PATCH saves), so the admin role is checked on the token and on the stored user.
async function isAdmin(req) {
  if (req.userRole !== 'admin') return false;
  const user = await User.findById(req.userId).select('roles').lean();
  return Boolean(user?.roles?.includes('admin'));
}

const respondError = (res, error, fallback) => {
  if (!error.statusCode) console.error(`${fallback}:`, error);
  return res.status(error.statusCode || 500).json({
    message: error.statusCode ? error.message : fallback,
    error: true,
    success: false,
  });
};

// Every plan category (archived included) with how many plans use it.
const listPlanCategoriesController = async (req, res) => {
  try {
    if (!await isAdmin(req)) return res.status(403).json({ message: 'Forbidden', error: true, success: false });
    const [categories, usage] = await Promise.all([listPlanCategories(), planCategoryUsage()]);
    return res.set('Cache-Control', 'no-store').json({
      message: 'Plan categories',
      success: true,
      error: false,
      data: categories.map((entry) => ({ ...entry, usage: { plans: usage[entry.key] || 0 } })),
    });
  } catch (error) {
    return respondError(res, error, 'Failed to fetch plan categories');
  }
};

// Create a plan category ({ creating: true, key, label, ... }) or update the fields sent.
const savePlanCategoryController = async (req, res) => {
  try {
    if (!await isAdmin(req)) return res.status(403).json({ message: 'Forbidden', error: true, success: false });
    const body = req.body || {};
    if (body.action !== undefined && body.action !== 'use_project_category') return res.status(400).json({ success: false, error: true, message: 'Unknown category action' });
    const data = body.action === 'use_project_category'
      ? await useProjectCategory(body.projectCategoryKey, req.userId)
      : await savePlanCategory(body, req.userId);
    return res.json({
      message: req.body?.creating === true ? 'Plan category created' : 'Plan category saved',
      success: true,
      error: false,
      data,
    });
  } catch (error) {
    return respondError(res, error, 'Failed to save plan category');
  }
};

module.exports = { listPlanCategoriesController, savePlanCategoryController, isAdmin };
