// SINGLE SOURCE OF TRUTH for "what state is this order in".
//
// Before this helper, that question was answered independently in five places, each reading a
// different mix of the stored fields and each missing rules the others had:
//
//   frontend/src/helpers/orderPresentation.js  getItemStatusMeta()      customer lists
//   frontend/src/pages/OrderPage.js            getOrderStatus()         purchase history + filter tabs
//   frontend/src/pages/ProjectDetails.js       inline conditions        project page
//   frontend/src/pages/AdminClientWorkspace.js getProjectDisplayStatus()/getPlanDisplayStatus()
//   backend/controller/order/getOrderDetails.js  inline `status` string  single-order feed
//
// The drift that produced was not theoretical. Measured against live data by
// scripts/readOnlyAuditOrderStatusSsot.js: 11 of 36 orders render a DIFFERENT meaning to the
// customer than to the admin.
//
// ── Why the stored fields cannot be trusted as-is ──────────────────────────────────────────
// Three fields are written BY HAND by whichever code path happens to run, so each one has a
// path that forgets it:
//
//   status         — enum ['pending','in_progress','completed']. cancelProjectOrder.js writes
//                    orderVisibility only and never touches status, so a cancelled order keeps
//                    status 'in_progress'. AdminClientWorkspace.js then tests
//                    status === 'cancelled'/'rejected' — values that are NOT IN THE ENUM, so
//                    that branch can never match and the order falls through to "In Progress".
//                    This is the reported "cancelled project shows In Progress" bug exactly.
//
//   currentPhase   — enum ['planning','development','review','completed'], default 'planning'.
//                    The ONLY writer is syncActiveProjectProgress() (helpers/projectNodeService.js),
//                    which sets 'completed' at >=100% and sets 'development' only in the reverse
//                    case (an order that WAS completed dropping back below 100). Ordinary forward
//                    progress 0% -> 1% never assigns 'development', so every running project is
//                    stuck displaying "planning" no matter how far along it is. ('review' is
//                    never written by anything — a dead enum value.)
//
//   orderVisibility— enum includes 'visible', which is the schema DEFAULT and which no code path
//                    ever writes. 12 live orders still carry it: they were created before/outside
//                    the approval paths and never transitioned. The customer derivation accepts
//                    'visible' as approved (isOrderApproved); the admin derivation does not read
//                    it for that case and falls through to `status`.
//
// So this engine DERIVES both the phase and the status from the facts that are actually
// maintained — progress (owned by the node timeline), money (owned by the invoice/transaction
// records), and the lifecycle markers that are genuinely written (cancelled/rejected/pending) —
// and ignores the hand-written `status` field entirely. `currentPhase` is likewise derived, not
// read, so a project at 1% reports "development" even though the stored column says "planning".
//
// ── What it returns ───────────────────────────────────────────────────────────────────────
//   {
//     code:       stable machine value — use this for filtering, counting and grouping
//     label:      human text for a badge
//     phase:      derived lifecycle phase (see PHASE)
//     phaseLabel: human text for the phase
//     progress:   rounded percent (projects only, else null)
//     tone:       semantic tone key for styling; the UI maps it to its own palette
//   }
//
// `code` exists because status is not only displayed — OrderPage.js filters its tabs and
// computes its counts by comparing the derived status string. Comparing against a stable code
// instead of prose means a wording change can never silently break a filter.
//
// This module is deliberately dependency-free (no mongoose, no models) so the same rules can run
// on a lean document, a hydrated document, or a plain API payload, and so it can be unit-checked
// without a database.

// ── Vocabulary ────────────────────────────────────────────────────────────────────────────
const STATUS = Object.freeze({
  CANCELLED: "cancelled",
  REJECTED: "rejected",
  PENDING_APPROVAL: "pending_approval",
  PAYMENT_DUE: "payment_due",
  APPROVED_NOT_STARTED: "approved_not_started",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  PLAN_ACTIVE: "plan_active",
  PLAN_CLOSED: "plan_closed",
  PROCESSING: "processing",
});

const PHASE = Object.freeze({
  PLANNING: "planning",
  DEVELOPMENT: "development",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  NOT_APPLICABLE: "not_applicable", // plans/services have no build phase
});

const PHASE_LABEL = Object.freeze({
  [PHASE.PLANNING]: "Planning",
  [PHASE.DEVELOPMENT]: "Development",
  [PHASE.COMPLETED]: "Completed",
  [PHASE.CANCELLED]: "Cancelled",
  [PHASE.NOT_APPLICABLE]: "—",
});

// Tone is a semantic key, not a colour. Each surface maps it to its own palette, so the engine
// never has to know whether it is rendering into the dark admin theme or the light customer one.
const TONE = Object.freeze({
  NEUTRAL: "neutral",
  POSITIVE: "positive",
  ACTIVE: "active",
  WARNING: "warning",
  DANGER: "danger",
});

// ── Order-type classification ─────────────────────────────────────────────────────────────
// Mirrors frontend/src/helpers/orderType.js. Kept here rather than imported because this file
// runs on the server and must not depend on the frontend bundle.
const PROJECT_CATEGORIES = new Set([
  "standard_websites",
  "dynamic_websites",
  "cloud_software_development",
  "app_development",
  "web_applications",
  "mobile_apps",
]);

const PLAN_CATEGORIES = new Set(["website_updates", "service_plan"]);

const lower = (v) => String(v || "").toLowerCase();

const isProjectOrder = (order) =>
  Boolean(order?.isWebsiteProject) ||
  PROJECT_CATEGORIES.has(lower(order?.projectSnapshot?.category)) ||
  PROJECT_CATEGORIES.has(lower(order?.productId?.category));

const isPlanOrder = (order) => PLAN_CATEGORIES.has(lower(order?.productId?.category));

const isServiceOrder = (order) => Boolean(order?.isServicePlan);

// 'visible' is the schema default and 'approved' is what the approval paths write. Both mean
// "this order is a confirmed sale" — every existing allowlist in the codebase already treats
// them identically (frontend/src/helpers/orderVisibility.js, partnerCustomers.js,
// getOrderDetails.js), so the engine does the same rather than inventing a third rule.
const isApprovedVisibility = (order) =>
  order?.orderVisibility === "approved" || order?.orderVisibility === "visible";

const getProgress = (order) => {
  const raw = Number(order?.projectProgress);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
};

// A project is done when the work says so. Both signals are accepted because the stored
// currentPhase is the one the node timeline writes at 100% — but progress alone is enough, and
// is the signal that cannot be left stale by a path that forgot to write the other.
const isWorkComplete = (order) =>
  getProgress(order) >= 100 || order?.currentPhase === "completed";

// ── Phase derivation ──────────────────────────────────────────────────────────────────────
// Derived from progress, NOT read from order.currentPhase — see the header for why that column
// cannot move off 'planning' during ordinary forward progress.
const derivePhase = (order) => {
  if (order?.orderVisibility === "cancelled") return PHASE.CANCELLED;
  if (!isProjectOrder(order)) return PHASE.NOT_APPLICABLE;
  if (isWorkComplete(order)) return PHASE.COMPLETED;
  return getProgress(order) > 0 ? PHASE.DEVELOPMENT : PHASE.PLANNING;
};

// ── Status derivation ─────────────────────────────────────────────────────────────────────
// Order of checks matters and is deliberate:
//   1. cancelled  — terminal. Checked FIRST so a project cancelled at 100% reads "Cancelled",
//                   not "Completed". (helpers/orderLifecycle.js makes this terminal server-side
//                   for the same reason.)
//   2. rejected   — the admin refused the payment; nothing was taken.
//   3. pending    — money submitted or awaited; the order is not a confirmed sale yet.
//   4. complete   — the work is finished.
//   5. payment due— an approved project with a payment the customer can act on RIGHT NOW.
//                   hasUnpaidInvoice is computed server-side by the due-installment rule in
//                   helpers/projectDuePayment.js; a future installment's invoice is not "due".
//   6. progress   — 0% means approved but not started; anything above is in progress.
const deriveProjectStatus = (order) => {
  if (order?.orderVisibility === "cancelled") {
    return { code: STATUS.CANCELLED, label: "Cancelled", tone: TONE.NEUTRAL };
  }
  if (order?.orderVisibility === "payment-rejected") {
    return { code: STATUS.REJECTED, label: "Payment Rejected", tone: TONE.DANGER };
  }
  if (order?.orderVisibility === "pending-approval") {
    return { code: STATUS.PENDING_APPROVAL, label: "Approval Pending", tone: TONE.WARNING };
  }
  if (isWorkComplete(order)) {
    return { code: STATUS.COMPLETED, label: "Completed", tone: TONE.POSITIVE };
  }
  if (order?.hasUnpaidInvoice) {
    return { code: STATUS.PAYMENT_DUE, label: "Payment Pending", tone: TONE.WARNING };
  }
  if (isApprovedVisibility(order)) {
    const progress = getProgress(order);
    if (progress === 0) {
      // Approved and paid, but no node has advanced yet. Report the last thing that actually
      // happened rather than a negative "Not Started".
      return { code: STATUS.APPROVED_NOT_STARTED, label: "Payment Approved", tone: TONE.ACTIVE };
    }
    return { code: STATUS.IN_PROGRESS, label: `In Progress · ${progress}%`, tone: TONE.ACTIVE };
  }
  return { code: STATUS.PROCESSING, label: "Processing", tone: TONE.NEUTRAL };
};

// Plans close on any of several independent signals; a plan is closed if ANY of them says so.
// Transcribed from getItemStatusMeta()/isFinishedItem() so no closure reason is lost.
const isPlanClosed = (order) => {
  if (order?.planStatus === "closed") return true;
  if (order?.isActive === false) return true;
  const isMonthly = Boolean(
    order?.productId?.isMonthlyRenewablePlan || order?.productId?.isMonthlyLimitedPlan
  );
  if (isMonthly) return Number(order?.totalYearlyDaysRemaining || 0) <= 0;
  return Number(order?.updatesUsed || 0) >= Number(order?.productId?.updateCount || 0);
};

const derivePlanStatus = (order) => {
  if (order?.orderVisibility === "cancelled") {
    return { code: STATUS.CANCELLED, label: "Cancelled", tone: TONE.NEUTRAL };
  }
  if (order?.orderVisibility === "payment-rejected") {
    return { code: STATUS.REJECTED, label: "Payment Rejected", tone: TONE.DANGER };
  }
  if (order?.orderVisibility === "pending-approval") {
    return { code: STATUS.PENDING_APPROVAL, label: "Approval Pending", tone: TONE.WARNING };
  }
  if (isPlanClosed(order)) {
    return { code: STATUS.PLAN_CLOSED, label: "Closed", tone: TONE.NEUTRAL };
  }
  if (isApprovedVisibility(order)) {
    return { code: STATUS.PLAN_ACTIVE, label: "Active plan", tone: TONE.POSITIVE };
  }
  return { code: STATUS.PROCESSING, label: "Processing", tone: TONE.NEUTRAL };
};

// A service order is a purchase with its own lifecycle column (servicePlanStatus), written by
// serviceLifecycle.js / cancelProjectOrder.js / the renewal cron. Unlike `status` and
// `currentPhase`, that column IS maintained by every path that changes a service, so it is read
// rather than re-derived — but only after the order-level terminal states, which outrank it.
const deriveServiceStatus = (order, now = Date.now()) => {
  if (order?.orderVisibility === "cancelled" || order?.servicePlanStatus === "cancelled") {
    return { code: STATUS.CANCELLED, label: "Cancelled", tone: TONE.NEUTRAL };
  }
  if (order?.orderVisibility === "payment-rejected") {
    return { code: STATUS.REJECTED, label: "Payment Rejected", tone: TONE.DANGER };
  }
  if (order?.orderVisibility === "pending-approval") {
    return { code: STATUS.PENDING_APPROVAL, label: "Approval Pending", tone: TONE.WARNING };
  }
  if (order?.servicePlanStatus === "expired" || order?.servicePlanStatus === "inactive") {
    return { code: STATUS.PLAN_CLOSED, label: "Expired", tone: TONE.NEUTRAL };
  }
  if (order?.servicePlanStatus === "paused") {
    return { code: STATUS.PLAN_CLOSED, label: "Paused", tone: TONE.WARNING };
  }
  if (isApprovedVisibility(order)) {
    const cd = order?.deactivationCountdown;
    if (cd?.active && cd?.endsAt) {
      const msLeft = new Date(cd.endsAt).getTime() - (+new Date(now));
      const daysRemaining = Math.max(0, Math.ceil(msLeft / 86400000));
      return {
        code: STATUS.PLAN_ACTIVE,
        label: "Active",
        tone: TONE.WARNING,
        deactivationDaysRemaining: daysRemaining,
        deactivationEndsAt: cd.endsAt,
        deactivationFinalStatus: cd.finalStatus || "expired",
        showDeactivationBanner: cd.showPortalBanner !== false,
      };
    }
    return { code: STATUS.PLAN_ACTIVE, label: "Active", tone: TONE.POSITIVE };
  }
  return { code: STATUS.PROCESSING, label: "Processing", tone: TONE.NEUTRAL };
};

// ── Public entry point ────────────────────────────────────────────────────────────────────
const getOrderState = (order, now = Date.now()) => {
  if (!order) {
    return {
      code: STATUS.PROCESSING,
      label: "Unknown",
      phase: PHASE.NOT_APPLICABLE,
      phaseLabel: PHASE_LABEL[PHASE.NOT_APPLICABLE],
      progress: null,
      tone: TONE.NEUTRAL,
    };
  }

  // Service first: a service order can also satisfy isPlanOrder() through its category, and its
  // own lifecycle column is the more specific answer.
  const status = isServiceOrder(order)
    ? deriveServiceStatus(order, now)
    : isPlanOrder(order)
      ? derivePlanStatus(order)
      : deriveProjectStatus(order);

  const phase = derivePhase(order);

  return {
    code: status.code,
    label: status.label,
    tone: status.tone,
    phase,
    phaseLabel: PHASE_LABEL[phase],
    progress: isProjectOrder(order) ? getProgress(order) : null,
    ...(status.deactivationDaysRemaining !== undefined ? {
      deactivationDaysRemaining: status.deactivationDaysRemaining,
      deactivationEndsAt: status.deactivationEndsAt,
      deactivationFinalStatus: status.deactivationFinalStatus,
      showDeactivationBanner: status.showDeactivationBanner,
    } : {}),
  };
};

// Convenience predicates so callers ask the engine instead of re-testing raw fields.
const isCancelled = (order) => getOrderState(order).code === STATUS.CANCELLED;
const isCompleted = (order) => getOrderState(order).code === STATUS.COMPLETED;

module.exports = {
  STATUS,
  PHASE,
  PHASE_LABEL,
  TONE,
  getOrderState,
  isCancelled,
  isCompleted,
  // exported for the shadow-compare script and tests
  isProjectOrder,
  isPlanOrder,
  isServiceOrder,
  derivePhase,
};
