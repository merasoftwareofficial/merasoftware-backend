const { timingSafeEqual } = require('node:crypto');
const User = require('../../models/userModel');
const Product = require('../../models/productModel');
const { fetchWebsiteCatalogue } = require('../../helpers/websiteOffers');
const { catalogueWithQuotes, savePackage, fail } = require('../../helpers/salesPackages');

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
  const plans = await Product.find({ category: 'service_plan', isServicePlan: true, isHidden: false, retiredAt: null, archivedAt: null }).select('_id serviceName servicePlan.purchaseType').lean();
  res.set('Cache-Control', 'no-store').json({ success: true, data: { packages: await catalogueWithQuotes(offers, true), offers, plans } });
});
const adminSave = handle(async (req, res) => {
  await requireAdmin(req);
  if (typeof req.body.creating !== 'boolean') fail('Specify whether this is a new package');
  const { offers } = await fetchWebsiteCatalogue();
  const item = await savePackage(req.body.item, req.body.creating, offers);
  res.json({ success: true, data: item });
});
const integrationRead = handle(async (req, res) => {
  const secret = process.env.PORTFOLIO_INTEGRATION_SECRET || '';
  if (secret.length < 32) fail('Sales integration is not configured', 503);
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.get('authorization') || '');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('Unauthorized integration', 401);
  const { offers } = await fetchWebsiteCatalogue();
  const packages = await catalogueWithQuotes(offers);
  // Service references are admin-only; public packages never expose internal notes/IDs.
  res.set('Cache-Control', 'no-store').json({ success: true, data: { packages: packages.map(({ linkedPlanIds, ...item }) => item) } });
});
module.exports = { adminRead, adminSave, integrationRead };
