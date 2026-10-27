const productModel = require("../../models/productModel");
const { MAX_SERVICE_FILES_PER_UPLOAD } = require('../../config/uploadLimits');
const { cyclePriceFromMonthly } = require('../../helpers/servicePlanPricing');

const PLAN_TYPES = ['website_updates', 'digital_marketing', 'google_business_setup', 'social_media_marketing', 'other'];
const LIMIT_SCOPES = ['per_day', 'per_week', 'per_month', 'per_quarter', 'per_6_month', 'per_year', 'per_plan', 'unlimited', 'manual'];
const SERVICE_TIMINGS = ['during', 'during_and_after', 'after'];
const SERVICE_DEPENDENCIES = ['project_required', 'standalone_or_project', 'standalone_only'];
const SERVICE_CAPABILITIES = ['upload_data', 'send_reminders'];
const PURCHASE_TYPES = ['one_time', 'recurring'];
const CATALOGUE_BILLING_CYCLES = [
  'monthly', 'quarterly', 'half_yearly', 'yearly',
  'every_2_years', 'every_3_years', 'every_4_years', 'every_5_years'
];
const CATALOGUE_BILLING_MONTHS = {
  monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12,
  every_2_years: 24, every_3_years: 36, every_4_years: 48, every_5_years: 60,
};

const createServicePlanController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const body = req.body || {};

    // Explicit whitelist — never spread req.body directly, and never allow
    // the legacy plan-type booleans/fields to be set through this endpoint.
    const serviceName = body.serviceName;
    const planType = body.planType;
    const timing = body.timing;
    const dependency = body.dependency;
    const capability = body.capability;
    const purchaseType = body.purchaseType;
    const monthlyReferencePrice = body.monthlyReferencePrice;
    const oneTimePrice = body.oneTimePrice;
    const billingOptions = body.billingOptions;
    const limitScope = body.limitScope;
    const portalAccessCount = body.portalAccessCount;
    const filesLimit = body.filesLimit;
    const description = body.description;
    const visibility = body.visibility;

    if (!serviceName || typeof serviceName !== 'string' || !serviceName.trim()) {
      throw new Error("Service name is required");
    }
    if (!PLAN_TYPES.includes(planType)) {
      throw new Error("A valid service type is required");
    }

    if (!SERVICE_DEPENDENCIES.includes(dependency)) {
      throw new Error("A valid project dependency is required");
    }
    if (dependency !== 'standalone_only' && !SERVICE_TIMINGS.includes(timing)) {
      throw new Error("A valid service availability is required");
    }
    if (dependency === 'standalone_only' && timing) {
      throw new Error("Standalone-only services cannot use a project availability setting");
    }
    if (!SERVICE_CAPABILITIES.includes(capability)) {
      throw new Error("Select whether the service provides upload data or reminders");
    }
    if (!PURCHASE_TYPES.includes(purchaseType)) {
      throw new Error("Select whether this is a one-time or recurring service");
    }

    const isOneTimeService = purchaseType === 'one_time';
    let normalizedBillingOptions = [];
    let cataloguePrice;

    if (isOneTimeService) {
      if (!Number.isFinite(Number(oneTimePrice)) || Number(oneTimePrice) <= 0) {
        throw new Error("One-time price must be greater than zero");
      }
      if (Array.isArray(billingOptions) && billingOptions.length) {
        throw new Error("A one-time service cannot have recurring billing options");
      }
      cataloguePrice = Number(oneTimePrice);
    } else {
      if (oneTimePrice !== undefined && oneTimePrice !== null && oneTimePrice !== '') {
        throw new Error("A recurring service cannot define a one-time price");
      }
      if (monthlyReferencePrice === undefined || monthlyReferencePrice === null || monthlyReferencePrice === '' || Number(monthlyReferencePrice) < 0) {
        throw new Error("Monthly reference price must be zero or more");
      }
      if (!Array.isArray(billingOptions) || billingOptions.length === 0) {
        throw new Error("Enable at least one customer billing option");
      }

      const seenBillingCycles = new Set();
      normalizedBillingOptions = billingOptions.map((option) => {
        const billingCycleOption = option?.billingCycle;
        const discountPercent = Number(option?.discountPercent);
        if (!CATALOGUE_BILLING_CYCLES.includes(billingCycleOption) || seenBillingCycles.has(billingCycleOption)) {
          throw new Error("Each billing option must be valid and unique");
        }
        if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
          throw new Error("Billing-option discount must be between 0 and 100");
        }
        seenBillingCycles.add(billingCycleOption);
        // Whole rupees, from the pricing SSOT (an unrounded 16449.600000000002 was stored before).
        const pricePerCycle = cyclePriceFromMonthly(monthlyReferencePrice, CATALOGUE_BILLING_MONTHS[billingCycleOption], discountPercent);
        return { billingCycle: billingCycleOption, discountPercent, pricePerCycle };
      });
      cataloguePrice = normalizedBillingOptions[0].pricePerCycle;
    }

    const isUploadService = capability === 'upload_data';
    if (isUploadService) {
      if (!LIMIT_SCOPES.includes(limitScope)) throw new Error("A valid upload access limit is required");
      if (limitScope === 'unlimited') {
        if (portalAccessCount) throw new Error("Upload attempts must be empty for unlimited access");
      } else if (!(Number(portalAccessCount) >= 1)) {
        throw new Error("Upload attempts must be at least 1");
      }
      if (!(Number(filesLimit) >= 1) || Number(filesLimit) > MAX_SERVICE_FILES_PER_UPLOAD) {
        throw new Error(`Files per upload must be between 1 and ${MAX_SERVICE_FILES_PER_UPLOAD}`);
      }
    } else if (limitScope || portalAccessCount || filesLimit) {
      throw new Error("Reminder services cannot define upload limits");
    }

    const newPlan = new productModel({
      serviceName: serviceName.trim(),
      category: "service_plan",
      isServicePlan: true,
      servicePlan: {
        planType,
        timing: timing || undefined,
        dependency,
        capability,
        purchaseType,
          // Legacy field remains populated deliberately for existing readers
          // until their lifecycle paths are migrated in the next phases.
        serviceBehavior: isUploadService ? 'portal_access_control' : 'reminder_only',
        limitScope: isUploadService ? limitScope : undefined,
        portalAccessCount: isUploadService && limitScope !== 'unlimited' ? Number(portalAccessCount) : undefined,
        filesLimit: isUploadService ? Number(filesLimit) : undefined,
        monthlyReferencePrice: isOneTimeService ? undefined : Number(monthlyReferencePrice),
        billingOptions: normalizedBillingOptions,
      },
        // Listing components still use these generic product prices. The first
        // enabled option provides a truthful entry price until Phase 2 adds the
        // customer's option selector.
      price: cataloguePrice,
      sellingPrice: cataloguePrice,
      formattedDescriptions: description ? [{ content: description }] : [],
      isHidden: visibility === 'hidden',
    });
    const savedPlan = await newPlan.save();
    return res.status(201).json({ message: "Service created successfully", error: false, success: true, data: savedPlan });
  } catch (error) {
    return res.status(400).json({
      message: error.message || "Failed to create service",
      error: true,
      success: false,
    });
  }
};

module.exports = createServicePlanController;
