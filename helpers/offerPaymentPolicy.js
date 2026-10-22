const Invoice = require('../models/invoiceModel');
const { getDueUnpaidInvoiceFilter } = require('./projectDuePayment');

const MODES = ['advance', 'limited_uploads', 'pay_later'];
const DAY = 86400000;
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

function freezePaymentPolicy(offer, now = new Date()) {
  const raw = offer?.paymentPolicy;
  if (!raw || raw.mode === 'current') return null;
  if (!MODES.includes(raw.mode)) fail('Invalid offer payment policy');
  if (!['first_purchase', 'every_cycle'].includes(raw.cycleScope)) fail('Select the payment-policy billing cycles');
  if (!Number.isInteger(raw.dueDays) || raw.dueDays < 0 || raw.dueDays > 365) fail('Payment due days must be between 0 and 365');
  if (raw.mode === 'limited_uploads' && (!Number.isInteger(raw.uploadAllowance) || raw.uploadAllowance < 1 || raw.uploadAllowance > 10000)) fail('Enter a valid pre-payment upload allowance');
  if (!Array.isArray(raw.reminderOffsets) || raw.reminderOffsets.length > 10 || raw.reminderOffsets.some(n => !Number.isInteger(n) || n < -365 || n > 365)) fail('Enter valid reminder days relative to the due date');
  return { version: 1, offerSlug: offer.slug, offerTitle: offer.title, appliedAt: now,
    mode: raw.mode, dueDays: raw.dueDays, cycleScope: raw.cycleScope,
    uploadAllowance: raw.mode === 'limited_uploads' ? raw.uploadAllowance : 0,
    reminderOffsets: [...new Set(raw.reminderOffsets)].sort((a, b) => a - b) };
}
function modeForCycle(order, cycle = order.serviceCurrentCycleNumber || 1) {
  const policy = order.paymentPolicy;
  if (!policy) return 'current';
  return order.isServicePlan && cycle > 1 && policy.cycleScope !== 'every_cycle' ? 'advance' : policy.mode;
}
const allowsDeferredPayment = policy => ['limited_uploads', 'pay_later'].includes(policy?.mode);
const paymentDueDate = (policy, start = new Date()) => new Date(new Date(start).getTime() + Number(policy?.dueDays || 0) * DAY);

// Payment permission only. Lifecycle, ownership, capability and original quotas
// continue to be enforced by uploadOrderPolicy / projectUploadGate.
async function getPaymentAccess(order, { session = null } = {}) {
  if (!order.paymentPolicy) return null;
  const mode = modeForCycle(order);
  const filter = order.isServicePlan
    ? { orderId: order._id, invoiceType: { $in: ['project', 'plan_renewal'] }, status: { $in: ['unpaid', 'partially_paid', 'overdue'] } }
    : { ...getDueUnpaidInvoiceFilter(order), invoiceType: 'project', status: { $in: ['unpaid', 'partially_paid', 'overdue'] } };
  let query = Invoice.find(filter).select('amount amountPaid dueDate serviceCycleNumber');
  if (session) query = query.session(session);
  const invoices = await query.lean();
  const unpaid = invoices.filter(row => Number(row.amount) > Number(row.amountPaid || 0));
  // Later installment invoices are normally created only when money arrives.
  // The payment gate must still see an installment that has become due.
  if (!order.isServicePlan && order.isPartialPayment && filter.installmentNumber !== -1 && !unpaid.length) {
    const target = order.installments?.find(item => item.installmentNumber === order.currentInstallment && !item.paid);
    if (target && Number(target.amount) > 0) unpaid.push({ amount: target.amount, dueDate: target.dueDate || paymentDueDate(order.paymentPolicy, order.paymentPolicy.appliedAt) });
  }
  const used = Number(order.isServicePlan ? order.serviceAccessUsedInCycle : order.paymentPolicyUploads) || 0;
  const allowance = Number(order.paymentPolicy.uploadAllowance || 0);
  const due = unpaid.map(row => row.dueDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null;
  const paymentPending = unpaid.length > 0;
  const allowed = !paymentPending || mode === 'pay_later' || (mode === 'limited_uploads' && used < allowance);
  return { mode, allowed, paymentPending, dueDate: due, overdue: !!due && new Date(due) < new Date(),
    uploadsRemaining: mode === 'limited_uploads' && paymentPending ? Math.max(0, allowance - used) : null,
    reason: allowed ? null : mode === 'limited_uploads' ? 'Your pre-payment upload allowance is used. Pay the required bill to continue.' : 'Payment is required before uploading data.' };
}

function policyLines(order) {
  const p = order?.paymentPolicy;
  if (!p) return [];
  return [`Payment offer: ${p.offerTitle}`, `Payment timing: ${p.mode.replaceAll('_', ' ')}`,
    ...(p.mode === 'limited_uploads' ? [`Uploads before required payment: ${p.uploadAllowance}`] : []),
    `Payment due: ${p.dueDays} day(s) after project creation / service-cycle start`,
    ...(order.isServicePlan ? [`Applies to: ${p.cycleScope === 'every_cycle' ? 'every billing cycle' : 'first purchase only'}`] : [])];
}
module.exports = { freezePaymentPolicy, allowsDeferredPayment, modeForCycle, paymentDueDate, getPaymentAccess, policyLines, DAY };
