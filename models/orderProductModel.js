const mongoose = require('mongoose');

// Message Schema for project communication
const messageSchema = new mongoose.Schema({
    sender: {
        type: String,
        enum: ['admin', 'user'],
        required: true
    },
    message: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
    // Add these fields to connect messages to checkpoints
    checkpointId: {
        type: Number
    },
    checkpointName: {
        type: String
    },
    nodeId: {
        type: String
    },
    runId: {
        type: String
    },
    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user'
    }
});

const projectRunSchema = new mongoose.Schema({
    runId: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'archived'],
        default: 'active'
    },
    startedAt: {
        type: Date,
        default: Date.now
    },
    archivedAt: Date,
    startedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user'
    },
    archivedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user'
    },
    showToClient: {
        type: Boolean,
        default: false
    }
}, { _id: false });

const projectNodeSchema = new mongoose.Schema({
    nodeId: {
        type: String,
        required: true
    },
    runId: {
        type: String,
        required: true
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    cumulativeProgress: {
        type: Number,
        required: true,
        min: 0,
        max: 100
    },
    status: {
        type: String,
        enum: ['active', 'deleted', 'archived'],
        default: 'active'
    },
    visibleToClient: {
        type: Boolean,
        default: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    deletedAt: Date,
    deletedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user'
    },
    restoredAt: Date,
    restoredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user'
    },
    editedAt: Date,
    editedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user'
    },
    messageIds: {
        type: [String],
        default: []
    }
}, { _id: false });

// One entry per lifecycle transition an order goes through — the record of WHEN an order
// reached the state it is in, and who moved it there.
//
// Why this exists: the order carries the CURRENT state (orderVisibility, projectProgress) but,
// apart from cancellation, kept no record of when it got there. `updatedAt` cannot answer it —
// any later edit overwrites it. So "when was this approved / rejected / started / finished" had
// no answer at all. Progress changes were already logged this way in projectNodeEvents; this
// applies the same treatment to the lifecycle.
//
// Kept on the order document rather than in its own collection: measured against live data, the
// heaviest order is 22 KB against MongoDB's 16 MB limit, and lifecycle transitions are a handful
// per order for its whole life — nothing here can grow unbounded.
//
// actorId is nullable, unlike projectNodeEventSchema's. Some transitions genuinely have no human
// actor: cron/servicePlanRenewalCron.js settles a service cycle, which approves the order via
// helpers/serviceCycleSettlement.js with no request and no user. Those carry actorType 'system'.
// Backfilled entries carry 'backfill' and a source note, so a reconstructed date is never
// mistaken for one that was actually observed.
const orderLifecycleEventSchema = new mongoose.Schema({
    eventType: {
        type: String,
        enum: ['approved', 'rejected', 'cancelled', 'work_started', 'completed', 'reopened'],
        required: true
    },
    occurredAt: {
        type: Date,
        default: Date.now,
        required: true
    },
    actorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        default: null
    },
    actorType: {
        type: String,
        enum: ['admin', 'customer', 'system', 'backfill'],
        required: true
    },
    // What the order moved from/to, so an entry is readable without replaying everything before it.
    fromVisibility: { type: String, default: null },
    toVisibility: { type: String, default: null },
    progressAtEvent: { type: Number, min: 0, max: 100, default: null },
    // Admin's stated reason (rejection reason, cancellation reason) where one exists.
    reason: { type: String, default: null },
    // For backfilled entries: what the date was reconstructed FROM, so its reliability is visible.
    derivedFrom: { type: String, default: null },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, { _id: false });

const projectNodeEventSchema = new mongoose.Schema({
    eventType: {
        type: String,
        enum: ['node_created', 'node_edited', 'node_deleted', 'node_restored', 'node_visibility_changed', 'project_reset'],
        required: true
    },
    nodeId: String,
    runId: {
        type: String,
        required: true
    },
    actorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: true
    },
    previousProgress: {
        type: Number,
        min: 0,
        max: 100
    },
    nextProgress: {
        type: Number,
        min: 0,
        max: 100
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    occurredAt: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

const installmentSchema = new mongoose.Schema({
    installmentNumber: {
        type: Number,
        required: true
    },
    percentage: {
        type: Number,
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    paid: {
        type: Boolean,
        default: false
    },
    paymentStatus: {
        type: String,
        enum: ['none', 'pending-approval', 'rejected'],
        default: 'none'
    },
    paidDate: {
        type: Date
    },
    dueDate: {
        type: Date
    },
    transactionId: {
        type: String
    },
    // Progress-gate threshold (node-system % at which THIS installment becomes due). Additive,
    // optional — null means "no progress gate" so every pre-existing order (all created before
    // this field existed) keeps behaving exactly as before. Installment #1 (advance) is due at
    // creation regardless of this field. Admin-editable per project at creation time.
    progressThreshold: {
        type: Number,
        default: null,
        min: 0,
        max: 100
    }
});

// Frozen client-project contract. Unlike a catalogue product, a client project
// belongs to exactly one order and must keep its agreed scope even if templates
// or feature prices change later.
const projectSnapshotSchema = new mongoose.Schema({
    displayName: { type: String, trim: true },
    category: { type: String, trim: true },
    // Category name at creation (helpers/projectCategories.js), so a later rename never relabels old work.
    categoryLabel: { type: String, trim: true },
    startingNodeTitle: { type: String, trim: true },
    totalPages: Number,
    basePrice: Number,
    referenceTotal: Number,
    finalPrice: Number,
    // Frozen package/offer agreement; never re-read current catalogue prices for old work.
    salesAgreement: { type: mongoose.Schema.Types.Mixed, default: undefined },
    features: [{
        featureId: { type: mongoose.Schema.Types.ObjectId, ref: 'product' },
        name: String,
        // Total charged for this feature (unitPrice x quantity), mirroring the
        // finalPrice of its orderItems[] row.
        price: Number,
        // Catalogue price of ONE unit at purchase time, so the frozen record never
        // has to divide price by quantity to recover it.
        unitPrice: Number,
        // How many units of a quantity-based feature were bought (1 for a single
        // feature). Declared so the snapshot keeps it — strict mode was dropping
        // the quantity the create-project controllers already send.
        quantity: { type: Number, default: 1 }
    }],
    // Website offer (merasoftware /offer) this project was sold under, if any. Frozen at
    // creation — the offer itself can later be edited, archived or expire on the website.
    offer: {
        type: new mongoose.Schema({
            slug: { type: String, trim: true },
            title: { type: String, trim: true },
        }, { _id: false }),
        default: undefined
    }
}, { _id: false });

const orderSchema = new mongoose.Schema({
    projectCreationKey: { type: String, unique: true, sparse: true },
    projectCreationHash: String,
    projectCreationComplete: { type: Boolean, default: false },
    // Transaction fence for project uploads racing order-state changes.
    uploadRevision: { type: Number, default: 0 },
    offerReservationId: { type: mongoose.Schema.Types.ObjectId, ref: 'offerReservation', default: null },
    // Event-only provision. No reminder worker consumes this milestone yet.
    offerFirstWorkUpdate: { type: new mongoose.Schema({ version: Number, runId: String, nodeId: String, occurredAt: Date, actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'user' } }, { _id: false }), default: null },
    // Frozen offer terms; operational counters remain separate from this agreement.
    paymentPolicy: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    paymentPolicyUploads: { type: Number, default: 0, min: 0 },
    serviceOfferPurchaseKey: { type: String, unique: true, sparse: true },
    serviceOfferPurchaseHash: String,
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: true
    },
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'product',
        default: null
    },
    projectSnapshot: {
        type: projectSnapshotSchema,
        default: null
    },
    quantity: {
        type: Number,
        required: true,
        default: 1
    },
    price: {
        type: Number,
        required: true
    },
     // Add coupon-related fields
     couponApplied: {
        type: String,
        default: null
    },
    discountAmount: {
        type: Number,
        default: 0
    },
    originalPrice: {
        type: Number,
        default: null
    },
    status: {
        type: String,
        enum: ['pending', 'in_progress', 'completed'],
        default: 'pending'
    },
    projectProgress: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    // New fields for project management. No schema default — the pre('save') hook
    // below only derives this from the product category when a caller genuinely
    // didn't set it (createOrder.js/adminCreateProjectOrder.js always set it directly).
    isWebsiteProject: {
        type: Boolean
    },
    // Canonical dynamic project timeline. All website-project orders (new and
    // pre-existing, migrated via backend/scripts/migratePreExistingOrdersToNodeSystem.js)
    // are on version 1. The 4 non-website legacy orders remain on version 0 by design —
    // the node system only supports isWebsiteProject orders.
    projectTimelineVersion: {
        type: Number,
        default: 0
    },
    projectTimelineInitialized: {
        type: Boolean,
        default: false
    },
    projectRuns: {
        type: [projectRunSchema],
        default: []
    },
    projectNodes: {
        type: [projectNodeSchema],
        default: []
    },
    projectNodeEvents: {
        type: [projectNodeEventSchema],
        default: []
    },
    // Lifecycle history — see orderLifecycleEventSchema above. Applies to every order type
    // (project, plan, service), unlike projectNodeEvents which is project-timeline only.
    lifecycleEvents: {
        type: [orderLifecycleEventSchema],
        default: []
    },
    messages: [messageSchema],
    currentPhase: {
        type: String,
        enum: ['planning', 'development', 'review', 'completed'],
        default: 'planning'
    },
    expectedCompletionDate: Date,
    lastUpdated: {
        type: Date,
        default: Date.now
    },
    isActive: {
        type: Boolean,
        default: true,
        validate: {
            validator: function(value) {
                // Only validate isActive for website update products
                if (!this.productId) return true;
                return true; // The actual validation will happen in the controller
            },
            message: 'Invalid update plan status'
        }
    },
    updatesUsed: {
        type: Number,
        default: 0
    },
    // New fields for yearly renewable plans
    monthlyRenewalHistory: [{
        renewalDate: {
            type: Date,
            required: true
        },
        renewalCost: {
            type: Number,
            required: true
        },
        paymentStatus: {
            type: String,
            enum: ['paid', 'pending', 'expired'],
            default: 'paid'
        },
        renewalPeriodStart: {
            type: Date,
            required: true
        },
        renewalPeriodEnd: {
            type: Date,
            required: true
        },
        updatesUsedInPeriod: {
            type: Number,
            default: 0
        }
    }],
    totalYearlyDaysRemaining: {
        type: Number,
        validate: {
            validator: function(value) {
                if (value !== null && value !== undefined) {
                    return value >= 0 && value <= 365;
                }
                return true;
            },
            message: 'Yearly days remaining must be between 0 and 365'
        }
    },
    currentMonthExpiryDate: {
        type: Date
    },
    autoRenewalStatus: {
        type: String,
        enum: ['active', 'paused', 'expired'],
        default: 'active'
    },
    currentMonthUpdatesUsed: {
        type: Number,
        default: 0
    },
    // New fields for monthly limited plans
    currentMonthUpdatesLimit: {
        type: Number,
        default: null  // Will be set from product.monthlyUpdateLimit
    },
    currentMonthUpdatesRemaining: {
        type: Number,
        default: null  // Calculated as: limit - used
    },
    monthlyLimitResetDate: {
        type: Date,
        default: null  // Date when monthly counter resets
    },
    assignedDeveloper: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Developer',
        default: null
    },
    assignedAt: {
        type: Date,
        default: null
    },
    isPartialPayment: {
        type: Boolean,
        default: false
    },
    currentInstallment: {
        type: Number,
        default: 1,
        min: 1,
        max: 3
    },
    totalAmount: {
        type: Number
    },
    paidAmount: {
        type: Number,
        default: 0
    },
    remainingAmount: {
        type: Number,
        default: 0
    },
    installments: [installmentSchema],
    paymentComplete: {
        type: Boolean,
        default: false
    },
    // Admin-controlled demo mode (schema only — design-ahead, no UI/behavior built yet). Additive,
    // independent of payment type/status: admin can enable it on ANY project (full or partial,
    // customer-started or admin-created) so the customer gets a limited number of single-use
    // "upload data" turns, unrelated to invoice/installment payment state.
    demoMode: {
        active: {
            type: Boolean,
            default: false
        },
        uploadsRemaining: {
            type: Number,
            default: 0,
            min: 0
        },
        enabledBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'user',
            default: null
        },
        enabledAt: {
            type: Date,
            default: null
        }
    },
    orderVisibility: {
        type: String,
        // 'cancelled' is a terminal state set by the admin cancel action. It is deliberately
        // NOT part of any approved/active allowlist, so every existing visibility check treats
        // a cancelled order as not-approved without needing to know the value exists.
        enum: ['visible', 'approved', 'pending-approval', 'payment-rejected', 'hidden', 'cancelled'],
        default: 'visible'
    },
    rejectionReason: {
        type: String,
        default: null
    },
    // ---- Cancellation + refund (admin-only). A project is cancelled before it can be
    // deleted, so the money is settled while its payment records still exist.
    cancelledAt: {
        type: Date,
        default: null
    },
    cancelledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
        default: null
    },
    cancellationReason: {
        type: String,
        default: null
    },
    // One entry per method the money actually came in through — a combined payment refunds
    // to both. Wallet legs are credited instantly by the server; every other method is money
    // the admin sends outside this system, so it carries the admin's own reference id.
    refunds: {
        type: [{
            method: {
                type: String,
                enum: ['wallet', 'upi', 'cash', 'bank_transfer', 'cheque', 'combined', 'demo'],
                required: true
            },
            amount: { type: Number, required: true },
            // Set for wallet legs (the transactionModel row this refund created) and for
            // external legs (the admin's bank/UPI reference the customer can look up).
            transactionId: { type: String, default: null },
            referenceId: { type: String, default: null },
            refundedAt: { type: Date, default: Date.now }
        }],
        default: []
    },
    refundTotal: {
        type: Number,
        default: 0
    },
    // What the system calculated vs what the admin actually gave. Cancellation is one-way, so
    // the reasoning behind the figure is the only record there will ever be of why.
    refundSuggestedAmount: {
        type: Number,
        default: null
    },
    refundBasis: {
        type: String,
        default: null
    },
    refundExplanation: {
        type: String,
        default: null
    },
    // How the refund was divided across payment methods, and — when the wallet got more than
    // the source split would give it — the reason the customer asked for that.
    refundMode: {
        type: String,
        enum: ['source', 'wallet_first', 'manual', null],
        default: null
    },
    refundModeReason: {
        type: String,
        default: null
    },
    orderItems: {
        type: [{
            id: String,
            name: String,
            type: { type: String, enum: ['main', 'feature'] },
            quantity: Number,
            originalPrice: Number,
            finalPrice: Number,
            additionalQuantity: { type: Number, default: 0 }
        }],
        default: []
    },
    isCombinedOrder: {
        type: Boolean,
        default: false
    },
    // Add project link field
    projectLink: {
        type: String,
        default: ''
    },
    portfolioCaptureAllowed: {
        type: Boolean,
        default: true
    },
    // Plan closure fields
    planStatus: {
        type: String,
        enum: ['active', 'closed'],
        default: 'active'
    },
    closureReason: {
        type: String,
        default: null
    },
    closedAt: {
        type: Date,
        default: null
    },
    closedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        default: null
    },

    // ---------------------------------------------------------------------
    // Service Plan System (new, additive). Coexists with the legacy plan
    // fields above — legacy fields/logic are untouched. isServicePlan is the
    // switch every enforcement/read path checks to pick the new vs old path.
    // servicePlanSnapshot freezes the plan template's servicePlan config at
    // purchase time so a later admin edit to the plan never silently changes
    // what a customer already bought.
    // ---------------------------------------------------------------------
    isServicePlan: {
        type: Boolean,
        default: false
    },
    servicePlanSnapshot: {
        // The plan's display name, frozen at purchase like every other snapshot
        // field. Without this the order would depend on the catalog product row
        // still existing just to render its own name — the one thing the rest of
        // the snapshot was designed to avoid. A retired or deleted plan must never
        // blank out a customer's purchase history.
        serviceName: String,
        planType: String,
        limitScope: String,
        manualUnit: String,
        manualCount: Number,
        portalAccessCount: Number,
        filesLimit: Number,
        validityUnit: String,
        validityValue: Number,
        validityInDays: Number,
        billingCycle: String,
        totalBillingCycles: Number,
        runsIndefinitely: Boolean,
        serviceBehavior: String,
        timing: String,
        dependency: String,
        capability: String,
        purchaseType: String,
        monthlyReferencePrice: Number,
        billingOptions: [{
            billingCycle: String,
            discountPercent: Number,
            pricePerCycle: Number
        }],
        selectedBillingCycle: String,
        selectedBillingCycleMonths: Number,
        tenureMonths: Number,
        autoRenew: Boolean
    },
    // Add-on service linkage. A service order can be bought two ways:
    //   linkedProjectOrderId === null -> standalone plan (existing behaviour)
    //   linkedProjectOrderId set       -> this service is an add-on attached to
    //                                     that specific project order.
    // Backend/engine logic stays identical for both; this is a reference +
    // reporting field, not a behaviour branch.
    linkedProjectOrderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'order',
        default: null
    },
    // Which moment of the project's life this add-on was bought in. Kept
    // separate from linkedProjectOrderId because the business intent differs:
    // an in-progress add-on extends the running project, an after-completion
    // one is ongoing servicing of a finished project.
    addedDuringProjectPhase: {
        type: String,
        enum: ['in_progress', 'after_completion'],
        default: null
    },
    servicePlanStartDate: {
        type: Date,
        default: null
    },
    servicePlanEndDate: {
        type: Date,
        default: null
    },
    serviceCurrentCycleNumber: {
        type: Number,
        default: 1
    },
    serviceCurrentCycleStart: {
        type: Date,
        default: null
    },
    serviceCurrentCycleEnd: {
        type: Date,
        default: null
    },
    // Customer-selected commercial terms. These are order-level values, never
    // re-read from the catalogue after purchase.
    serviceSelectedBillingCycle: {
        type: String,
        default: null
    },
    serviceBillingCycleMonths: {
        type: Number,
        default: null
    },
    serviceTenureMonths: {
        type: Number,
        default: null
    },
    serviceTotalCycles: {
        type: Number,
        default: null
    },
    serviceCompletedCycles: {
        type: Number,
        default: 0
    },
    serviceCyclePrice: {
        type: Number,
        default: null
    },
    serviceAutoRenew: {
        type: Boolean,
        default: false
    },
    serviceNextBillingDate: {
        type: Date,
        default: null
    },
    serviceAutoRenewalStoppedAt: {
        type: Date,
        default: null
    },
    serviceAccessUsedInCycle: {
        type: Number,
        default: 0
    },
    serviceAccessUsedTotal: {
        type: Number,
        default: 0
    },
    serviceCycleHistory: {
        type: [{
            cycleNumber: Number,
            cycleStart: Date,
            cycleEnd: Date,
            accessUsed: Number,
            invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'invoice' },
            amount: Number,
            paidAt: Date
        }],
        default: []
    },
    servicePlanStatus: {
        type: String,
        enum: ['pending_activation', 'active', 'paused', 'expired', 'inactive', 'cancelled'],
        default: 'active'
    }
}, {
    timestamps: true
});

orderSchema.pre('save', async function(next) {
    // Only run when order is first created (isNew) and isWebsiteProject hasn't been
    // set explicitly by the caller (createOrder.js/adminCreateProjectOrder.js both set
    // it directly) — this is a fallback for any other order-creation path.
    if (this.isNew && this.productId && this.isWebsiteProject === undefined) {
      try {
        const product = await mongoose.model('product').findById(this.productId);
        if (product) {
          const websiteCategories = ['standard_websites', 'dynamic_websites', 'cloud_software_development', 'app_development'];
          this.isWebsiteProject = websiteCategories.includes(product.category);
        }
      } catch (error) {
        console.error('Error setting isWebsiteProject:', error);
      }
    }
    next();
  });

// Middleware to update lastUpdated
orderSchema.pre('save', function(next) {
    this.lastUpdated = new Date();
    next();
});

orderSchema.methods.payInstallment = function(installmentNumber, amount) {
    // Find the installment
    const installment = this.installments.find(i => i.installmentNumber === installmentNumber);
    
    if (installment && !installment.paid) {
        installment.paid = true;
        installment.paidDate = new Date();
        
        // Update payment tracking
        this.paidAmount += amount;
        this.remainingAmount = this.totalAmount - this.paidAmount;
        
        // If all installments are paid, mark as complete
        const allPaid = this.installments.every(i => i.paid);
        if (allPaid) {
            this.paymentComplete = true;
        } else {
            // Move to next installment
            const nextInstallment = this.installments.find(i => !i.paid);
            if (nextInstallment) {
                this.currentInstallment = nextInstallment.installmentNumber;
            }
        }
        
        return true;
    }
    
    return false;
};

const orderModel = mongoose.model('order', orderSchema);
module.exports = orderModel;
