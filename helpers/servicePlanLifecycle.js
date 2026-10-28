// SSOT for taking a service plan off sale and back (merasoftware/src/docs/plan.md §2):
// retire / restore / delete forever / hide / unhide. The website plan catalogue
// (PATCH /api/admin/plan-catalogue { action }) and the older portal routes
// (controller/product/retireOrDeletePlan.js, reactivatePlan.js, purgePlan.js, hideProduct.js,
// unhideProduct.js) all call these, so the rules live in one place.
//
// Rules (unchanged from the portal routes they came from):
//   retire  -> 0 purchases: the row is deleted; 1+ purchases: retiredAt + hidden, row kept for ever
//              (orders keep their own snapshot, so history never blanks out).
//   restore -> a retired plan back to the active list and on sale.
//   purge   -> only a retired plan: archive (default, recoverable) or hard delete with the plan's
//              exact name typed.
//   hide / unhide -> not while retired; it is the retire lifecycle that owns isHidden then.
//
// Flexible plans were held hidden until the customer plan builder existed (owner, 28 Oct 2026):
// the old portal purchase pages showed the stored per-cycle price, which a flexible plan does
// not have. Phase 2b ships the builder, so the switch is on. Put a flexible plan on sale only
// after the Phase 2b portal is deployed (deploy order backend → website → portal).
const productModel = require('../models/productModel');
const orderModel = require('../models/orderProductModel');
const { assertRevision, saveRevision, deleteRevision, revisionFilter, nextTime, conflict } = require('./catalogueRevision');

const FLEXIBLE_PLANS_ON_SALE = true;

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

const isFlexiblePlan = (product) => Boolean(product?.isServicePlan && product?.servicePlan?.pricingMode === 'flexible');
const canBeOnSale = (product) => FLEXIBLE_PLANS_ON_SALE || !isFlexiblePlan(product);
function assertCanBeOnSale(product) {
  if (!canBeOnSale(product)) fail('A flexible plan stays hidden until the new customer plan builder is live', 409);
}

async function findPlan(planId) {
  if (!planId) fail('Plan ID is required');
  const plan = await productModel.findById(planId).catch(() => null);
  if (!plan) fail('Plan not found', 404);
  return plan;
}

async function retirePlan({ planId, actorId, expectedUpdatedAt }) {
  const plan = await findPlan(planId);
  assertRevision(plan, expectedUpdatedAt);
  if (plan.retiredAt) fail('This plan is already retired', 409);
  // Counted against real orders; the client never says how many customers a plan has.
  const purchaseCount = await orderModel.countDocuments({ productId: plan._id });
  if (purchaseCount === 0) {
    await deleteRevision(productModel, plan, expectedUpdatedAt);
    return { message: `"${plan.serviceName}" deleted`, data: { action: 'deleted', planId: plan._id, purchaseCount: 0 } };
  }
  plan.retiredAt = new Date();
  plan.retiredBy = actorId;
  plan.isHidden = true;
  await saveRevision(plan, expectedUpdatedAt);
  return {
    message: `"${plan.serviceName}" retired — ${purchaseCount} existing purchase${purchaseCount === 1 ? '' : 's'} kept intact`,
    data: { action: 'retired', planId: plan._id, purchaseCount },
  };
}

async function restorePlan({ planId, expectedUpdatedAt }) {
  const plan = await findPlan(planId);
  assertRevision(plan, expectedUpdatedAt);
  if (!plan.retiredAt) fail('This plan is not retired', 409);
  plan.retiredAt = null;
  plan.retiredBy = null;
  // Restore puts the plan back on sale, except a flexible plan before the builder is live.
  plan.isHidden = !canBeOnSale(plan);
  await saveRevision(plan, expectedUpdatedAt);
  return {
    message: plan.isHidden
      ? `"${plan.serviceName}" restored to Active Plans (kept hidden: flexible plans go on sale with the new builder)`
      : `"${plan.serviceName}" restored to Active Plans and back on sale`,
    data: { planId: plan._id, isHidden: plan.isHidden },
  };
}

async function purgePlan({ planId, mode, confirmName, actorId, expectedUpdatedAt }) {
  const plan = await findPlan(planId);
  assertRevision(plan, expectedUpdatedAt);
  if (!plan.retiredAt) fail('Only a retired plan can be deleted forever. Remove it first.', 409);
  if (plan.archivedAt) fail('This plan has already been deleted', 409);
  const purchaseCount = await orderModel.countDocuments({ productId: plan._id });
  if (mode === 'hard') {
    if (String(confirmName || '').trim() !== String(plan.serviceName || '').trim()) fail("Type the plan's exact name to permanently delete it");
    await deleteRevision(productModel, plan, expectedUpdatedAt);
    return { message: `"${plan.serviceName}" permanently deleted from the database`, data: { action: 'hard_deleted', planId: plan._id, purchaseCount } };
  }
  plan.archivedAt = new Date();
  plan.archivedBy = actorId;
  await saveRevision(plan, expectedUpdatedAt);
  return { message: `"${plan.serviceName}" deleted`, data: { action: 'archived', planId: plan._id, purchaseCount } };
}

// Any catalogue product (feature products use the same routes).
async function setProductHidden({ productId, hidden, expectedUpdatedAt }) {
  if (!productId) fail('Product ID is required');
  const existing = await productModel.findById(productId).select('retiredAt archivedAt isServicePlan servicePlan.pricingMode updatedAt').catch(() => null);
  if (!existing) fail('Product not found', 404);
  if (existing.retiredAt || existing.archivedAt) fail('This plan is retired. Restore it before changing its availability.');
  assertRevision(existing, expectedUpdatedAt);
  if (!hidden) assertCanBeOnSale(existing);
  const updated = await productModel.findOneAndUpdate(revisionFilter(existing), { isHidden: Boolean(hidden), updatedAt: nextTime(existing) }, { new: true, timestamps: false });
  if (!updated) throw conflict();
  return updated;
}

module.exports = { FLEXIBLE_PLANS_ON_SALE, canBeOnSale, assertCanBeOnSale, retirePlan, restorePlan, purgePlan, setProductHidden };
