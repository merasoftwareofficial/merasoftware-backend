const { getOrderState } = require("./orderStatusEngine");

const ORDER_SUMMARY_FIELDS = [
  "userId productId projectSnapshot orderItems isWebsiteProject price totalAmount status projectProgress currentPhase isActive updatesUsed",
  "totalYearlyDaysRemaining currentMonthExpiryDate autoRenewalStatus currentMonthUpdatesUsed",
  "currentMonthUpdatesLimit currentMonthUpdatesRemaining orderVisibility planStatus createdAt updatedAt",
  // Cancellation/refund facts — the list badge reads orderVisibility, the detail views read the rest.
  "cancelledAt cancellationReason refunds refundTotal",
  // Service lifecycle. helpers/orderStatusEngine.js needs these to tell a service apart from a
  // project/plan and to read its real state: without isServicePlan a service is classified by its
  // category and answered from progress, which is how a paused service came to read "Completed".
  "isServicePlan servicePlanStatus",
  "paymentPolicy paymentPolicyUploads",
  // What the service is ALLOWED, and how much of it is spent. Both are written on the order at
  // purchase (helpers/servicePlanPurchase.js) and maintained there — servicePlanSnapshot is
  // frozen, serviceAccessUsedInCycle is incremented by submitUpdateRequest.js and reset each
  // cycle by serviceCycleSettlement.js. The detail endpoint returns the whole order document, so
  // the plan page could read them; this feed sent neither, so every list surface fell back to the
  // LEGACY plan's catalogue field (productId.updateCount) and reported "0 update(s) left" for a
  // service whose allowance was sitting right here. Verified before adding: all 8 live service
  // orders carry a populated snapshot. Nothing is computed differently — the figure is only
  // being sent to the surfaces that already claim to show it.
  "servicePlanSnapshot serviceAccessUsedInCycle servicePlanEndDate serviceCurrentCycleNumber serviceCurrentCycleEnd serviceTotalCycles serviceNextBillingDate",
].join(" ");

const PRODUCT_SUMMARY_FIELDS = [
  "serviceName category price sellingPrice validityPeriod updateCount isWebsiteUpdate",
  "isMonthlyRenewablePlan yearlyPlanDuration monthlyRenewalCost isUnlimitedUpdates",
  "isMonthlyLimitedPlan monthlyUpdateLimit monthlyRenewalPrice",
].join(" ");

// Attaches the derived state from helpers/orderStatusEngine.js to every order this helper
// returns, as `orderState`. Every list surface (customer lists, admin workspace, payment
// workspace) therefore receives the SAME answer computed in the SAME place, instead of each
// re-deriving it from raw fields and drifting apart.
//
// Additive by design: no existing field is removed or rewritten, so a caller that still reads
// order.status / order.currentPhase keeps working unchanged while surfaces are moved over one
// at a time.
//
// hasUnpaidInvoice is NOT computed here — it needs an invoice query, and only getUserOrder.js
// has the batched version of it. Callers that set it must do so BEFORE calling this, or call
// attachOrderState again afterwards; getOrderState treats a missing flag as "nothing due",
// which is the same assumption the shipping code already makes on those surfaces.
const attachOrderState = (order) => {
  if (!order) return order;
  order.orderState = getOrderState(order);
  return order;
};

const applyOrderSummary = async (query) => {
  const orders = await query
    .select(ORDER_SUMMARY_FIELDS)
    .populate("productId", PRODUCT_SUMMARY_FIELDS)
    .populate("assignedDeveloper", "name designation avatar status")
    .lean();

  if (Array.isArray(orders)) return orders.map(attachOrderState);
  return attachOrderState(orders);
};

module.exports = {
  ORDER_SUMMARY_FIELDS,
  PRODUCT_SUMMARY_FIELDS,
  applyOrderSummary,
  attachOrderState,
};
