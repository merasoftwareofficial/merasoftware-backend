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

function parseGraceEndAction(value) {
  return value === 'auto_cancel' ? 'auto_cancel' : 'keep_open';
}

function resolveGraceEndAction(order) {
  const raw =
    order?.salesPackage?.package?.graceEndAction ??
    order?.projectSnapshot?.salesAgreement?.package?.graceEndAction ??
    'keep_open';
  return parseGraceEndAction(raw);
}

/**
 * Single Source of Truth (SSOT) for invoice due date resolution.
 * Due date is NEVER shifted by unpaid grace days (paymentDueDays):
 *   - Monthly plans / packages: dueDate = Billing Cycle Date (invoiceDate)
 *   - One-time projects / packages: explicit admin dueDate -> Offer dueDays -> installment dueDate -> invoiceDate
 * Priority order:
 *   1. Explicit admin dueDate override (manual project / admin form)
 *   2. Offer paymentPolicy.dueDays (when active for this cycle)
 *   3. Installment dueDate (when explicitly set on installment)
 *   4. Fallback: invoiceDate (0 days — Billing Cycle / Start Date)
 */
function resolvePaymentDueDate({
  explicitDueDate = null,
  order = null,
  paymentPolicy = null,
  installmentDueDate = null,
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

  return new Date(base.getTime());
}

/**
 * Single Source of Truth (SSOT) for the unpaid grace cutoff (auto-pause / optional auto-cancel).
 * graceEndDate = dueDate + graceDays (when protectBackdated is true, anchored to max(dueDate, order.createdAt)).
 */
function resolveGraceCutoff({
  order = null,
  invoice = null,
  dueDate = null,
  graceDays = undefined,
  protectBackdated = false,
} = {}) {
  const baseDue = validDateOrNull(dueDate) || validDateOrNull(invoice?.dueDate) || null;
  if (!baseDue) return null;
  const days =
    graceDays !== undefined && graceDays !== null
      ? Math.max(0, Math.min(365, Math.round(Number(graceDays) || 0)))
      : resolveDueDaysFromOrder(order);
  const created = protectBackdated ? validDateOrNull(order?.createdAt) : null;
  const anchorMs = created ? Math.max(baseDue.getTime(), created.getTime()) : baseDue.getTime();
  return new Date(anchorMs + days * DAY);
}

function isBackdatedDate(date, now = Date.now()) {
  const d = validDateOrNull(date);
  if (!d) return false;
  return d.getTime() < (+new Date(now) - 2 * 60 * 1000);
}

module.exports = {
  DAY,
  parsePaymentDueDays,
  parseGraceEndAction,
  offerPolicyAppliesToCycle,
  resolveDueDaysFromOrder,
  resolveGraceEndAction,
  resolvePaymentDueDate,
  resolveGraceCutoff,
  isBackdatedDate,
};
