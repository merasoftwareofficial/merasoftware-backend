const { timingSafeEqual } = require('node:crypto');
const User = require('../../models/userModel');
const Product = require('../../models/productModel');
const { fetchWebsiteCatalogue } = require('../../helpers/websiteOffers');
const { catalogueWithQuotes, savePackage, linkOfferPackages, unlinkPackagePage, fail } = require('../../helpers/salesPackages');
const { listProjectCategories } = require('../../helpers/projectCategories');

async function requireAdmin(req) {
  const user = await User.findById(req.userId).select('roles');
  if (req.userRole !== 'admin' || !user?.roles?.includes('admin')) fail('Forbidden', 403);
}
const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: true, message: error.statusCode ? error.message : 'Could not load or save sales packages' }); }
};
const adminRead = handle(async (req, res) => {
  await requireAdmin(req);
  const { offers } = await fetchWebsiteCatalogue();
  const plans = await Product.find({ category: 'service_plan', isServicePlan: true, isHidden: false, retiredAt: null, archivedAt: null }).select('_id serviceName servicePlan.purchaseType servicePlan.capability').lean();
  // Project categories come from the SSOT so the website offer/package editors never hardcode them.
  const categories = (await listProjectCategories()).map(({ category, label, status, sortOrder }) => ({ category, label, status, sortOrder }));
  res.set('Cache-Control', 'no-store').json({ success: true, data: { packages: await catalogueWithQuotes(offers, true), offers, plans, categories } });
});
const adminSave = handle(async (req, res) => {
  await requireAdmin(req);
  if (typeof req.body.creating !== 'boolean') fail('Specify whether this is a new package');
  const { offers, packagePages } = await fetchWebsiteCatalogue();
  const item = await savePackage(req.body.item, req.body.creating, offers, packagePages);
  res.json({ success: true, data: item });
});
const adminLinkOffer = handle(async (req, res) => {
  await requireAdmin(req);
  const { offers } = await fetchWebsiteCatalogue();
  const packageIds = await linkOfferPackages(req.body.offerSlug, req.body.packageIds, offers);
  res.json({ success: true, data: { offerSlug: req.body.offerSlug, packageIds } });
});
// Called by the website before it deletes a package page, so no package keeps a deleted page.
const adminUnlinkPage = handle(async (req, res) => {
  await requireAdmin(req);
  const updated = await unlinkPackagePage(req.body.pageSlug);
  res.json({ success: true, data: { pageSlug: req.body.pageSlug, updated } });
});
const integrationRead = handle(async (req, res) => {
  const secret = process.env.PORTFOLIO_INTEGRATION_SECRET || '';
  if (secret.length < 32) fail('Sales integration is not configured', 503);
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.get('authorization') || '');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('Unauthorized integration', 401);
  const { offers } = await fetchWebsiteCatalogue();
  const packages = await catalogueWithQuotes(offers);
  // Category names for the public package cards; only active categories, key and name only.
  const categories = (await listProjectCategories()).filter(entry => entry.status === 'active').map(({ category, label }) => ({ category, label }));
  // Service references are admin-only; public packages never expose internal notes/IDs.
  res.set('Cache-Control', 'no-store').json({ success: true, data: { packages: packages.map(({ linkedPlanIds, ...item }) => item), categories } });
});
module.exports = { adminRead, adminSave, adminLinkOffer, adminUnlinkPage, integrationRead };
