const DAY = 86400000;

const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};

function parsePaymentDueDays(value, { label = 'Payment due days' } = {}) {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 365) {
    fail(`${label} must be a whole number between 0 and 365`);
  }
  return num;
}

function validDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function offerPolicyAppliesToCycle(order, policy, cycleNumber = 1) {
  if (!policy) return false;
  const isPlan = Boolean(order?.isServicePlan);
  if (!isPlan) return true;
  return Number(cycleNumber || 1) <= 1 || policy.cycleScope === 'every_cycle';
}

function resolveDueDaysFromOrder(order) {
  const raw =
    order?.servicePlanSnapshot?.paymentDueDays ??
    order?.salesPackage?.package?.paymentDueDays ??
    order?.projectSnapshot?.salesAgreement?.package?.paymentDueDays ??
    0;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.min(365, Math.round(num)) : 0;
}

/**
 * Single Source of Truth (SSOT) for invoice due date resolution.
 * Priority order:
 *   1. Explicit admin dueDate override (manual project / admin form)
 *   2. Offer paymentPolicy.dueDays (when active for this cycle)
 *   3. Installment dueDate (when explicitly set on installment)
 *   4. Plan / Package paymentDueDays (0..365)
 *   5. Fallback: invoiceDate (0 days — 100% backward compatible)
 */
function resolvePaymentDueDate({
  explicitDueDate = null,
  order = null,
  paymentPolicy = null,
  installmentDueDate = null,
  planOrPackageDueDays = undefined,
  invoiceDate = new Date(),
  cycleNumber = 1,
} = {}) {
  const base = validDateOrNull(invoiceDate) || new Date();

  const explicit = validDateOrNull(explicitDueDate);
  if (explicit) return explicit;

  const policy = paymentPolicy || order?.paymentPolicy || null;
  if (offerPolicyAppliesToCycle(order, policy, cycleNumber)) {
    const offerDays = Number(policy.dueDays || 0);
    if (Number.isFinite(offerDays) && offerDays >= 0) {
      return new Date(base.getTime() + offerDays * DAY);
    }
  }

  const instDue = validDateOrNull(installmentDueDate);
  if (instDue) return instDue;

  const dueDays =
    planOrPackageDueDays !== undefined && planOrPackageDueDays !== null
      ? Math.max(0, Math.min(365, Number(planOrPackageDueDays) || 0))
      : resolveDueDaysFromOrder(order);

  if (dueDays > 0) {
    return new Date(base.getTime() + dueDays * DAY);
  }

  return new Date(base.getTime());
}

function isBackdatedDate(date, now = Date.now()) {
  const d = validDateOrNull(date);
  if (!d) return false;
  return d.getTime() < (+new Date(now) - 2 * 60 * 1000);
}

module.exports = {
  DAY,
  parsePaymentDueDays,
  offerPolicyAppliesToCycle,
  resolveDueDaysFromOrder,
  resolvePaymentDueDate,
  isBackdatedDate,
};
