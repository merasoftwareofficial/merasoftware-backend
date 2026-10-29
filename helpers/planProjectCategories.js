// Read-time compatibility only: historical category keys and purchased snapshots are untouched.
// Explicit legacy links are followed; names are never used to guess a relationship.
function projectPlanCatalogue(plans, legacy, projects) {
  const main = new Map(projects.map(row => [row.category, row]));
  const links = new Map(legacy.filter(row => row.linkedProjectCategory && main.has(row.linkedProjectCategory))
    .map(row => [row.key, row.linkedProjectCategory]));
  const legacyKeys = new Set(legacy.map(row => row.key));
  const keyFor = plan => {
    const key = plan.servicePlan?.categoryKey;
    if (plan.servicePlan?.projectCategoryKey) return plan.servicePlan.projectCategoryKey;
    return links.get(key) || (legacyKeys.has(key) && main.has(key) ? `legacy:${key}` : key);
  };
  const mappedPlans = plans.map(plan => ({ ...plan, servicePlan: { ...plan.servicePlan, categoryKey: keyFor(plan) } }));
  const categories = projects.map(row => ({ ...row, key: row.category, linkedProjectCategory: row.category,
    usage: { plans: mappedPlans.filter(plan => plan.servicePlan.categoryKey === row.category).length } }));
  // Unmapped legacy groups stay readable until an admin explicitly maps them.
  for (const row of legacy) {
    if (links.has(row.key)) continue;
    categories.push({ ...row, key: main.has(row.key) ? `legacy:${row.key}` : row.key, legacy: true, usage: { plans: mappedPlans.filter(plan => plan.servicePlan.categoryKey === (main.has(row.key) ? `legacy:${row.key}` : row.key)).length } });
  }
  return { plans: mappedPlans, categories, legacyCategories: legacy };
}
module.exports = { projectPlanCatalogue };
