const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const Catalogue = require('../models/salesCatalogueModel');
const Product = require('../models/productModel');
const Draft = require('../models/packageDraftModel');
const { KEY_PATTERN, getProjectCategory } = require('./projectCategories');
const { sellableFeatureFilter, featureLines } = require('./featureCatalogue');
const { MAX_PROJECT_FILES_PER_UPLOAD } = require('../config/uploadLimits');
const { buildInstallments, buildAdvanceInstallments } = require('./projectInstallments');

const safeId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80 && !['constructor', 'prototype', '__proto__'].includes(value);
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// Only packages created by an admin exist; there are no built-in defaults.
async function readPackages() {
  const row = await Catalogue.findById('packages').lean();
  return Object.values(row ? row.packages : {})
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}
// IDs are permanent identities: packages, working copies and deleted-package
// tombstones all reserve their link so customer history never points at a new
// package with an old ID.
async function reservedPackageIds() {
  const [packages, catalogue] = await Promise.all([readPackages(), Catalogue.findById('packages').select('retiredPackageIds').lean()]);
  return new Set([...packages.map(item => item.id), ...Object.keys(catalogue?.retiredPackageIds || {})]);
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
// Monthly packages (src/docs/monthlypackage.md) run as plans: priced by the plan engine's rules
// (servicePlanPricing.js) and sold as a plan order (packagePlanOrder.js). One fixed monthly price (no per
// file); billing cycles with a discount each; 1–12 months. With portal uploads the client gets
// `uploadsPerMonth` updates a month (null = unlimited); without, the team posts work updates.
// monthlyPlanShape is the one package → plan mapping; the quote, the order and the uploads all read it.
function monthlyPlanShape(item, unitPrice) {
  const monthly = item.monthly;
  const uploads = item.portalUploads === true;
  const count = uploads && Number.isInteger(monthly.uploadsPerMonth) ? monthly.uploadsPerMonth : null;
  const servicePlan = {
    pricingMode: 'fixed', purchaseType: 'recurring', monthlyReferencePrice: unitPrice,
    billingOptions: monthly.billingOptions, maxTenureMonths: monthly.maxTenureMonths,
    capability: uploads ? 'upload_data' : 'send_reminders', serviceBehavior: uploads ? 'portal_access_control' : 'reminder_only',
    dependency: 'standalone_only', timing: 'during',
    ...(uploads ? { filesLimit: MAX_PROJECT_FILES_PER_UPLOAD, limitScope: count ? 'per_month' : 'unlimited', portalAccessCount: count || undefined,
      releaseMode: count ? 'monthly' : 'all_at_once' } : {}),
  };
  return { _id: null, serviceName: item.name, sellingPrice: 0, servicePlan };
}
const MAX_UPLOADS_PER_MONTH = 31;
function validateMonthly(raw, portalUploads, unitPrice) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Choose the monthly settings');
  // Price per file is not sold as a package (owner decision 11 Nov 2026); plans keep it.
  if (raw.pricing !== undefined && raw.pricing !== 'fixed') fail('A monthly package has one fixed monthly price');
  const options = raw.billingOptions;
  if (!Array.isArray(options) || !options.length || options.length > 4) fail('Choose at least one billing cycle');
  const whole = value => (Number.isInteger(value) ? value : fail('Use whole numbers for the monthly settings'));
  const uploads = raw.uploadsPerMonth === undefined || raw.uploadsPerMonth === null ? null : whole(raw.uploadsPerMonth);
  if (uploads !== null && (!portalUploads || uploads < 1 || uploads > MAX_UPLOADS_PER_MONTH)) {
    fail(portalUploads ? `Updates a month are from 1 to ${MAX_UPLOADS_PER_MONTH}, or unlimited` : 'Updates a month belong to a package with portal uploads');
  }
  const monthly = {
    billingOptions: options.map(option => ({ billingCycle: option?.billingCycle, discountPercent: Number(option?.discountPercent || 0) })),
    maxTenureMonths: whole(raw.maxTenureMonths),
    uploadsPerMonth: uploads,
  };
  // The plan's own config rules: unique cycles, discount 0–99, length 1–12.
  require('./servicePlanPricing').assertPricingConfig(monthlyPlanShape({ name: 'package', portalUploads, monthly }, unitPrice));
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
// price: the package's monthly price, with or without the offer. `planQuote` is the engine's own
// answer, which the plan order is built from (packagePlanOrder.js).
function monthlyQuote(item, unitPrice, choice = {}) {
  const { quoteServicePlan } = require('./servicePlanPricing');
  const quote = quoteServicePlan(monthlyPlanShape(item, unitPrice), { purchase: choice.billingCycle, tenureMonths: choice.tenureMonths });
  return { billingCycle: quote.purchase, cycleMonths: quote.cycleMonths, tenureMonths: quote.tenureMonths, totalCycles: quote.totalCycles,
    uploadsPerMonth: item.portalUploads ? (item.monthly.uploadsPerMonth ?? null) : null,
    perMonthPrice: quote.perMonthPrice, discountPercent: quote.discountPercent, cyclePrice: quote.cyclePrice, totalPrice: quote.totalPrice,
    planQuote: quote };
}
// The one price of a customer's choice (package.md §3): the customize page, the package request and the
// project creation all ask this. One-time: a payment option and its installments (projectInstallments.js);
// monthly: the cycle and length. `quoted` is quotePackage's answer, or a
// reservation's frozen-offer quote (projectPricing.js).
function quoteChoice(item, quoted, choice = {}) {
  if (!item.billing) fail('This package cannot be customized yet', 404);
  const offer = quoted.quote.offer ? { slug: quoted.quote.offer.slug, title: quoted.quote.offer.title, endsAt: quoted.quote.offer.endsAt } : null;
  const base = { packageId: item.id, quoteKey: quoted.quoteKey, billing: item.billing, offer };
  if (item.billing === 'monthly') {
    if (quoted.quote.offer?.paymentPolicy?.minimumAdvance) fail('Advance token payment is only available for one-time project packages');
    const charged = monthlyQuote(item, quoted.quote.finalPrice, choice);
    const regular = monthlyQuote(item, quoted.quote.regularPrice, choice);
    return { ...base, monthly: charged, regularPrice: regular.totalPrice, discountAmount: money(regular.totalPrice - charged.totalPrice),
      finalPrice: charged.totalPrice, dueNow: charged.cyclePrice, unitPrice: quoted.quote.finalPrice, regularUnitPrice: quoted.quote.regularPrice };
  }
  const option = choice.paymentOption;
  if (!item.paymentOptions.includes(option)) fail('Choose a way to pay that this package offers');
  const finalPrice = quoted.quote.finalPrice;
  const minimumAdvance = require('./offerPaymentPolicy').minimumAdvanceAmount(quoted.quote.offer, finalPrice);
  let advance = null;
  let installments;
  if (minimumAdvance != null) {
    const rawAdvance = Number(choice.advanceAmount ?? minimumAdvance);
    const selected = money(rawAdvance);
    if (!Number.isFinite(rawAdvance) || Math.abs(rawAdvance * 100 - Math.round(rawAdvance * 100)) > 0.00001
      || selected < minimumAdvance || selected > finalPrice) fail(`Choose an advance from ₹${minimumAdvance} up to ₹${finalPrice}`);
    const count = option === 'installments_3' ? 3 : 2;
    installments = buildAdvanceInstallments(finalPrice, count, selected);
    advance = { minimum: minimumAdvance, selected, type: quoted.quote.offer.paymentPolicy.minimumAdvance.type,
      value: quoted.quote.offer.paymentPolicy.minimumAdvance.value };
  } else {
    installments = INSTALLMENT_COUNT[option] ? buildInstallments(finalPrice, INSTALLMENT_COUNT[option]) : [];
  }
  installments = installments.map(({ installmentNumber, percentage, amount, progressThreshold }) => ({ installmentNumber, percentage, amount, progressThreshold }));
  return { ...base, paymentOption: option, installments, regularPrice: quoted.quote.regularPrice, discountAmount: quoted.quote.discountAmount,
    finalPrice, dueNow: installments[0]?.amount ?? finalPrice, ...(advance ? { advance } : {}) };
}
const quotePackageChoice = (item, offers, choice, now = Date.now()) => quoteChoice(item, quotePackage(item, offers, now), choice);
async function catalogueWithQuotes(offers, admin = false) {
  const items = await readPackages();
  return items.filter(item => admin || item.status === 'published').map(item => quotePackage(item, offers));
}
// Packages priced from their category and add-ons (owner decision 10 Nov 2026). The main price is the
// category's base price plus the chosen add-ons, the same parts a custom project is built from
// (featureCatalogue.js is the one rule). It is frozen in `pricing` when the package is saved: a later
// change of the category or of an add-on never reaches a saved package. The client sends only which
// add-ons and how many; every price is read here, never taken from the request.
const MAX_PACKAGE_SERVICES = 40;
function parseServiceSelection(raw) {
  if (raw.services === undefined || raw.services === null) return undefined;
  if (!Array.isArray(raw.services) || raw.services.length > MAX_PACKAGE_SERVICES) fail(`Choose at most ${MAX_PACKAGE_SERVICES} add-on services`);
  const seen = new Set();
  return raw.services.map(row => {
    if (!row || typeof row.featureId !== 'string' || !/^[a-f\d]{24}$/i.test(row.featureId)) fail('Choose valid add-on services');
    if (seen.has(row.featureId)) fail('An add-on service is chosen twice');
    seen.add(row.featureId);
    const quantity = row.quantity === undefined ? 1 : row.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) fail('Feature quantity must be a whole number between 1 and 1000');
    return { featureId: row.featureId, quantity };
  });
}
// A saved service keeps the price it was saved with (only its quantity may change). A new one takes the
// current catalogue price. A different category, or an explicit refresh, takes every price afresh.
async function priceFromCatalogue({ category, selection, previous, refresh }) {
  const reuse = !!previous?.pricing && previous.category === category.category && !refresh;
  let categoryBasePrice;
  if (reuse) categoryBasePrice = previous.pricing.categoryBasePrice;
  else {
    if (category.basePrice === null || category.basePrice === undefined) fail('This category has no base price yet. Set its base price first.');
    categoryBasePrice = category.basePrice;
  }
  // The category's terms follow the same rule as its base price: a saved package keeps the terms it was saved with.
  const categoryTerms = reuse ? [...(previous.pricing.categoryTerms || [])] : [...(category.terms || [])];
  const frozen = new Map(reuse ? previous.pricing.services.map(row => [row.featureId, row]) : []);
  const wanted = selection.filter(row => !frozen.has(row.featureId));
  const docs = wanted.length ? await Product.find({ _id: { $in: wanted.map(row => row.featureId) }, ...sellableFeatureFilter(category.category) }).select('serviceName sellingPrice price isQuantityBased terms').lean() : [];
  const live = new Map(docs.map(doc => [String(doc._id), doc]));
  const services = selection.map(row => {
    // A service saved before add-on terms existed has no `terms` field; it gets none (no backfill, the price stays as saved).
    const kept = frozen.get(row.featureId);
    if (kept) return { featureId: row.featureId, name: kept.name, unitPrice: kept.unitPrice, isQuantityBased: !!kept.isQuantityBased, quantity: kept.isQuantityBased ? row.quantity : 1, terms: [...(kept.terms || [])] };
    const doc = live.get(row.featureId);
    if (!doc) {
      const old = previous?.pricing?.services?.find(service => service.featureId === row.featureId);
      fail(old ? `${old.name} is no longer offered; remove it` : 'An add-on service is unavailable for this category. Refresh the list.');
    }
    const [line] = featureLines([doc], { [row.featureId]: row.quantity });
    return { featureId: row.featureId, name: line.name, unitPrice: line.unitPrice, isQuantityBased: !!doc.isQuantityBased, quantity: line.quantity, terms: line.terms };
  });
  const total = money(categoryBasePrice + services.reduce((sum, row) => sum + money(row.unitPrice * row.quantity), 0));
  return { total, snapshot: { categoryBasePrice, categoryTerms, services } };
}
// The terms a package gets automatically from its category and add-ons (frozen in pricing), in order, without repeats.
const automaticTerms = (pricing) => pricing ? [...new Set([...(pricing.categoryTerms || []), ...pricing.services.flatMap(row => row.terms || [])])] : [];
// The included work shows how many of each quantity add-on the package has: its line ("Reels", or "N × Reels"
// with an older number) becomes "4 × Reels" from the saved quantity. The same line rule as the website form
// (src/lib/package-pricing.ts addOnLine / isAddOnLine). A line written differently is the admin's own and is
// left alone; no line is added. Invoices read `pricing`, not these lines.
const isAddOnLine = (line, name) => {
  const text = line.trim();
  const tail = ` × ${name}`;
  return text === name || (text.endsWith(tail) && /^\d+$/.test(text.slice(0, text.length - tail.length)));
};
const withAddOnNumbers = (inclusions, services) => inclusions.map(line => {
  const service = services.find(row => row.isQuantityBased && isAddOnLine(line, row.name));
  return service ? `${service.quantity} × ${service.name}` : line;
});
async function savePackage(raw, creating, offers, packagePages = []) {
  // A new package without an ID gets one from its name; an ID is never typed or changed by the admin.
  const autoId = creating && (raw?.id === undefined || raw?.id === '');
  const item = validatePackage(autoId ? { ...raw, id: 'package' } : raw);
  if (item.pages.some(slug => !packagePages.some(page => page.slug === slug))) fail('A selected website page no longer exists. Refresh and try again.');
  const existing = await readPackages();
  // A draft's ID is reserved for it (helpers/packageDrafts.js), so an automatic ID skips those too.
  const draftIds = async () => (await Draft.find().select('packageId').lean()).map(row => row.packageId);
  // A deleted package leaves a minimal tombstone behind. It is not catalogue
  // data, only an identity reservation for historical orders and requests.
  const retiredIds = async () => Object.keys((await Catalogue.findById('packages').select('retiredPackageIds').lean())?.retiredPackageIds || {});
  if (autoId) item.id = packageIdCandidate(packageIdBase(item.name), new Set([...existing.map(row => row.id), ...await draftIds(), ...await retiredIds()]));
  if (creating && existing.some(row => row.id === item.id)) fail('This package ID already exists', 409);
  if (creating && (await retiredIds()).includes(item.id)) fail('This package ID was retired and cannot be reused', 409);
  if (!creating && !existing.some(row => row.id === item.id)) fail('Package not found', 404);
  // package.md decision 15: a new package is published only with its purchase settings; once chosen
  // they are never dropped again (older packages simply have none until the admin chooses them).
  if (!item.billing && ((creating && item.status === 'published') || existing.find(row => row.id === item.id)?.billing)) {
    fail('Choose the billing, portal uploads and payment options for this package');
  }
  // An archived category keeps its old packages, but only an archived package may stay in it.
  const category = await getProjectCategory(item.category);
  if (!category || (category.status !== 'active' && item.status !== 'archived')) fail('Choose an active project category');
  // A package is priced either from its category and add-ons (above) or by hand (typed main and discount price),
  // chosen when it is made. A saved package keeps the way its price was set (owner decision 10 Nov 2026): neither way can
  // be switched on a saved package; a copy (Duplicate) can be made the other way. A monthly package works the same way
  // (owner decision 11 Nov 2026): its category + add-ons price is the price of one month.
  const selection = parseServiceSelection(raw);
  const previous = creating ? undefined : existing.find(row => row.id === item.id);
  if (selection !== undefined) {
    if (!item.billing) fail('Choose how this package is billed before pricing it from its category and add-ons');
    if (previous && !previous.pricing) fail('This package was priced by hand and keeps it. Duplicate it to price a copy from its category and add-ons.');
    const priced = await priceFromCatalogue({ category, selection, previous, refresh: raw.repriceFromCurrent === true });
    if (money(item.regularPrice) !== priced.total) fail('The main price changed. Review the current category and add-on prices.', 409);
    // The admin's own lines are kept; lines this package got automatically last time are dropped first, so an add-on
    // that was removed leaves no terms behind, then the automatic terms of the current selection are added.
    const typed = item.terms.filter(line => !automaticTerms(previous?.pricing).includes(line));
    item.pricing = priced.snapshot;
    item.terms = [...new Set([...typed, ...automaticTerms(item.pricing)])];
    item.inclusions = withAddOnNumbers(item.inclusions, item.pricing.services);
    if (item.terms.length > 50) fail('The package terms are more than 50 lines. Shorten them or remove an add-on.');
  } else if (previous?.pricing) {
    fail('This package is priced from its category and add-ons and keeps it. Send its services, or duplicate it to make a copy with typed prices.');
  }
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
    item.id = packageIdCandidate(packageIdBase(item.name), new Set([...(await readPackages()).map(row => row.id), ...await draftIds(), ...await retiredIds()]));
  }
  fail('Package changed; refresh the catalogue and try again', 409);
}

// Permanent deletion removes a future catalogue package in any state. Customer orders, invoices,
// reservations and start requests hold their own immutable snapshots and are
// never read or changed here.
async function deletePackage(id) {
  if (!safeId(id)) fail('Choose a valid package');
  const path = `packages.${id}`;
  let deleted = null;
  await mongoose.connection.transaction(async session => {
    const catalogue = await Catalogue.findOne({ _id: 'packages', [path]: { $exists: true } })
      .select({ [path]: 1 }).session(session).lean();
    if (!catalogue) fail('Package not found', 404);
    deleted = catalogue.packages[id];
    const result = await Catalogue.updateOne(
      { _id: 'packages', [path]: { $exists: true } },
      { $set: { [`retiredPackageIds.${id}`]: { deletedAt: new Date() } }, $unset: { [path]: '' } },
      { session },
    );
    if (result.modifiedCount !== 1) fail('Package changed; refresh the catalogue and try again', 409);
    await Draft.deleteOne({ packageId: id }, { session });
  });
  return { id, name: deleted.name };
}

// The list-level Publish/Archive controls never accept a package object from
// the browser. They re-use the normal save validation with the latest
// catalogue row, so a stale list cannot overwrite a package edit.
async function transitionPackageStatus(id, status, offers, packagePages = []) {
  if (!safeId(id)) fail('Choose a valid package');
  if (!['published', 'archived'].includes(status)) fail('Choose whether to publish or archive the package');
  if (await Draft.exists({ packageId: id })) fail('This package has a draft in progress. Continue or discard the draft first.', 409);
  const current = (await readPackages()).find(item => item.id === id);
  if (!current) fail('Package not found', 404);
  if (current.status === status) return current;
  if (status === 'archived') {
    const running = offers.find(offer => offer.status === 'published' && Date.parse(offer.endsAt) > Date.now()
      && (offer.packageId === id || (!!current.offerSlug && offer.slug === current.offerSlug)));
    if (running) fail(`End the running offer "${running.title}" before archiving this package.`, 409);
    const path = `packages.${id}`;
    const result = await Catalogue.updateOne({ _id: 'packages', [path]: { $exists: true } }, { $set: { [`${path}.status`]: 'archived', [`${path}.offerSlug`]: '' } });
    if (result.modifiedCount !== 1) fail('Package changed; refresh the catalogue and try again', 409);
    return { ...current, status: 'archived', offerSlug: '' };
  }
  // savePackage owns every sellability check. Restore the editor-only service
  // selection from its frozen snapshot before handing the current row to it.
  const raw = current.pricing ? { ...current, services: current.pricing.services.map(row => ({ featureId: row.featureId, quantity: row.quantity })) } : current;
  return savePackage({ ...raw, status }, false, offers, packagePages);
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
module.exports = { money, fail, readPackages, reservedPackageIds, monthlyPlanShape, validatePackage, validateDesign, packageIdBase, offerEligible, calculateBenefit, quotePackage, quoteChoice, quotePackageChoice, catalogueWithQuotes, savePackage, deletePackage, transitionPackageStatus, linkOfferPackages, unlinkPackagePage, INSTALLMENT_COUNT };
