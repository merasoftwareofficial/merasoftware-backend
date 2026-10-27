const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    serviceName: String,
    category: String,
    startingNodeTitle: String,
    packageIncludes: [String],
    perfectFor: [{
      text: {
        type: String,
        required: true
      },
      icon: {
        type: String,
        required: true
      }
    }],
    serviceImage: [],
    price: Number,
    sellingPrice: Number,
    formattedDescriptions: [{
      content: {
          type: String,
          required: true
      }
  }],
    
    // Website service fields
    isWebsiteService: {
      type: Boolean,
      default: false
    },
    totalPages: {
      type: Number,
      min: 4,  // Minimum 4 pages (fixed pages)
      max: 50, // Maximum changed to 50 pages
      validate: {
        validator: function(value) {
          return !this.isWebsiteService || (value >= 4 && value <= 50);
        },
        message: 'Website services must have between 4 and 50 pages'
      }
    },
    isFeatureUpgrade: {
      type: Boolean,
      default: false
    },
    
    
    compatibleWith : [String],
    keyBenefits : [String],
    isWebsiteUpdate: {
      type: Boolean,
      default: false
  },
  validityPeriod: {
    type: Number,  // Now storing in days instead of months
    validate: {
      validator: function(value) {
        if (!this.isWebsiteUpdate) return true;
        // Value must be positive and not exceed 365 days (1 year)
        return value > 0 && value <= 365;
      },
      message: 'Website update services must have a valid period between 1 and 365 days'
    }
  },
  updateCount: {
    type: Number,  // Store in months
    validate: {
        validator: function(value) {
            return !this.isWebsiteUpdate || (value > 0);
        },
        message: 'Update count must be greater than 0'
    }
},
  // New fields for yearly renewable plans
  isMonthlyRenewablePlan: {
    type: Boolean,
    default: false
  },
  yearlyPlanDuration: {
    type: Number,  // Total plan duration in days (365)
    validate: {
      validator: function(value) {
        if (!this.isMonthlyRenewablePlan) return true;
        return value > 0 && value <= 365;
      },
      message: 'Yearly plan duration must be between 1 and 365 days'
    }
  },
  monthlyRenewalCost: {
    type: Number,  // Cost for monthly renewal (₹8000)
    validate: {
      validator: function(value) {
        if (!this.isMonthlyRenewablePlan) return true;
        return value > 0;
      },
      message: 'Monthly renewal cost must be greater than 0'
    }
  },
  isUnlimitedUpdates: {
    type: Boolean,
    default: false
  },
  // New fields for monthly limited yearly plans
  isMonthlyLimitedPlan: {
    type: Boolean,
    default: false
  },
  monthlyUpdateLimit: {
    type: Number,  // Updates allowed per month (e.g., 1)
    default: 1,
    validate: {
      validator: function(value) {
        if (!this.isMonthlyLimitedPlan) return true;
        return value > 0;
      },
      message: 'Monthly update limit must be greater than 0'
    }
  },
  monthlyRenewalPrice: {
    type: Number,  // Monthly renewal cost (e.g., ₹3000)
    validate: {
      validator: function(value) {
        if (!this.isMonthlyLimitedPlan) return true;
        return value > 0;
      },
      message: 'Monthly renewal price must be greater than 0'
    }
  },
    additionalFeatures: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'product'  // References the same Product model
  }],
  isHidden: {
    type: Boolean,
    default: false
  },
  // Feature capability (category: feature_upgrades). Decided by the admin in the
  // Features form, never inferred from serviceName — the name is only a label for
  // the admin list and the invoice.
  //
  //   false -> single feature: selected once, charged at its own price.
  //   true  -> quantity-based: the project form shows a +/- counter and the
  //            feature is charged sellingPrice x quantity.
  //
  // Which categories a feature is offered for is carried by the existing
  // compatibleWith[] above, where an EMPTY array means "all categories".
  isQuantityBased: {
    type: Boolean,
    default: false
  },
  // Retirement — permanent, unlike isHidden.
  //
  //   isHidden  = temporarily off sale; still listed for the admin.
  //   retiredAt = withdrawn for good; hidden from the admin list too.
  //
  // A plan that customers have already bought must never be hard-deleted: the
  // order keeps its own frozen copy of what was purchased, but the catalog row is
  // still the business record behind those invoices. Retiring keeps it forever
  // (restorable via reactivate) instead of Trash, which purges after 30 days.
  retiredAt: {
    type: Date,
    default: null
  },
  retiredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    default: null
  },
  // "Delete Forever" from the Retired tab. The row is kept (orders, invoices and
  // transactions still reference it) but disappears from every list, including the
  // Retired tab — so it reads as a permanent delete while remaining recoverable in
  // the database. A truly irreversible removal is a separate, explicitly-confirmed
  // admin action (see retireOrDeletePlan.js / purgePlan.js).
  archivedAt: {
    type: Date,
    default: null
  },
  archivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    default: null
  },
  isCustomClientProject: {
    type: Boolean,
    default: false
  },
  clientProjectFeatures: [{
    featureId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'product'
    },
    name: String,
    price: Number
  }],

  // ---------------------------------------------------------------------
  // Service Plan System (new, additive). Coexists with the legacy plan
  // fields above — legacy fields/logic are untouched. isServicePlan is the
  // switch every enforcement/read path checks to pick the new vs old path.
  // ---------------------------------------------------------------------
  isServicePlan: {
    type: Boolean,
    default: false
  },
  servicePlan: {
    planType: {
      type: String,
      enum: ['website_updates', 'digital_marketing', 'google_business_setup', 'social_media_marketing', 'other']
    },
    limitScope: {
      type: String,
      enum: ['per_day', 'per_week', 'per_month', 'per_quarter', 'per_6_month', 'per_year', 'per_plan', 'unlimited', 'manual']
    },
    manualUnit: {
      type: String,
      enum: ['day', 'week', 'month']
    },
    manualCount: {
      type: Number,
      min: 1
    },
    portalAccessCount: {
      type: Number,
      min: 1
    },
    filesLimit: {
      type: Number,
      min: 1
    },
    validityUnit: {
      type: String,
      enum: ['day', 'week', 'month', 'year']
    },
    validityValue: {
      type: Number,
      min: 1
    },
    validityInDays: {
      type: Number,
      min: 1
    },
    billingCycle: {
      type: String,
      enum: [
        'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly',
        // Multi-year cadences: a service may be charged once every N years
        // (e.g. a 5-year hosting/domain renewal billed once every 2 years).
        'every_2_years', 'every_3_years', 'every_4_years', 'every_5_years'
      ]
    },
    // Empty billingCycle + totalBillingCycles means no automatic expiry.
    totalBillingCycles: {
      type: Number,
      min: 1
    },
    // What this service actually does at runtime. Set explicitly instead of
    // being inferred from whether portalAccessCount is present, so the future
    // enforcement engine never has to guess:
    //   portal_access_control -> consumes portal access/file-upload allowance
    //   reminder_only         -> no allowance; only tracks duration + reminders
    serviceBehavior: {
      type: String,
      enum: ['portal_access_control', 'reminder_only']
    },
    // Catalogue contract for the add-on service lifecycle. These fields are
    // additive: serviceBehavior and the legacy billing fields above remain so
    // existing catalogue records/orders retain their original meaning.
    timing: {
      type: String,
      enum: ['during', 'during_and_after', 'after']
    },
    dependency: {
      type: String,
      enum: ['project_required', 'standalone_or_project', 'standalone_only']
    },
    capability: {
      type: String,
      enum: ['upload_data', 'send_reminders']
    },
    purchaseType: {
      type: String,
      enum: ['one_time', 'recurring']
    },
    monthlyReferencePrice: {
      type: Number,
      min: 0
    },
    billingOptions: [{
      billingCycle: {
        type: String,
        enum: [
          'monthly', 'quarterly', 'half_yearly', 'yearly',
          'every_2_years', 'every_3_years', 'every_4_years', 'every_5_years'
        ]
      },
      discountPercent: {
        type: Number,
        min: 0,
        max: 100,
        default: 0
      },
      pricePerCycle: {
        type: Number,
        min: 0
      }
    }],
    // ── Flexible Plans (merasoftware/src/docs/plan.md §4) ──
    // All optional: a plan saved before these existed is read as pricingMode 'fixed' by
    // helpers/servicePlanPricing.js, which is the only place a price is worked out.
    categoryKey: String, // helpers/planCategories.js key
    pricingMode: {
      type: String,
      enum: ['fixed', 'flexible']
    },
    // Flexible only: the customer picks files per update in this range.
    files: {
      min: { type: Number, min: 1 },
      max: { type: Number, min: 1 },
      step: { type: Number, min: 1 }
    },
    // Flexible only: price of each file from file 1, then cheaper slabs from `fromFile` on.
    ratePerFile: {
      type: Number,
      min: 0
    },
    slabs: [{
      fromFile: { type: Number, min: 2 },
      ratePerFile: { type: Number, min: 0 }
    }],
    // Flexible only: updates per month (recurring) or number of updates (one-time).
    updatesPerMonth: {
      min: { type: Number, min: 1 },
      max: { type: Number, min: 1 }
    },
    allowOneTime: Boolean,
    oneTimeValidityDays: {
      type: Number,
      min: 1
    },
    maxTenureMonths: {
      type: Number,
      min: 1,
      max: 12
    },
    releaseMode: {
      type: String,
      enum: ['all_at_once', 'monthly']
    },
    customerCanChooseRelease: Boolean
  }
}, {
    timestamps: true
});

// Set isWebsiteService/isFeatureUpgrade/isWebsiteUpdate based on category.
// Still used by the node system, feature-product admin pages, and plan detection.
productSchema.pre('save', function(next) {
  const websiteCategories = ['standard_websites', 'dynamic_websites'];
  const cloudCategories = ['cloud_software_development', 'app_development'];

  this.isWebsiteService = websiteCategories.includes(this.category) ||
                          cloudCategories.includes(this.category);
  this.isFeatureUpgrade = this.category === 'feature_upgrades';
  this.isWebsiteUpdate = this.category === 'website_updates';

  next();
});

const productModel = mongoose.model("product", productSchema);
module.exports = productModel;
