const User = require('../../models/userModel');
const { requireIntegration } = require('../../helpers/integrationAuth');
const Product = require('../../models/productModel');
const { fetchWebsiteCatalogue } = require('../../helpers/websiteOffers');
const { catalogueWithQuotes, readPackages, quotePackageChoice, savePackage, linkOfferPackages, unlinkPackagePage, fail } = require('../../helpers/salesPackages');
const { listProjectCategories, categoryUsage } = require('../../helpers/projectCategories');
const { FEATURE_UPGRADE_CATEGORY } = require('../../helpers/featureCatalogue');
const drafts = require('../../helpers/packageDrafts');

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
  // The package form also prices a package from them (base price) and edits them in a dialog (the other fields,
  // and where each is used, so archiving can warn).
  const [list, usage] = await Promise.all([listProjectCategories(), categoryUsage()]);
  const categories = list.map(({ category, label, status, sortOrder, basePrice, description, terms, startingNodeTitle, customerSelectable, locked }) => ({
    category, label, status, sortOrder, basePrice, description, terms, startingNodeTitle, customerSelectable, locked, usage: usage[category] || { projects: 0, features: 0, packages: 0 } }));
  // The add-on services a package can be priced from (the same catalogue a custom project takes its add-ons from).
  // The website narrows them to the chosen category; the save checks again with featureCatalogue.js.
  const addOns = (await Product.find({ category: FEATURE_UPGRADE_CATEGORY, retiredAt: null, archivedAt: null }).sort({ createdAt: -1 })
    .select('_id serviceName price sellingPrice isHidden isQuantityBased formattedDescriptions compatibleWith terms').lean())
    .map(row => ({ id: String(row._id), name: row.serviceName, unitPrice: row.sellingPrice ?? row.price ?? 0, description: row.formattedDescriptions?.[0]?.content || '',
      isHidden: !!row.isHidden, isQuantityBased: !!row.isQuantityBased, compatibleWith: Array.isArray(row.compatibleWith) ? row.compatibleWith : [],
      terms: Array.isArray(row.terms) ? row.terms : [] }));
  res.set('Cache-Control', 'no-store').json({ success: true, data: { packages: await catalogueWithQuotes(offers, true), offers, plans, categories, addOns, drafts: await drafts.listDrafts() } });
});
// Package working copies (helpers/packageDrafts.js): save, delete after publish or discard, forget an ended offer.
const adminDraft = handle(async (req, res) => {
  await requireAdmin(req);
  const { action, packageId, version, data, offerSlug } = req.body || {};
  if (action === 'save') return res.json({ success: true, data: await drafts.saveDraft({ packageId, version, data }, req.userId) });
  if (action === 'delete') return res.json({ success: true, data: await drafts.deleteDraft(packageId, version) });
  if (action === 'clearOffer') return res.json({ success: true, data: await drafts.clearDraftOffer(packageId, offerSlug) });
  fail('Choose a draft action');
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
  await drafts.unlinkDraftPage(req.body.pageSlug);
  res.json({ success: true, data: { pageSlug: req.body.pageSlug, updated } });
});
const integrationRead = handle(async (req, res) => {
  requireIntegration(req);
  const { offers } = await fetchWebsiteCatalogue();
  const packages = await catalogueWithQuotes(offers);
  // Category names for the public package cards; only active categories, key and name only.
  const categories = (await listProjectCategories()).filter(entry => entry.status === 'active').map(({ category, label }) => ({ category, label }));
  // Service references are admin-only; public packages never expose internal notes/IDs.
  // The frozen add-on pricing (service IDs and prices) is the admin's working data, never public.
  res.set('Cache-Control', 'no-store').json({ success: true, data: { packages: packages.map(({ linkedPlanIds, pricing, ...item }) => item), categories } });
});
// PATCH /api/integration/sales-packages/quote (the website's package customize page, package.md §3):
// { packageId, choice } -> the one choice quote. Nothing is bought here.
const integrationQuote = handle(async (req, res) => {
  requireIntegration(req);
  const item = (await readPackages()).find(row => row.id === req.body?.packageId && row.status === 'published');
  if (!item) fail('This package is not available.', 404);
  const { offers } = await fetchWebsiteCatalogue();
  res.set('Cache-Control', 'no-store').json({ success: true, data: { quote: quotePackageChoice(item, offers, req.body?.choice || {}) } });
});
// PATCH /api/admin/sales-packages/quote: the same choice quote for the portal's create-project form, so a
// monthly package project is priced as its creation prices it (projectPricing.js), with a customer's
// reservation at the offer it froze. { packageId, choice, customerId?, offerReservationId? }
const adminQuote = handle(async (req, res) => {
  await requireAdmin(req);
  const { quoteChoice } = require('../../helpers/salesPackages');
  const { quotePackageForProject } = require('../../helpers/projectPricing');
  const item = (await readPackages()).find(row => row.id === req.body?.packageId && row.status === 'published');
  if (!item) fail('This package is not available.', 404);
  let reserved = null;
  if (req.body?.offerReservationId) {
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(req.body.offerReservationId) || !mongoose.isValidObjectId(req.body.customerId)) fail('Select a reserved offer for this customer');
    reserved = await require('../../models/offerReservationModel').findOne({ _id: req.body.offerReservationId, userId: req.body.customerId }).lean();
    if (!reserved || reserved.offerSnapshot?.packageId !== item.id) fail('This reservation belongs to another package', 409);
  }
  const offers = reserved ? [] : (await fetchWebsiteCatalogue()).offers;
  res.set('Cache-Control', 'no-store').json({ success: true, data: { quote: quoteChoice(item, quotePackageForProject(item, reserved, offers), req.body?.choice || {}) } });
});
module.exports = { adminRead, adminSave, adminDraft, adminLinkOffer, adminUnlinkPage, adminQuote, integrationRead, integrationQuote };
