const { createHash } = require('node:crypto');
const Catalogue = require('../models/salesCatalogueModel');
const Product = require('../models/productModel');
const { KEY_PATTERN, getProjectCategory } = require('./projectCategories');

const safeId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80 && !['constructor', 'prototype', '__proto__'].includes(value);
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const starterScope = [
  'A single-page business website with a contact enquiry link',
  'Google Business Profile setup or optimisation',
  'Facebook and Instagram business profile setup',
  'WhatsApp Business profile and contact-link setup',
  'One branded social post design to introduce your business',
];
const defaultTerms = ['Domain, hosting, advertising spend and ongoing management are separate unless agreed in writing.', 'You provide business details, logo, photos and required account access.', 'Scope, delivery timeline and applicable taxes are confirmed before payment.'];
const DEFAULT_PACKAGES = [
  { id: 'starter', name: 'Business Starter', description: 'One-page website and business profile setup.', regularPrice: 10000, offerExtraPrice: 0, inclusions: starterScope },
  { id: 'starter-plus', name: 'Business Starter Plus', description: 'Starter setup with a three-page website.', regularPrice: 12000, offerExtraPrice: 2000, inclusions: ['A three-page business website with a contact enquiry link', ...starterScope.slice(1), 'Basic page titles and descriptions'] },
  { id: 'starter-complete', name: 'Business Starter Complete', description: 'Starter setup with five website pages and three social post designs.', regularPrice: 14000, offerExtraPrice: 4000, inclusions: ['A five-page business website with a contact enquiry link', ...starterScope.slice(1, 4), 'Three branded social post designs', 'Basic page titles and descriptions'] },
].map((item, order) => ({ ...item, status: 'published', category: 'standard_websites', offerSlug: 'page', terms: defaultTerms, linkedPlanIds: [], order }));

async function readPackages() {
  const row = await Catalogue.findById('packages').lean();
  return Object.values(row ? row.packages : Object.fromEntries(DEFAULT_PACKAGES.map(item => [item.id, item])))
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
  return {
    id: raw.id, name: cleanText(raw.name, 120, 'package name'), description: cleanText(raw.description, 500, 'description'),
    category: raw.category, status: raw.status, regularPrice: amount(raw.regularPrice, 'regular price'),
    offerExtraPrice: amount(raw.offerExtraPrice, 'offer extras price'), offerSlug: raw.offerSlug || '',
    inclusions: lines(raw.inclusions, 50, true), terms: lines(raw.terms, 50, false),
    linkedPlanIds: [...new Set(raw.linkedPlanIds)], order: raw.order,
  };
}
function offerEligible(offer, category, packageId, now = Date.now()) {
  return !!offer && offer.status === 'published' && Date.parse(offer.endsAt) > now
    && (!offer.targets || offer.targets.includes('projects'))
    && Array.isArray(offer.applicableCategories) && offer.applicableCategories.includes(category)
    && (!offer.packageIds?.length || (!!packageId && offer.packageIds.includes(packageId)));
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
  const offer = offerEligible(candidate, item.category, item.id, now) ? candidate : null;
  const prices = calculateBenefit(item.regularPrice, offer, item.offerExtraPrice);
  const quote = { ...prices, regularPrice: item.regularPrice, offer,
    terms: [...new Set([...item.terms, ...(offer?.resolvedTerms || [])])] };
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
  if (item.offerSlug && item.status !== 'archived') {
    const offer = offers.find(row => row.slug === item.offerSlug);
    if (!offer || !offer.pricingRule || !offer.applicableCategories?.includes(item.category) || (offer.packageIds?.length && !offer.packageIds.includes(item.id))) fail('The linked offer is unavailable or does not match this package category');
    calculateBenefit(item.regularPrice, offer, item.offerExtraPrice);
  }
  try {
    await Catalogue.updateOne({ _id: 'packages' }, { $setOnInsert: { packages: Object.fromEntries(DEFAULT_PACKAGES.map(row => [row.id, row])) } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  const path = `packages.${item.id}`;
  const result = await Catalogue.updateOne({ _id: 'packages', ...(creating ? { [path]: { $exists: false } } : { [path]: { $exists: true } }) }, { $set: { [path]: item } });
  if (!result.matchedCount) fail('Package changed; refresh the catalogue and try again', 409);
  return item;
}
module.exports = { DEFAULT_PACKAGES, money, fail, readPackages, validatePackage, offerEligible, calculateBenefit, quotePackage, catalogueWithQuotes, savePackage };
