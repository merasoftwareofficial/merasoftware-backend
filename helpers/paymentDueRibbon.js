const Rule = require('../models/communicationActionRuleModel');
const { DAY } = require('./paymentDueDate');

const DEFAULT_RIBBON_WINDOW_DAYS = 3;
const OPEN_INVOICE_STATUSES = ['unpaid', 'partially_paid', 'overdue'];

function orderPackageSlug(order) {
  const pkgSlug = String(
    order?.salesPackage?.packageSlug || order?.salesPackage?.slug || order?.salesPackage?.packageId ||
    order?.salesPackage?.package?.id || order?.projectSnapshot?.salesAgreement?.package?.id ||
    order?.servicePlanSnapshot?.packageSlug || '',
  ).trim();
  if (pkgSlug) return pkgSlug;
  if (order?.isServicePlan && order?.productId) {
    const pid = order.productId?._id || order.productId;
    return pid ? `plan:${String(pid)}` : '';
  }
  return '';
}

function ruleMatchesOrderScope(rule, order) {
  const kind = rule?.scope?.kind || 'all';
  if (kind === 'all') return true;
  const isMonthly = Boolean(order?.isServicePlan || order?.salesPackage);
  if (kind === 'monthly') return isMonthly;
  if (kind === 'one_time') return !isMonthly;
  if (kind === 'offer_payment') return Boolean(order?.paymentPolicy);
  const slug = orderPackageSlug(order);
  if (kind === 'package') return Boolean(rule.scope?.packageSlug && slug === rule.scope.packageSlug);
  if (kind === 'include') return Array.isArray(rule.scope?.includedPackages) && Boolean(slug) && rule.scope.includedPackages.includes(slug);
  if (kind === 'exclude') return !slug || !(Array.isArray(rule.scope?.excludedPackages) && rule.scope.excludedPackages.includes(slug));
  return true;
}

function maxBeforeDueDaysFromSteps(steps = []) {
  let maxDays = 0;
  for (const st of Array.isArray(steps) ? steps : []) {
    if (st?.timingRef !== 'before_due') continue;
    const days = st.unit === 'hours'
      ? Math.ceil(Number(st.hours || 0) / 24)
      : Number(st.days || 0);
    if (Number.isFinite(days) && days > maxDays) maxDays = days;
  }
  return maxDays;
}

async function loadBeforeDueRules() {
  return Rule.find({
    trailId: { $ne: null },
    enabled: true,
    kind: 'reminder',
    $or: [{ action: 'invoice.created' }, { actions: 'invoice.created' }],
    'steps.timingRef': 'before_due',
  }).select('steps scope').lean().catch(() => []);
}

function resolveRibbonWindowDays(order, rules = []) {
  let maxDays = 0;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!ruleMatchesOrderScope(rule, order)) continue;
    const d = maxBeforeDueDaysFromSteps(rule.steps);
    if (d > maxDays) maxDays = d;
  }
  return maxDays > 0 ? maxDays : DEFAULT_RIBBON_WINDOW_DAYS;
}

function orderDisplayTitle(order) {
  return (
    order?.projectSnapshot?.displayName ||
    order?.servicePlanSnapshot?.serviceName ||
    order?.salesPackage?.package?.name ||
    order?.orderItems?.[0]?.name ||
    order?.productId?.serviceName ||
    'Order'
  );
}

/**
 * SSOT builder for client portal payment due / overdue warning ribbon.
 * Returns null when nothing is due, outside the pre-due window, paid, cancelled,
 * or awaiting payment approval (UPI pending).
 */
function buildPaymentDueAlert({ order, invoice, rules = [], hasPendingPayment = false, now = new Date() }) {
  if (!order || !invoice) return null;
  if (['cancelled', 'payment-rejected', 'pending-approval'].includes(order.orderVisibility)) return null;
  if (order.servicePlanStatus === 'cancelled') return null;
  if (hasPendingPayment) return null;
  if (!OPEN_INVOICE_STATUSES.includes(invoice.status)) return null;

  const amount = Number(invoice.amount || 0);
  const amountPaid = Number(invoice.amountPaid || 0);
  const amountDue = Math.round(Math.max(0, amount - amountPaid) * 100) / 100;
  if (!(amountDue > 0)) return null;

  const due = invoice.dueDate ? new Date(invoice.dueDate) : null;
  if (!due || !Number.isFinite(due.getTime())) return null;

  const nowMs = new Date(now).getTime();
  const msDiff = due.getTime() - nowMs;
  const daysRemaining = msDiff > 0 ? Math.ceil(msDiff / DAY) : Math.floor(msDiff / DAY);
  const ribbonWindowDays = resolveRibbonWindowDays(order, rules);

  const isPaused = order.isServicePlan && order.servicePlanStatus === 'paused';
  const isExpired = order.isServicePlan && order.servicePlanStatus === 'expired';
  const deactivationDaysRemaining = order?.orderState?.deactivationDaysRemaining ?? null;

  if (daysRemaining > ribbonWindowDays && !isPaused && deactivationDaysRemaining === null) {
    return null;
  }

  let kind = 'due_soon';
  if (msDiff <= 0 || invoice.status === 'overdue' || isPaused) {
    kind = 'overdue';
  } else if (daysRemaining === 0) {
    kind = 'due_today';
  }

  return {
    kind,
    orderId: String(order._id),
    orderName: orderDisplayTitle(order),
    invoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber || '',
    installmentNumber: invoice.installmentNumber || null,
    amountDue,
    dueDate: due.toISOString(),
    daysRemaining: Math.max(0, daysRemaining),
    daysOverdue: msDiff < 0 ? Math.max(1, Math.ceil(Math.abs(msDiff) / DAY)) : 0,
    ribbonWindowDays,
    isServicePlan: Boolean(order.isServicePlan),
    isPaused: Boolean(isPaused),
    isExpired: Boolean(isExpired),
    deactivationDaysRemaining,
  };
}

module.exports = {
  DEFAULT_RIBBON_WINDOW_DAYS,
  loadBeforeDueRules,
  resolveRibbonWindowDays,
  buildPaymentDueAlert,
};
