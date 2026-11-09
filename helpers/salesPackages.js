const { createHash } = require('node:crypto');
const Catalogue = require('../models/salesCatalogueModel');
const Product = require('../models/productModel');
const Draft = require('../models/packageDraftModel');
const { KEY_PATTERN, getProjectCategory } = require('./projectCategories');
const { MAX_PROJECT_FILES_PER_UPLOAD } = require('../config/uploadLimits');
const { buildInstallments } = require('./projectInstallments');

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
// The package page design (website src/lib/package-design.ts, same limits). The website shows it on
// /package/<id>; it never changes price or scope, so it stays out of the quote key like pages.
const DESIGN_FIELDS = { eyebrow: [100, true], heading: [160, true], headingHighlight: [120, false], supportingLine: [200, false],
  subheading: [160, true], tagline: [100, true], badge: [60, true], priceDescription: [200, true], ctaLabel: [80, true], contactHref: [500, true] };
const contactLink = value => /^mailto:[^\s?]+@[^\s?]+(?:\?.*)?$/.test(value) || /^tel:\+?[\d\s()-]{5,30}$/.test(value)
  || (() => { try { return new URL(value).protocol === 'https:'; } catch { return false; } })();
function validateDesign(raw) {
  if (raw === undefined || raw === null) return undefined; // Packages saved before page design existed.
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !DESIGN_FIELDS[key])) fail('Enter a valid page design');
  const design = {};
  for (const [key, [max, required]] of Object.entries(DESIGN_FIELDS)) {
    const value = raw[key] === undefined ? '' : raw[key];
    if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(`Enter a valid page design ${key}`);
    design[key] = value.trim();
  }
  if (!contactLink(design.contactHref)) fail('Use an HTTPS, email (mailto:) or telephone (tel:) contact link');
  return design;
}
// How a customer buys the package (merasoftware/src/docs/package.md, decision 7). Optional as a whole:
// a package saved before these settings keeps its quote key and works as before until the admin
// chooses them. They change what is sold, so unlike pages and design they are part of the quote key.
const PACKAGE_BILLING = ['one_time', 'monthly'];
const PACKAGE_PAYMENT_OPTIONS = ['full', 'installments_2', 'installments_3'];
const INSTALLMENT_COUNT = { installments_2: 2, installments_3: 3 };
// Monthly packages (package.md decision 9) are priced by the plan engine's tested rules
// (servicePlanPricing.js), never copied: the package's price is the monthly price (fixed) or the
// rate per file (per_file), and its billing cycles and lengths follow the plan rules.
const MONTHLY_PRICING = ['fixed', 'per_file'];
function monthlyPlanShape(monthly, unitPrice) {
  const servicePlan = monthly.pricing === 'per_file'
    ? { pricingMode: 'flexible', capability: 'upload_data', ratePerFile: unitPrice, files: monthly.files, updatesPerMonth: monthly.updatesPerMonth,
      billingOptions: monthly.billingOptions, maxTenureMonths: monthly.maxTenureMonths, allowOneTime: false, releaseMode: 'monthly' }
    : { pricingMode: 'fixed', monthlyReferencePrice: unitPrice, billingOptions: monthly.billingOptions, maxTenureMonths: monthly.maxTenureMonths };
  return { sellingPrice: 0, servicePlan };
}
function validateMonthly(raw, portalUploads, unitPrice) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Choose the monthly settings');
  if (!MONTHLY_PRICING.includes(raw.pricing)) fail('Choose a fixed monthly price or a price per file');
  const options = raw.billingOptions;
  if (!Array.isArray(options) || !options.length || options.length > 4) fail('Choose at least one billing cycle');
  const whole = value => (Number.isInteger(value) ? value : fail('Use whole numbers for the monthly settings'));
  const monthly = {
    pricing: raw.pricing,
    billingOptions: options.map(option => ({ billingCycle: option?.billingCycle, discountPercent: Number(option?.discountPercent || 0) })),
    maxTenureMonths: whole(raw.maxTenureMonths),
    ...(raw.pricing === 'per_file' ? {
      files: { min: whole(raw.files?.min), max: whole(raw.files?.max), step: whole(raw.files?.step ?? 1) },
      updatesPerMonth: { min: whole(raw.updatesPerMonth?.min), max: whole(raw.updatesPerMonth?.max) },
    } : {}),
  };
  if (monthly.pricing === 'per_file' && portalUploads !== true) fail('A price per file needs portal uploads');
  if (monthly.pricing === 'per_file' && monthly.files.max > MAX_PROJECT_FILES_PER_UPLOAD) fail(`Files per update can be at most ${MAX_PROJECT_FILES_PER_UPLOAD}`);
  // The plan's own config rules: unique cycles, discount 0–99, length 1–12, valid ranges.
  require('./servicePlanPricing').assertPricingConfig(monthlyPlanShape(monthly, unitPrice));
  return monthly;
}
function validatePurchase(raw) {
  const given = ['billing', 'portalUploads', 'paymentOptions', 'monthly'].filter(key => raw[key] !== undefined && raw[key] !== null);
  if (!given.length) return null;
  if (raw.billing === 'monthly') {
    if (typeof raw.portalUploads !== 'boolean') fail('Choose whether this package includes portal uploads');
    if (raw.paymentOptions !== undefined && raw.paymentOptions !== null) fail('A monthly package is paid per billing cycle, without payment options');
    if (Number(raw.offerExtraPrice || 0) !== 0) fail('A monthly package has no offer extras price');
    return { billing: 'monthly', portalUploads: raw.portalUploads, monthly: validateMonthly(raw.monthly, raw.portalUploads, raw.discountedPrice) };
  }
  if (raw.monthly !== undefined && raw.monthly !== null) fail('Monthly settings belong to a monthly package');
  if (given.length !== 3) fail('Choose the billing, portal uploads and payment options together');
  if (!PACKAGE_BILLING.includes(raw.billing)) fail('Choose how this package is billed');
  if (typeof raw.portalUploads !== 'boolean') fail('Choose whether this package includes portal uploads');
  const options = raw.paymentOptions;
  if (!Array.isArray(options) || !options.length || options.some(option => !PACKAGE_PAYMENT_OPTIONS.includes(option)) || new Set(options).size !== options.length) fail('Choose at least one payment option');
  return { billing: raw.billing, portalUploads: raw.portalUploads, paymentOptions: PACKAGE_PAYMENT_OPTIONS.filter(option => options.includes(option)) };
}
// A new package's permanent ID comes from its name (owner decision 7 Nov 2026): "Business Starter" →
// business-starter, then business-starter-2 while taken. Names without Latin letters get "package".
function packageIdBase(name) {
  const base = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, '');
  return base && safeId(base) ? base : 'package';
}
const packageIdCandidate = (base, taken) => {
  for (let n = 1; ; n++) { const id = n === 1 ? base : `${base}-${n}`; if (!taken.has(id)) return id; }
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
  // Website pages this package is shown on. Packages saved before pages existed have none.
  const pages = raw.pages ?? [];
  if (!Array.isArray(pages) || pages.length > 30 || pages.some(slug => !safeId(slug))) fail('Choose valid website pages');
  if (!Array.isArray(raw.linkedPlanIds) || raw.linkedPlanIds.length > 30 || raw.linkedPlanIds.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) fail('Choose valid service references');
  const regularPrice = amount(raw.regularPrice, 'main price');
  const discountedPrice = amount(raw.discountedPrice, 'discounted price');
  if (discountedPrice > regularPrice) fail('Discounted price cannot be more than the main price');
  const design = validateDesign(raw.design);
  const purchase = validatePurchase(raw);
  return {
    id: raw.id, name: cleanText(raw.name, 120, 'package name'), description: cleanText(raw.description, 500, 'description'),
    category: raw.category, status: raw.status, regularPrice, discountedPrice,
    offerExtraPrice: amount(raw.offerExtraPrice, 'offer extras price'), offerSlug: raw.offerSlug || '',
    inclusions: lines(raw.inclusions, 50, true), terms: lines(raw.terms, 50, false),
    linkedPlanIds: [...new Set(raw.linkedPlanIds)], order: raw.order, pages: [...new Set(pages)],
    ...(design ? { design } : {}),
    ...(purchase || {}),
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
  // Where a package is shown does not change its price or scope, so pages stay out of the
  // version key; moving a package between pages never invalidates an open project form.
  const { pages, design, ...priced } = item;
  // An offer's own quoteKey (website src/lib/offer-quote.ts) already signs everything commercial
  // about it and leaves out display/timing settings such as its reserve window, so the package
  // version follows that key, as service-plan quotes do (serviceOfferPolicy.js). An offer
  // without a key falls back to its full content.
  const signed = quote.offer?.quoteKey ? { ...quote, offer: quote.offer.quoteKey } : quote;
  const quoteKey = createHash('sha256').update(JSON.stringify({ item: priced, quote: signed })).digest('hex');
  return { ...item, quote, quoteKey };
}
// A monthly choice priced by the plan engine (servicePlanPricing.js quoteServicePlan) at one unit
// price: the package's monthly price or rate per file, with or without the offer.
function monthlyQuote(item, unitPrice, choice = {}) {
  const { quoteServicePlan } = require('./servicePlanPricing');
  const perFile = item.monthly.pricing === 'per_file';
  const quote = quoteServicePlan(monthlyPlanShape(item.monthly, unitPrice), {
    purchase: choice.billingCycle, tenureMonths: choice.tenureMonths,
    ...(perFile ? { files: choice.files, updates: choice.updates } : {}),
  });
  return { billingCycle: quote.purchase, cycleMonths: quote.cycleMonths, tenureMonths: quote.tenureMonths, totalCycles: quote.totalCycles,
    pricing: item.monthly.pricing, files: perFile ? quote.files : null, updatesPerMonth: perFile ? quote.updates : null,
    perMonthPrice: quote.perMonthPrice, discountPercent: quote.discountPercent, cyclePrice: quote.cyclePrice, totalPrice: quote.totalPrice };
}
// The one price of a customer's choice (package.md §3): the customize page, the package request and the
// project creation all ask this. One-time: a payment option and its installments (projectInstallments.js);
// monthly: the cycle, length and (per file) files and updates. `quoted` is quotePackage's answer, or a
// reservation's frozen-offer quote (projectPricing.js).
function quoteChoice(item, quoted, choice = {}) {
  if (!item.billing) fail('This package cannot be customized yet', 404);
  const offer = quoted.quote.offer ? { slug: quoted.quote.offer.slug, title: quoted.quote.offer.title, endsAt: quoted.quote.offer.endsAt } : null;
  const base = { packageId: item.id, quoteKey: quoted.quoteKey, billing: item.billing, offer };
  if (item.billing === 'monthly') {
    const charged = monthlyQuote(item, quoted.quote.finalPrice, choice);
    const regular = monthlyQuote(item, quoted.quote.regularPrice, choice);
    return { ...base, monthly: charged, regularPrice: regular.totalPrice, discountAmount: money(regular.totalPrice - charged.totalPrice),
      finalPrice: charged.totalPrice, dueNow: charged.cyclePrice, unitPrice: quoted.quote.finalPrice, regularUnitPrice: quoted.quote.regularPrice };
  }
  const option = choice.paymentOption;
  if (!item.paymentOptions.includes(option)) fail('Choose a way to pay that this package offers');
  const finalPrice = quoted.quote.finalPrice;
  const installments = INSTALLMENT_COUNT[option] ? buildInstallments(finalPrice, INSTALLMENT_COUNT[option])
    .map(({ installmentNumber, percentage, amount, progressThreshold }) => ({ installmentNumber, percentage, amount, progressThreshold })) : [];
  return { ...base, paymentOption: option, installments, regularPrice: quoted.quote.regularPrice, discountAmount: quoted.quote.discountAmount,
    finalPrice, dueNow: installments[0]?.amount ?? finalPrice };
}
const quotePackageChoice = (item, offers, choice, now = Date.now()) => quoteChoice(item, quotePackage(item, offers, now), choice);
async function catalogueWithQuotes(offers, admin = false) {
  const items = await readPackages();
  return items.filter(item => admin || item.status === 'published').map(item => quotePackage(item, offers));
}
async function savePackage(raw, creating, offers, packagePages = []) {
  // A new package without an ID gets one from its name; an ID is never typed or changed by the admin.
  const autoId = creating && (raw?.id === undefined || raw?.id === '');
  const item = validatePackage(autoId ? { ...raw, id: 'package' } : raw);
  if (item.pages.some(slug => !packagePages.some(page => page.slug === slug))) fail('A selected website page no longer exists. Refresh and try again.');
  const existing = await readPackages();
  // A draft's ID is reserved for it (helpers/packageDrafts.js), so an automatic ID skips those too.
  const draftIds = async () => (await Draft.find().select('packageId').lean()).map(row => row.packageId);
  if (autoId) item.id = packageIdCandidate(packageIdBase(item.name), new Set([...existing.map(row => row.id), ...await draftIds()]));
  if (creating && existing.some(row => row.id === item.id)) fail('This package ID already exists', 409);
  if (!creating && !existing.some(row => row.id === item.id)) fail('Package not found', 404);
  // package.md decision 15: a new package is published only with its purchase settings; once chosen
  // they are never dropped again (older packages simply have none until the admin chooses them).
  if (!item.billing && ((creating && item.status === 'published') || existing.find(row => row.id === item.id)?.billing)) {
    fail('Choose the billing, portal uploads and payment options for this package');
  }
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
  // The write only creates when the ID is still free; an automatic ID taken meanwhile moves to the next number.
  for (let attempt = 0; attempt < 20; attempt++) {
    const path = `packages.${item.id}`;
    const result = await Catalogue.updateOne({ _id: 'packages', ...(creating ? { [path]: { $exists: false } } : { [path]: { $exists: true } }) }, { $set: { [path]: item } });
    if (result.matchedCount) return item;
    if (!autoId) break;
    item.id = packageIdCandidate(packageIdBase(item.name), new Set([...(await readPackages()).map(row => row.id), ...await draftIds()]));
  }
  fail('Package changed; refresh the catalogue and try again', 409);
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
// A website page is being deleted: remove it from every package. The packages themselves stay.
async function unlinkPackagePage(slug) {
  if (!safeId(slug)) fail('Choose a valid website page');
  const changes = {};
  for (const item of await readPackages()) {
    if (item.pages?.includes(slug)) changes[`packages.${item.id}.pages`] = item.pages.filter(page => page !== slug);
  }
  if (Object.keys(changes).length) await Catalogue.updateOne({ _id: 'packages' }, { $set: changes });
  return Object.keys(changes).length;
}
module.exports = { money, fail, readPackages, validatePackage, validateDesign, packageIdBase, offerEligible, calculateBenefit, quotePackage, quoteChoice, quotePackageChoice, catalogueWithQuotes, savePackage, linkOfferPackages, unlinkPackagePage, INSTALLMENT_COUNT };
