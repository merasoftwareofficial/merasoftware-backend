// SSOT for saving a service plan to the catalogue (merasoftware/src/docs/plan.md §2 "Plan rules"):
// the website admin plan form (PATCH /api/admin/plan-catalogue) and the older portal create page
// (POST /api/admin/services/create) both save through savePlan(), so a plan has one set of rules.
// The generic /update-product route refuses service plans (updateProduct.js).
//
// Only the whitelisted fields below are read from the request; nothing is spread into the plan.
// Prices are worked out by helpers/servicePlanPricing.js. A saved edit never changes what a
// customer already bought: every order keeps its own snapshot (servicePlanPurchase.js).
const Product = require('../models/productModel');
const { saveRevision } = require('./catalogueRevision');
const { listProjectCategories } = require('./projectCategories');
const { MAX_SERVICE_FILES_PER_UPLOAD } = require('../config/uploadLimits');
const { requireActivePlanCategory, listPlanCategories, planCategoryUsage } = require('./planCategories');
const { CYCLE_MONTHS, assertPricingConfig, cyclePriceFromMonthly, priceRange, rupees } = require('./servicePlanPricing');
const { assertCanBeOnSale, canBeOnSale } = require('./servicePlanLifecycle');

const PLAN_TYPES = ['website_updates', 'digital_marketing', 'google_business_setup', 'social_media_marketing', 'other'];
const LIMIT_SCOPES = ['per_day', 'per_week', 'per_month', 'per_quarter', 'per_6_month', 'per_year', 'per_plan', 'unlimited', 'manual'];
const SERVICE_TIMINGS = ['during', 'during_and_after', 'after'];
const SERVICE_DEPENDENCIES = ['project_required', 'standalone_or_project', 'standalone_only'];
const SERVICE_CAPABILITIES = ['upload_data', 'send_reminders'];
const PURCHASE_TYPES = ['one_time', 'recurring'];

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const given = (value) => value !== undefined && value !== null && value !== '';
const wholeOrUndefined = (value, label) => {
  if (!given(value)) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) fail(`${label} must be a whole number of at least 1`);
  return number;
};

const range = (value, label) => {
  if (!value || typeof value !== 'object') fail(`Enter ${label}`);
  return { min: Number(value.min), max: Number(value.max), ...(value.step !== undefined ? { step: Number(value.step) } : {}) };
};

// Billing options: cycle + discount only; the stored pricePerCycle (read by the pre-quote purchase
// path) is derived here for fixed plans and left out for flexible ones, whose price depends on
// the customer's choices.
const billingOptionsFrom = (options, monthlyPrice) => {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    const billingCycle = option?.billingCycle;
    const discountPercent = Number(option?.discountPercent || 0);
    if (!CYCLE_MONTHS[billingCycle]) fail('Each billing option must be monthly, quarterly, 6 months or yearly');
    return monthlyPrice === null
      ? { billingCycle, discountPercent }
      : { billingCycle, discountPercent, pricePerCycle: cyclePriceFromMonthly(monthlyPrice, CYCLE_MONTHS[billingCycle], discountPercent) };
  });
};

// Older settings this module does not edit; an edit keeps them as they were.
const KEPT_LEGACY_FIELDS = ['validityUnit', 'validityValue', 'validityInDays', 'billingCycle', 'totalBillingCycles', 'manualUnit', 'manualCount'];

// Turns a request body into the plan fields to store. Throws (400) on anything invalid.
async function planFieldsFrom(body, existing, { requireCategory }) {
  const serviceName = body.serviceName;
  if (typeof serviceName !== 'string' || !serviceName.trim() || serviceName.trim().length > 120) fail('Service name is required');

  const planType = given(body.planType) ? body.planType : (existing?.servicePlan?.planType || 'other');
  if (!PLAN_TYPES.includes(planType)) fail('A valid service type is required');
  const { dependency, capability, purchaseType } = body;
  if (!SERVICE_DEPENDENCIES.includes(dependency)) fail('A valid project dependency is required');
  const timing = given(body.timing) ? body.timing : undefined;
  if (dependency !== 'standalone_only' && !SERVICE_TIMINGS.includes(timing)) fail('A valid service availability is required');
  if (dependency === 'standalone_only' && timing) fail('Standalone-only services cannot use a project availability setting');
  if (!SERVICE_CAPABILITIES.includes(capability)) fail('Select whether the service provides upload data or reminders');

  // The website plan form requires a category. An edit may keep a category archived since, but a
  // change must pick an active one. The older portal create page has no category field.
  let categoryKey = existing?.servicePlan?.categoryKey;
  if (given(body.categoryKey) && body.categoryKey !== categoryKey) categoryKey = (await requireActivePlanCategory(body.categoryKey)).key;
  if (!categoryKey && requireCategory) fail('Choose a plan category');

  const pricingMode = body.pricingMode === 'flexible' ? 'flexible' : 'fixed';
  const isUpload = capability === 'upload_data';
  const common = {
    planType,
    timing,
    dependency,
    capability,
    categoryKey,
    pricingMode,
    // Kept for the readers that still use it (uploadOrderPolicy.js).
    serviceBehavior: isUpload ? 'portal_access_control' : 'reminder_only',
    oneTimeValidityDays: wholeOrUndefined(body.oneTimeValidityDays, 'One-time validity'),
    maxTenureMonths: wholeOrUndefined(body.maxTenureMonths, 'Maximum length'),
    releaseMode: given(body.releaseMode) ? body.releaseMode : undefined,
    customerCanChooseRelease: body.customerCanChooseRelease === true,
  };

  let servicePlan;
  let entryPrice;
  if (pricingMode === 'flexible') {
    servicePlan = {
      ...common,
      // A flexible plan offers one-time when allowed and recurring when it has billing options.
      purchaseType: Array.isArray(body.billingOptions) && body.billingOptions.length ? 'recurring' : 'one_time',
      files: range(body.files, 'files per update'),
      ratePerFile: Number(body.ratePerFile),
      slabs: Array.isArray(body.slabs) ? body.slabs.map((slab) => ({ fromFile: Number(slab?.fromFile), ratePerFile: Number(slab?.ratePerFile) })) : [],
      updatesPerMonth: range(body.updatesPerMonth, 'updates per month'),
      allowOneTime: body.allowOneTime === true,
      billingOptions: billingOptionsFrom(body.billingOptions, null),
      limitScope: 'per_month',
    };
  } else {
    if (!PURCHASE_TYPES.includes(purchaseType)) fail('Select whether this is a one-time or recurring service');
    const oneTime = purchaseType === 'one_time';
    let monthlyReferencePrice;
    if (oneTime) {
      if (!(Number(body.oneTimePrice) > 0)) fail('One-time price must be greater than zero');
      if (Array.isArray(body.billingOptions) && body.billingOptions.length) fail('A one-time service cannot have recurring billing options');
      entryPrice = rupees(body.oneTimePrice);
    } else {
      if (given(body.oneTimePrice)) fail('A recurring service cannot define a one-time price');
      if (!given(body.monthlyReferencePrice) || !(Number(body.monthlyReferencePrice) >= 0)) fail('Monthly reference price must be zero or more');
      if (!Array.isArray(body.billingOptions) || !body.billingOptions.length) fail('Enable at least one customer billing option');
      monthlyReferencePrice = rupees(body.monthlyReferencePrice);
    }
    const billingOptions = oneTime ? [] : billingOptionsFrom(body.billingOptions, monthlyReferencePrice);
    let limits = {};
    if (isUpload) {
      if (!LIMIT_SCOPES.includes(body.limitScope)) fail('A valid upload access limit is required');
      if (body.limitScope === 'unlimited' && given(body.portalAccessCount)) fail('Upload attempts must be empty for unlimited access');
      if (body.limitScope !== 'unlimited' && !(Number(body.portalAccessCount) >= 1)) fail('Upload attempts must be at least 1');
      if (!(Number(body.filesLimit) >= 1) || Number(body.filesLimit) > MAX_SERVICE_FILES_PER_UPLOAD) fail(`Files per upload must be between 1 and ${MAX_SERVICE_FILES_PER_UPLOAD}`);
      limits = {
        limitScope: body.limitScope,
        portalAccessCount: body.limitScope === 'unlimited' ? undefined : Number(body.portalAccessCount),
        filesLimit: Number(body.filesLimit),
      };
    } else if (given(body.limitScope) || given(body.portalAccessCount) || given(body.filesLimit)) {
      fail('Reminder services cannot define upload limits');
    }
    servicePlan = { ...common, purchaseType, monthlyReferencePrice, billingOptions, ...limits };
  }
  KEPT_LEGACY_FIELDS.forEach((key) => {
    if (existing?.servicePlan?.[key] !== undefined && existing.servicePlan[key] !== null) servicePlan[key] = existing.servicePlan[key];
  });

  const draft = { price: entryPrice, sellingPrice: entryPrice, servicePlan };
  assertPricingConfig(draft);
  // Listing components read the generic product price: the lowest price a customer can pay to start.
  const range0 = priceRange(draft);
  const listPrice = range0.unit === 'month' ? (servicePlan.billingOptions[0]?.pricePerCycle ?? range0.from) : range0.from;

  const fields = {
    serviceName: serviceName.trim(),
    servicePlan,
    price: listPrice,
    sellingPrice: listPrice,
    formattedDescriptions: given(body.description) ? [{ content: String(body.description) }] : [],
  };
  if (typeof body.isHidden === 'boolean') fields.isHidden = body.isHidden;
  else if (body.visibility !== undefined) fields.isHidden = body.visibility === 'hidden';
  return fields;
}

// Create (creating === true) or replace the editable settings of an existing plan (planId).
async function savePlan(body = {}, { requireCategory = true } = {}) {
  const creating = body.creating === true;
  let existing = null;
  if (!creating) {
    existing = given(body.planId) ? await Product.findById(body.planId).catch(() => null) : null;
    if (!existing || !existing.isServicePlan || existing.category !== 'service_plan') fail('Plan not found', 404);
    if (existing.retiredAt) fail('A retired plan cannot be edited. Restore it first.');
  }
  const fields = await planFieldsFrom(body, existing, { requireCategory });
  const hidden = typeof fields.isHidden === 'boolean' ? fields.isHidden : Boolean(existing?.isHidden);
  if (!hidden) assertCanBeOnSale({ isServicePlan: true, servicePlan: fields.servicePlan });
  if (creating) {
    const created = await Product.create({ ...fields, category: 'service_plan', isServicePlan: true, isHidden: fields.isHidden === true });
    return created.toObject();
  }
  existing.set(fields);
  await saveRevision(existing, body.expectedUpdatedAt);
  return existing.toObject();
}

// Admin catalogue: every service plan (retired ones flagged) with its card price, plus categories.
async function listPlanCatalogue() {
  const [plans, categories, projectCategories, usage] = await Promise.all([
    Product.find({ category: 'service_plan', isServicePlan: true, archivedAt: null }).sort({ createdAt: -1 }).lean(),
    listPlanCategories(),
    listProjectCategories(),
    planCategoryUsage(),
  ]);
  return {
    plans: plans.map((plan) => ({
      _id: plan._id,
      serviceName: plan.serviceName,
      description: plan.formattedDescriptions?.[0]?.content || '',
      isHidden: Boolean(plan.isHidden),
      retired: Boolean(plan.retiredAt),
      canBeOnSale: canBeOnSale(plan),
      price: plan.price,
      servicePlan: plan.servicePlan,
      priceRange: (() => { try { return priceRange(plan); } catch { return null; } })(),
      updatedAt: plan.updatedAt,
    })),
    categories: categories.map(category => ({ ...category, usage: { plans: usage[category.key] || 0 } })),
    projectCategories: projectCategories.map(({ category, label, status }) => ({ category, label, status })),
  };
}

// The plan as the admin form would save it, without saving (admin price preview). Same rules as
// savePlan(); a category is not needed to see a price.
async function previewPlan(settings = {}) {
  const existing = given(settings.planId) ? await Product.findOne({ _id: settings.planId, isServicePlan: true }).lean().catch(() => null) : null;
  const name = typeof settings.serviceName === 'string' && settings.serviceName.trim() ? settings.serviceName : 'Preview';
  const fields = await planFieldsFrom({ ...settings, serviceName: name }, existing, { requireCategory: false });
  return { _id: existing?._id || 'preview', serviceName: fields.serviceName, price: fields.price, sellingPrice: fields.sellingPrice, servicePlan: fields.servicePlan };
}

module.exports = { savePlan, listPlanCatalogue, previewPlan };
