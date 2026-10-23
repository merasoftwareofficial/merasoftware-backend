const { createHash } = require('node:crypto');
const Catalogue = require('../models/salesCatalogueModel');
const Product = require('../models/productModel');
const { KEY_PATTERN, getProjectCategory } = require('./projectCategories');

const safeId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80 && !['constructor', 'prototype', '__proto__'].includes(value);
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// Only packages created by an admin exist; there are no built-in defaults.
async function readPackages() {
  const row = await Catalogue.findById('packages').lean();
  return Object.values(row ? row.packages : {})
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}
const cleanText = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`Enter a valid ${label}`);
  return value.trim();
};
function validatePackage(raw) {
  if (!raw || !safeId(raw.id)) fail('Use a safe lowercase package ID');
  if (typeof raw.category !== 'string' || !KEY_PATTERN.test(raw.category)) fail('Choose a project category');
  if (!['draft', 'published', 'archived'].includes(raw.status)) fail('Choose a package status');
  const amount = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000000 || Math.abs(money(value) - value) > 0.000001) fail(`Enter a valid ${label} with at most two decimal places`);
    return value;
  };
  const lines = (value, max, required) => {
    if (!Array.isArray(value) || value.length > max || (required && !value.length)) fail('Enter the included work and terms as lists');
    return value.map(line => cleanText(line, 1500, 'scope or term'));
  };
  if (raw.offerSlug && !safeId(raw.offerSlug)) fail('Choose a valid offer');
  if (!Number.isInteger(raw.order) || raw.order < 0 || raw.order > 9999) fail('Enter a valid display order');
  if (!Array.isArray(raw.linkedPlanIds) || raw.linkedPlanIds.length > 30 || raw.linkedPlanIds.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) fail('Choose valid service references');
  const regularPrice = amount(raw.regularPrice, 'main price');
  const discountedPrice = amount(raw.discountedPrice, 'discounted price');
  if (discountedPrice > regularPrice) fail('Discounted price cannot be more than the main price');
  return {
    id: raw.id, name: cleanText(raw.name, 120, 'package name'), description: cleanText(raw.description, 500, 'description'),
    category: raw.category, status: raw.status, regularPrice, discountedPrice,
    offerExtraPrice: amount(raw.offerExtraPrice, 'offer extras price'), offerSlug: raw.offerSlug || '',
    inclusions: lines(raw.inclusions, 50, true), terms: lines(raw.terms, 50, false),
    linkedPlanIds: [...new Set(raw.linkedPlanIds)], order: raw.order,
  };
}
// Which packages an offer applies to is stored only on the package (offerSlug), so one package
// carries at most one offer while one offer may serve many packages.
function offerEligible(offer, category, now = Date.now()) {
  return !!offer && offer.status === 'published' && Date.parse(offer.endsAt) > now
    && (!offer.targets || offer.targets.includes('projects'))
    && Array.isArray(offer.applicableCategories) && offer.applicableCategories.includes(category);
}
function calculateBenefit(regularPrice, offer, extra = 0) {
  if (!offer) return { discountAmount: 0, finalPrice: regularPrice };
  let finalPrice;
  if (offer.pricingRule === 'fixed_price') finalPrice = Number(offer.offerPrice) + extra;
  else if (offer.pricingRule === 'fixed_discount') finalPrice = regularPrice - Number(offer.benefitValue);
  else if (offer.pricingRule === 'percentage') finalPrice = regularPrice * (1 - Number(offer.benefitValue) / 100);
  else fail('Configure the selected offer pricing rule before using it');
  if (!Number.isFinite(finalPrice) || finalPrice < 0 || finalPrice > regularPrice) fail('Offer pricing must be between zero and the regular package price');
  finalPrice = money(finalPrice);
  return { discountAmount: money(regularPrice - finalPrice), finalPrice };
}
function quotePackage(item, offers, now = Date.now()) {
  const candidate = offers.find(offer => offer.slug === item.offerSlug);
  const offer = offerEligible(candidate, item.category, now) ? candidate : null;
  const terms = [...new Set([...item.terms, ...(offer?.resolvedTerms || [])])];
  // A live offer is calculated from the main price. Without one the package's discounted price
  // is the price and is quoted as the base, so agreements/invoices never show an "Offer benefit".
  const discountedPrice = item.discountedPrice ?? item.regularPrice;
  const quote = offer
    ? { ...calculateBenefit(item.regularPrice, offer, item.offerExtraPrice), regularPrice: item.regularPrice, offer, terms }
    : { discountAmount: 0, finalPrice: discountedPrice, regularPrice: discountedPrice, offer: null, terms };
  const quoteKey = createHash('sha256').update(JSON.stringify({ item, quote })).digest('hex');
  return { ...item, quote, quoteKey };
}
async function catalogueWithQuotes(offers, admin = false) {
  const items = await readPackages();
  return items.filter(item => admin || item.status === 'published').map(item => quotePackage(item, offers));
}
async function savePackage(raw, creating, offers) {
  const item = validatePackage(raw);
  const existing = await readPackages();
  if (creating && existing.some(row => row.id === item.id)) fail('This package ID already exists', 409);
  if (!creating && !existing.some(row => row.id === item.id)) fail('Package not found', 404);
  // An archived category keeps its old packages, but only an archived package may stay in it.
  const category = await getProjectCategory(item.category);
  if (!category || (category.status !== 'active' && item.status !== 'archived')) fail('Choose an active project category');
  if (item.linkedPlanIds.length) {
    const count = await Product.countDocuments({ _id: { $in: item.linkedPlanIds }, category: 'service_plan', isServicePlan: true, isHidden: false, retiredAt: null, archivedAt: null });
    if (count !== item.linkedPlanIds.length) fail('A referenced service is unavailable. Select active portal services.');
  }
  if (item.offerSlug && item.status !== 'archived') checkOfferFits(item, offers.find(row => row.slug === item.offerSlug));
  try {
    await Catalogue.updateOne({ _id: 'packages' }, { $setOnInsert: { packages: {} } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  const path = `packages.${item.id}`;
  const result = await Catalogue.updateOne({ _id: 'packages', ...(creating ? { [path]: { $exists: false } } : { [path]: { $exists: true } }) }, { $set: { [path]: item } });
  if (!result.matchedCount) fail('Package changed; refresh the catalogue and try again', 409);
  return item;
}
function checkOfferFits(item, offer) {
  if (!offer || !offer.pricingRule || !offer.applicableCategories?.includes(item.category)) fail(`The offer is unavailable or does not match the category of ${item.name}`);
  calculateBenefit(item.regularPrice, offer, item.offerExtraPrice);
}
// The offer editor's package ticks: ticked packages move to this offer (from any other offer),
// unticked packages that were on it lose it. Same package.offerSlug the package editor saves.
async function linkOfferPackages(offerSlug, packageIds, offers) {
  if (!safeId(offerSlug)) fail('Choose a valid offer');
  if (!Array.isArray(packageIds) || packageIds.length > 100 || packageIds.some(id => !safeId(id))) fail('Choose valid packages');
  const offer = offers.find(row => row.slug === offerSlug);
  if (!offer) fail('Save the offer before linking packages');
  if (packageIds.length && !offer.pricingRule) fail('Choose a pricing rule for this offer before linking packages');
  const packages = await readPackages();
  const wanted = new Set(packageIds);
  const changes = {};
  for (const id of wanted) {
    const item = packages.find(row => row.id === id);
    if (!item || item.status === 'archived') fail('A selected package is unavailable. Refresh and try again.');
    checkOfferFits(item, offer);
    if (item.offerSlug !== offerSlug) changes[`packages.${id}.offerSlug`] = offerSlug;
  }
  for (const item of packages) if (item.offerSlug === offerSlug && !wanted.has(item.id)) changes[`packages.${item.id}.offerSlug`] = '';
  if (Object.keys(changes).length) await Catalogue.updateOne({ _id: 'packages' }, { $set: changes });
  return [...wanted];
}
module.exports = { money, fail, readPackages, validatePackage, offerEligible, calculateBenefit, quotePackage, catalogueWithQuotes, savePackage, linkOfferPackages };
