// SSOT for "how many uploads may this service order use right now"
// (merasoftware/src/docs/plan.md §2 "Upload allowance"). Every check and every atomic
// reservation asks this one function — uploadOrderPolicy.js, uploadSubmission.js,
// submitUpdateRequest.js and externalUploadController.js — so they can never disagree.
//
// The allowance is frozen on the order (servicePlanSnapshot.portalAccessCount = uploads for the
// current billing cycle, or for the whole plan when bought one-time); the spend is the counter
// serviceAccessUsedInCycle, reset by the cycle settlers. Giving an upload back (P5: a rejected
// upload) is a decrement of that counter, so it needs nothing here.
//
// Monthly release (snapshot.releaseMode 'monthly'): the cycle's uploads open month by month —
// updatesPerMonth for every month of the cycle that has started. Unused uploads carry forward
// inside the cycle and lapse when it ends (owner decision Q1, 28 Oct 2026). No cron: the month
// is worked out from serviceCurrentCycleStart at the moment of asking.
const { addMonths } = require('./serviceBillingSchedule');

function monthsStarted(cycleStart, cycleMonths, now) {
  if (!cycleStart) return cycleMonths;
  let count = 0;
  while (count < cycleMonths && addMonths(cycleStart, count) <= now) count += 1;
  return Math.max(1, count);
}

// { unlimited, limit, used, remaining, cycleLimit, nextReleaseAt }. limit/remaining are null when
// unlimited. nextReleaseAt is when the next month's uploads open (monthly release only).
function uploadAllowanceNow(order, now = new Date()) {
  const snapshot = order?.servicePlanSnapshot || {};
  const used = Number(order?.serviceAccessUsedInCycle || 0);
  if (snapshot.limitScope === 'unlimited') {
    return { unlimited: true, limit: null, used, remaining: null, cycleLimit: null, nextReleaseAt: null };
  }
  const cycleLimit = Number(snapshot.portalAccessCount || 0);
  let limit = cycleLimit;
  let nextReleaseAt = null;
  const perMonth = Number(snapshot.updatesPerMonth || 0);
  const cycleMonths = Number(order?.serviceBillingCycleMonths || snapshot.selectedBillingCycleMonths || 0);
  if (snapshot.releaseMode === 'monthly' && perMonth > 0 && cycleMonths > 1) {
    const started = monthsStarted(order.serviceCurrentCycleStart, cycleMonths, now);
    limit = Math.min(cycleLimit, perMonth * started);
    if (started < cycleMonths && order.serviceCurrentCycleStart) nextReleaseAt = addMonths(order.serviceCurrentCycleStart, started);
  }
  return { unlimited: false, limit, used, remaining: Math.max(0, limit - used), cycleLimit, nextReleaseAt };
}

// Mongo $expr for an atomic reservation: only reserve while the spend is below the limit right now.
// null when there is nothing to count (unlimited).
function reservationExpr(order, now = new Date()) {
  const allowance = uploadAllowanceNow(order, now);
  if (allowance.unlimited) return null;
  return { $lt: [{ $ifNull: ['$serviceAccessUsedInCycle', 0] }, allowance.limit] };
}

module.exports = { uploadAllowanceNow, reservationExpr };
