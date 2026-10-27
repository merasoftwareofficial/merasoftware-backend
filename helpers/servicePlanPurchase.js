// Shared Service Plan purchase logic — SSOT for what a purchased service plan is:
// its price, duration, cycle dates and frozen snapshot.
//
// One controller owns the purchase itself (customerCreateServicePlanOrder.js,
// wallet / UPI / combined), serving both the standalone page and the in-project
// Add-a-Service modal. This file stays separate so that shape is defined in one
// place regardless of where the purchase is initiated from.

const SERVICE_PLAN_CATEGORY = "service_plan";
const { addMonths } = require("./serviceBillingSchedule");

const VALIDITY_UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };

// Cycle length in days per billing cycle. A plan with no billing cycle bills once
// up front, so its "cycle" is simply the whole validity window.
const BILLING_CYCLE_DAYS = {
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  half_yearly: 180,
  yearly: 365,
  every_2_years: 730,
  every_3_years: 1095,
  every_4_years: 1460,
  every_5_years: 1825,
};

const BILLING_CYCLE_MONTHS = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  yearly: 12,
  every_2_years: 24,
  every_3_years: 36,
  every_4_years: 48,
  every_5_years: 60,
};

const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

// Selling price wins when set, else base price. Never read from the client.
const resolveServicePlanPrice = (plan) =>
  Number(
    plan.sellingPrice !== undefined && plan.sellingPrice !== null
      ? plan.sellingPrice
      : plan.price
  );

// Prefers the stored derived value, falling back to recomputing it from
// unit + value for any plan saved before validityInDays was derived server-side.
const resolveValidityInDays = (servicePlan = {}) =>
  Number(servicePlan.validityInDays) ||
  (Number(servicePlan.totalBillingCycles) * (BILLING_CYCLE_DAYS[servicePlan.billingCycle] || 0)) ||
  Number(servicePlan.validityValue || 0) * (VALIDITY_UNIT_DAYS[servicePlan.validityUnit] || 0);

const runsIndefinitely = (servicePlan = {}) =>
  !servicePlan.billingCycle &&
  !servicePlan.totalBillingCycles &&
  !servicePlan.validityInDays &&
  !servicePlan.validityValue;

// Longest term a recurring service is sold for: the pricing SSOT's cap (servicePlanPricing.js),
// which the quote enforces. The portal's serviceTenure.js lists only terms up to the same cap.
const { MAX_TENURE_MONTHS: MAX_SERVICE_TENURE_MONTHS, quoteServicePlan, planQuoteKey, pricingMode } = require('./servicePlanPricing');

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// Decides what a purchase costs and runs for, from the plan and the customer's choices — the one
// path for the customer purchase and the admin "start plan for client". The price always comes
// from quoteServicePlan(); nothing from the request is trusted except the choices it validates.
//
// Request fields: purchase ('one_time' | billing cycle), tenureMonths, files, updates, releaseMode,
// quoteKey. The portal page built before Flexible Plans sends selectedBillingCycle instead of
// purchase and no quoteKey; that still works for fixed plans. A flexible plan needs a quoteKey.
//
// Returns { quote, quoteKey, billingSelection, oneTimeValidityDays } or null for an old plan the
// quote does not cover (fixed, recurring, but no billing options): it keeps its validity-window path.
function resolvePurchase(plan, body = {}) {
  const servicePlan = plan.servicePlan || {};
  const flexible = pricingMode(servicePlan) === 'flexible';
  const hasOptions = (servicePlan.billingOptions || []).length > 0;
  if (!flexible && !hasOptions && servicePlan.purchaseType !== 'one_time') return null;

  const purchase = body.purchase || body.selectedBillingCycle || (!hasOptions ? 'one_time' : undefined);
  if (!purchase) fail('Choose how you want to pay for this plan');
  const quote = quoteServicePlan(plan, {
    purchase,
    tenureMonths: body.tenureMonths,
    files: body.files,
    updates: body.updates,
    releaseMode: body.releaseMode,
  });
  const quoteKey = planQuoteKey(plan, quote);
  if (flexible && !body.quoteKey) fail('Check the price before buying this plan');
  if (body.quoteKey && body.quoteKey !== quoteKey) fail('The plan or its price changed. Check the new price and try again.', 409);

  const billingSelection = quote.purchase === 'one_time' ? null : {
    billingCycle: quote.purchase,
    cycleMonths: quote.cycleMonths,
    tenureMonths: quote.tenureMonths,
    totalCycles: quote.totalCycles,
    autoRenew: false,
    firstPayment: quote.cyclePrice,
  };
  // One-time: an upload plan without its own (older) validity runs for the one-time validity
  // (default 90 days, owner decision Q3); other one-time plans keep their previous behaviour.
  const oneTimeValidityDays = quote.purchase === 'one_time' && servicePlan.capability === 'upload_data' && runsIndefinitely(servicePlan)
    ? quote.validityDays
    : null;
  return { quote, quoteKey, billingSelection, oneTimeValidityDays };
}

// Builds the full order document for a purchased service plan: the frozen
// config snapshot, the validity window, and the first service cycle.
//
// The snapshot exists so a later admin edit to the plan template can never
// silently change what a customer already bought.
const buildServicePlanOrderData = ({
  userId,
  plan,
  price,
  validityInDays,
  linkedProjectOrderId = null,
  addedDuringProjectPhase = null,
  startDate = new Date(),
  billingSelection = null,
  // From resolvePurchase(): the quote (choices + price) and a one-time validity to apply.
  quote = null,
  oneTimeValidityDays = null,
}) => {
  const servicePlan = plan.servicePlan || {};
  const waitsForProjectCompletion = servicePlan.timing === 'after' && addedDuringProjectPhase === 'in_progress' && linkedProjectOrderId;
  if (oneTimeValidityDays) validityInDays = oneTimeValidityDays;

  const isCustomerConfigured = Boolean(billingSelection);
  const isIndefinite = isCustomerConfigured || oneTimeValidityDays ? false : runsIndefinitely(servicePlan);
  // What the customer may use: from the quote when there is one (a "per month" plan bought
  // quarterly gets 3 × its monthly count), else the plan's own figures as before.
  const allowance = quote && quote.allowancePerCycle !== null && quote.allowancePerCycle !== undefined
    ? quote.allowancePerCycle
    : servicePlan.portalAccessCount;
  const updatesPerMonth = quote && quote.purchase !== 'one_time'
    ? (quote.pricingMode === 'flexible' ? quote.updates : (servicePlan.limitScope === 'per_month' ? servicePlan.portalAccessCount : undefined))
    : undefined;
  const endDate = waitsForProjectCompletion ? null : (isCustomerConfigured
    ? (billingSelection.tenureMonths ? addMonths(startDate, billingSelection.tenureMonths) : null)
    : (isIndefinite ? null : addDays(startDate, validityInDays)));
  const cycleDays = isCustomerConfigured ? null : (BILLING_CYCLE_DAYS[servicePlan.billingCycle] || validityInDays);
  // A cycle can never outrun the plan's own validity.
  const firstCycleEnd = waitsForProjectCompletion ? null : (isCustomerConfigured
    ? addMonths(startDate, billingSelection.cycleMonths)
    : (isIndefinite ? null : addDays(startDate, Math.min(cycleDays, validityInDays))));

  return {
    userId,
    productId: plan._id,
    quantity: 1,
    price,
    originalPrice: price,
    totalAmount: price,
    // Customer-initiated => admin approval, same as every other customer order.
    // A fully wallet-paid purchase is flipped to approved by the caller.
    orderVisibility: "pending-approval",
    // A service plan is not a project: no timeline, no nodes, no installments.
    isWebsiteProject: false,
    isPartialPayment: false,
    paidAmount: 0,
    remainingAmount: price,
    paymentComplete: false,
    messages: [],
    orderItems: [
      {
        id: plan._id.toString(),
        name: plan.serviceName,
        type: "main",
        quantity: 1,
        originalPrice: price,
        finalPrice: price,
      },
    ],

    // Service Plan tracking
    isServicePlan: true,
    servicePlanSnapshot: {
      serviceName: plan.serviceName,
      planType: servicePlan.planType,
      serviceBehavior: servicePlan.serviceBehavior,
      timing: servicePlan.timing,
      dependency: servicePlan.dependency,
      capability: servicePlan.capability,
      purchaseType: servicePlan.purchaseType,
      monthlyReferencePrice: servicePlan.monthlyReferencePrice,
      billingOptions: servicePlan.billingOptions || [],
      limitScope: servicePlan.limitScope,
      manualUnit: servicePlan.manualUnit,
      manualCount: servicePlan.manualCount,
      portalAccessCount: allowance,
      filesLimit: quote?.files ?? servicePlan.filesLimit,
      validityUnit: servicePlan.validityUnit,
      validityValue: servicePlan.validityValue,
      validityInDays,
      billingCycle: servicePlan.billingCycle,
      totalBillingCycles: servicePlan.totalBillingCycles,
      runsIndefinitely: isIndefinite,
      selectedBillingCycle: billingSelection?.billingCycle,
      selectedBillingCycleMonths: billingSelection?.cycleMonths,
      tenureMonths: billingSelection?.tenureMonths,
      totalCycles: billingSelection?.totalCycles,
      autoRenew: false,
      categoryKey: servicePlan.categoryKey,
      pricingMode: quote?.pricingMode,
      chosenFiles: quote?.files ?? undefined,
      chosenUpdates: quote?.updates ?? undefined,
      updatesPerMonth,
      releaseMode: quote?.releaseMode,
      oneTimeValidityDays: oneTimeValidityDays || undefined,
      priceBreakdown: quote ? {
        updatePrice: quote.updatePrice ?? undefined,
        perMonthPrice: quote.perMonthPrice ?? undefined,
        subtotal: quote.subtotal,
        discountPercent: quote.discountPercent,
        discount: quote.discount,
        cyclePrice: quote.cyclePrice,
        totalPrice: quote.totalPrice,
        cycleMonths: quote.cycleMonths ?? undefined,
        totalCycles: quote.totalCycles,
      } : undefined,
    },
    servicePlanStartDate: waitsForProjectCompletion ? null : startDate,
    servicePlanEndDate: endDate,
    serviceCurrentCycleNumber: 1,
    serviceCurrentCycleStart: waitsForProjectCompletion ? null : startDate,
    serviceCurrentCycleEnd: firstCycleEnd,
    serviceSelectedBillingCycle: billingSelection?.billingCycle || null,
    serviceBillingCycleMonths: billingSelection?.cycleMonths || null,
    serviceTenureMonths: billingSelection?.tenureMonths || null,
    serviceTotalCycles: billingSelection?.totalCycles || null,
    serviceCompletedCycles: 0,
    serviceCyclePrice: billingSelection?.firstPayment || price,
    serviceAutoRenew: false,
    serviceNextBillingDate: firstCycleEnd,
    serviceAccessUsedInCycle: 0,
    serviceAccessUsedTotal: 0,
    servicePlanStatus: waitsForProjectCompletion ? "pending_activation" : "active",

    // Add-on linkage (null for a standalone purchase)
    linkedProjectOrderId,
    addedDuringProjectPhase,
  };
};

module.exports = {
  SERVICE_PLAN_CATEGORY,
  BILLING_CYCLE_DAYS,
  BILLING_CYCLE_MONTHS,
  VALIDITY_UNIT_DAYS,
  addDays,
  addMonths,
  resolveServicePlanPrice,
  resolveValidityInDays,
  runsIndefinitely,
  resolvePurchase,
  MAX_SERVICE_TENURE_MONTHS,
  buildServicePlanOrderData,
};
