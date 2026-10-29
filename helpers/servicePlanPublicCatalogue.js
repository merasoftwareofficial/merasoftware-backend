const Product = require('../models/productModel');
const { listPlanCategories } = require('./planCategories');
const { listProjectCategories } = require('./projectCategories');
const { projectPlanCatalogue } = require('./planProjectCategories');
const { priceRange } = require('./servicePlanPricing');

// Shared sale eligibility for website showcase, portal discovery and customer quotes.
const ON_SALE = { category: 'service_plan', isServicePlan: true, isHidden: { $ne: true }, retiredAt: null, archivedAt: null };
async function readSaleCatalogue() {
  const [plans, legacy, projects] = await Promise.all([
    Product.find(ON_SALE).select('serviceName category isServicePlan price sellingPrice formattedDescriptions servicePlan updatedAt').sort({ createdAt: -1 }).lean(),
    listPlanCategories(),
    listProjectCategories(),
  ]);
  const { plans: mapped, categories } = projectPlanCatalogue(plans, legacy, projects);
  return {
    plans: mapped.map(plan => ({ ...plan, priceRange: (() => { try { return priceRange(plan); } catch { return null; } })() })),
    categories: categories.filter(row => row.status === 'active').map(({ key, label, description, sortOrder }) => ({ key, label, description, sortOrder })),
  };
}
module.exports = { ON_SALE, readSaleCatalogue };
