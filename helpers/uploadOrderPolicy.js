const { getUploadKind, UPLOAD_KIND } = require('./uploadType');
const { assertProjectAcceptsUpload } = require('./projectUploadGate');
const limits = require('../config/uploadLimits');
const reject = message => { throw Object.assign(new Error(message), { status: 400 }); };

// One order/allowance validation policy for legacy, staged and final acceptance.
async function assertUploadOrder(order, { fileCount, serviceOrderId }) {
  if (!order) reject('Upload order not found');
  const kind = getUploadKind(order);
  const isServiceUpload = kind === UPLOAD_KIND.SERVICE;
  const isProjectUpload = kind === UPLOAD_KIND.PROJECT;
  const isLegacyUpload = kind === UPLOAD_KIND.LEGACY;
  if (isServiceUpload) {
    const s = order.servicePlanSnapshot || {};
    if (String(serviceOrderId || '') !== String(order._id)) reject('Selected service is required');
    if (s.capability !== 'upload_data' && s.serviceBehavior !== 'portal_access_control') reject('This service does not allow data upload');
    if (order.servicePlanStatus !== 'active') reject('This service is not active');
    if (s.limitScope !== 'unlimited' && Number(order.serviceAccessUsedInCycle || 0) >= Number(s.portalAccessCount || 0)) reject('Selected service upload limit is used');
    if (fileCount > Math.min(limits.MAX_SERVICE_FILES_PER_UPLOAD, Number(s.filesLimit || 0))) reject('Too many files for the selected service');
  } else if (isProjectUpload) {
    const refusal = await assertProjectAcceptsUpload(order);
    if (refusal) reject(refusal);
    if (fileCount > limits.MAX_PROJECT_FILES_PER_UPLOAD) reject('Too many files for one upload');
  } else if (fileCount > limits.MAX_LEGACY_UPDATE_FILES_PER_UPLOAD) reject('Too many files for one upload');
  if (order.planStatus === 'closed') reject('This plan has been closed and cannot accept updates');
  if (order.autoRenewalStatus === 'paused') reject('This plan is paused because an invoice payment is overdue');
  if (!order.isActive) reject('This plan is not active and cannot accept updates');
  if (isLegacyUpload) {
    const p = order.productId;
    if (!p || Number(order.updatesUsed || 0) >= Number(p.updateCount || 0)) reject('No updates remaining in this plan');
    if (p.isMonthlyLimitedPlan) {
      const cap = order.currentMonthUpdatesLimit || p.monthlyUpdateLimit || 1;
      if (Number(order.currentMonthUpdatesUsed || 0) >= cap) reject('Monthly upload allowance is used');
      if (order.currentMonthExpiryDate && new Date() > order.currentMonthExpiryDate) reject('Your monthly period has expired');
      if (order.totalYearlyDaysRemaining !== undefined && order.totalYearlyDaysRemaining <= 0) reject('Your yearly plan has ended');
    } else if (!p.isMonthlyRenewablePlan) {
      const expiry = new Date(order.createdAt);
      expiry.setDate(expiry.getDate() + p.validityPeriod);
      if (new Date() > expiry) reject('Update plan has expired');
    }
  }
  return { kind, isServiceUpload, isProjectUpload, isLegacyUpload };
}
module.exports = { assertUploadOrder };
