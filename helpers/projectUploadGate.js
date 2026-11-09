const { isProjectPaymentDue } = require("./projectDuePayment");
const { getOrderState, STATUS } = require("./orderStatusEngine");
const { MAX_PROJECT_FILES_PER_UPLOAD } = require("../config/uploadLimits");
const { addMonths } = require("./projectInstallments");

// A package sold without portal uploads (package setting portalUploads: false, frozen on the
// project's agreement by projectPricing.js). Custom projects and older packages have no setting.
const projectAllowsUploads = (order) => order?.projectSnapshot?.salesAgreement?.package?.portalUploads !== false;

// A monthly package project's term (projectPricing.js freezes it on the agreement; package.md decisions 12–13).
const monthlyTermOf = (order) => order?.projectSnapshot?.salesAgreement?.package?.monthly || null;
// The billing cycle running now, worked out from the term's start (no reset job): cycle k runs from
// start + k × cycle months to the next cycle's start, the last one to the term's end.
function currentCycle(term, now = new Date()) {
  const cycles = Math.max(1, Number(term.totalCycles) || 1);
  let index = 0;
  while (index < cycles - 1 && addMonths(term.startsAt, (index + 1) * term.cycleMonths) <= now) index += 1;
  const start = addMonths(term.startsAt, index * term.cycleMonths);
  const end = index === cycles - 1 ? new Date(term.endsAt) : addMonths(term.startsAt, (index + 1) * term.cycleMonths);
  return { number: index + 1, of: cycles, start, end };
}
// What a monthly package lets the client send now. Fixed monthly: unlimited updates up to the system's
// files per upload. Per file: the files per update they chose, and their updates per month, released
// month by month with carry forward inside the cycle: the plan rule (serviceAllowance.js), counted from
// this cycle's uploads that were not rejected, so a rejected upload gives its update back by itself.
// null for every other project (unlimited during development, as before).
async function projectUploadLimits(order, { session = null, now = new Date() } = {}) {
  const term = monthlyTermOf(order);
  if (!term) return null;
  const cycle = currentCycle(term, now);
  const ended = new Date(term.endsAt) <= now;
  if (term.pricing !== "per_file") return { endsAt: term.endsAt, ended, cycle, maxFiles: MAX_PROJECT_FILES_PER_UPLOAD, allowance: null };
  let query = require("../models/updateRequestModel").countDocuments({ updatePlanId: order._id, status: { $ne: "rejected" }, createdAt: { $gte: cycle.start, $lt: cycle.end } });
  if (session) query = query.session(session);
  const used = await query;
  const allowance = require("./serviceAllowance").uploadAllowanceNow({
    servicePlanSnapshot: { portalAccessCount: term.updatesPerMonth * term.cycleMonths, updatesPerMonth: term.updatesPerMonth, releaseMode: "monthly" },
    serviceBillingCycleMonths: term.cycleMonths, serviceCurrentCycleStart: cycle.start, serviceAccessUsedInCycle: used,
  }, now);
  return { endsAt: term.endsAt, ended, cycle, maxFiles: Math.min(MAX_PROJECT_FILES_PER_UPLOAD, term.files), allowance };
}

// When does a PROJECT refuse an upload?
//
// A project's portal access during development is unlimited — there is no allowance to
// spend and no counter to check (see helpers/uploadType.js). What does gate it is the
// project's own state, and ProjectDetails.js already states that rule for the button:
//
//   isUploadLocked = hasUnpaidInvoice || isOrderPendingApproval
//                    || isProjectComplete || isOrderCancelled
//
// Until now that rule lived ONLY in the UI, while POST /user-request-update is reachable
// directly. deleteProduct.js makes the same point about its own guard: "This guard is
// enforced here, not only in the UI, because this route is reachable directly." So the
// server states it too.
//
// Each condition is answered by the module that already owns it, not re-derived here:
//   cancelled / complete  -> orderStatusEngine.getOrderState (the status SSOT)
//   payment due           -> projectDuePayment.getDueUnpaidInvoiceFilter (the due-invoice SSOT)
//   pending approval      -> orderVisibility, the same field the UI reads
// Restating any of them here is exactly how the server and the button would drift apart.

/**
 * May this project order accept an upload right now?
 *
 * @param {object} order a project order document
 * @returns {Promise<string|null>} the refusal message, or null when the upload may proceed
 */
const assertProjectAcceptsUpload = async (order, { session = null, now = new Date() } = {}) => {
  const state = getOrderState(order);

  if (state.code === STATUS.CANCELLED) {
    return "This project has been cancelled and cannot accept uploads";
  }

  if (!projectAllowsUploads(order)) {
    return "This project does not include portal uploads. You will get progress updates here.";
  }

  if (state.code === STATUS.COMPLETED || Number(order.projectProgress || 0) >= 100) {
    return "This project is complete and cannot accept uploads";
  }

  if (order.orderVisibility === "pending-approval") {
    return "This project is awaiting payment approval. Uploads open once it is approved.";
  }

  const limits = await projectUploadLimits(order, { session, now });
  if (limits?.ended) {
    return "This package has ended. Buy it again to continue sending files.";
  }
  if (limits?.allowance && limits.allowance.remaining <= 0) {
    return limits.allowance.nextReleaseAt ? "This month's updates are used. More open next month." : "This billing cycle's updates are used.";
  }

  if (order.paymentPolicy) {
    const access = await require('./offerPaymentPolicy').getPaymentAccess(order);
    return access.allowed ? null : access.reason;
  }

  if (await isProjectPaymentDue(order)) {
    return "A payment is due on this project. Uploads open once the payment is recorded.";
  }

  return null;
};

module.exports = { assertProjectAcceptsUpload, projectAllowsUploads, projectUploadLimits, monthlyTermOf, currentCycle };
