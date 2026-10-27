// SSOT for what a service plan costs and what the customer gets for it
// (merasoftware/src/docs/plan.md §4 "Price"). The purchase, the quote routes, the admin
// plan form and the website cards all ask this module; no UI works out a final price.
//
// Two pricing modes:
//   fixed     -> the admin sets the price: a one-time price (plan.price) or a monthly price
//                (servicePlan.monthlyReferencePrice) with a discount per billing option.
//                Files and updates are fixed (servicePlan.filesLimit / portalAccessCount).
//                Every plan saved before Flexible Plans is read as fixed.
//   flexible  -> the customer picks files per update and updates per month; the price is
//                files × ratePerFile, cheaper per slab, × updates × months, − discount.
// Every amount is whole rupees.
const { MAX_SERVICE_FILES_PER_UPLOAD } = require('../config/uploadLimits');

const CYCLE_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
const MAX_TENURE_MONTHS = 12;
const DEFAULT_ONE_TIME_VALIDITY_DAYS = 90;

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const rupees = (amount) => Math.round(Number(amount) || 0);
const isWhole = (value) => Number.isInteger(Number(value));

const pricingMode = (servicePlan = {}) => (servicePlan.pricingMode === 'flexible' ? 'flexible' : 'fixed');

// One billing period's price from a monthly price: months × monthly price, less the discount.
const cyclePriceFromMonthly = (monthlyPrice, cycleMonths, discountPercent = 0) =>
  rupees(Number(monthlyPrice) * Number(cycleMonths) * (1 - Number(discountPercent || 0) / 100));

// Flexible: one update with `files` files. File 1 onwards costs ratePerFile; from each slab's
// fromFile onwards the slab rate applies instead (marginal, like tax bands).
function updatePriceForFiles(servicePlan, files) {
  const bands = [{ fromFile: 1, ratePerFile: Number(servicePlan.ratePerFile || 0) }, ...(servicePlan.slabs || [])
    .map((slab) => ({ fromFile: Number(slab.fromFile), ratePerFile: Number(slab.ratePerFile) }))]
    .sort((a, b) => a.fromFile - b.fromFile);
  let total = 0;
  bands.forEach((band, index) => {
    const nextFrom = bands[index + 1]?.fromFile ?? Infinity;
    const count = Math.max(0, Math.min(files, nextFrom - 1) - band.fromFile + 1);
    total += count * band.ratePerFile;
  });
  return rupees(total);
}

// Config rules for a plan's pricing; P2c's create/edit routes call this before saving.
function assertPricingConfig(plan) {
  const sp = plan.servicePlan || {};
  const isUpload = sp.capability === 'upload_data';
  const options = sp.billingOptions || [];
  const seen = new Set();
  options.forEach((option) => {
    if (!CYCLE_MONTHS[option.billingCycle] || seen.has(option.billingCycle)) fail('Each billing option must be monthly, quarterly, 6 months or yearly, and unique');
    const discount = Number(option.discountPercent || 0);
    if (!Number.isFinite(discount) || discount < 0 || discount >= 100) fail('Billing-option discount must be from 0 up to 99');
    seen.add(option.billingCycle);
  });
  if (sp.maxTenureMonths !== undefined && sp.maxTenureMonths !== null
    && (!isWhole(sp.maxTenureMonths) || sp.maxTenureMonths < 1 || sp.maxTenureMonths > MAX_TENURE_MONTHS)) {
    fail(`Maximum length must be 1 to ${MAX_TENURE_MONTHS} months`);
  }
  if (sp.oneTimeValidityDays !== undefined && sp.oneTimeValidityDays !== null && (!isWhole(sp.oneTimeValidityDays) || sp.oneTimeValidityDays < 1)) {
    fail('One-time validity must be at least 1 day');
  }
  if (sp.releaseMode !== undefined && sp.releaseMode !== null && !['all_at_once', 'monthly'].includes(sp.releaseMode)) fail('Choose a valid release mode');

  if (pricingMode(sp) === 'fixed') return;

  if (!isUpload) fail('Flexible pricing needs a plan that collects data (files per update)');
  const files = sp.files || {};
  const step = Number(files.step || 1);
  if (!isWhole(files.min) || !isWhole(files.max) || !isWhole(step) || files.min < 1 || step < 1 || files.max < files.min) fail('Files per update needs a valid minimum and maximum');
  if (files.max > MAX_SERVICE_FILES_PER_UPLOAD) fail(`Files per update can be at most ${MAX_SERVICE_FILES_PER_UPLOAD}`);
  if ((files.max - files.min) % step !== 0) fail('The file step must divide the range from minimum to maximum');
  if (!(Number(sp.ratePerFile) >= 0)) fail('Cost per file must be zero or more');
  let previous = 1;
  [...(sp.slabs || [])].sort((a, b) => a.fromFile - b.fromFile).forEach((slab) => {
    if (!isWhole(slab.fromFile) || slab.fromFile <= previous || slab.fromFile > files.max) fail('Each cheaper slab must start at a later file, inside the files range');
    if (!(Number(slab.ratePerFile) >= 0)) fail('Slab cost per file must be zero or more');
    previous = slab.fromFile;
  });
  const updates = sp.updatesPerMonth || {};
  if (!isWhole(updates.min) || !isWhole(updates.max) || updates.min < 1 || updates.max < updates.min) fail('Updates per month needs a valid minimum and maximum');
  if (!sp.allowOneTime && options.length === 0) fail('Allow one-time and/or at least one billing option');
  if (updatePriceForFiles(sp, files.min) <= 0) fail('The cheapest update must cost more than zero');
}

// Card price range for listings: one update at the fewest … most files (flexible), or the
// plan's own price (fixed: one-time price, or the monthly price of a recurring plan).
function priceRange(plan) {
  const sp = plan.servicePlan || {};
  if (pricingMode(sp) === 'flexible') {
    return { unit: 'update', from: updatePriceForFiles(sp, sp.files.min), to: updatePriceForFiles(sp, sp.files.max) };
  }
  if (sp.purchaseType === 'one_time') return { unit: 'one_time', from: rupees(plan.sellingPrice ?? plan.price), to: rupees(plan.sellingPrice ?? plan.price) };
  return { unit: 'month', from: rupees(sp.monthlyReferencePrice), to: rupees(sp.monthlyReferencePrice) };
}

// Updates the customer may use in one billing period (one-time: in the whole plan). null = no
// limit to count (unlimited or a reminder-only plan). A "per month" fixed plan gives its monthly
// count for every month of the period — a quarterly buyer of 1 update/month gets 3.
function allowanceFor(sp, { updates, cycleMonths, oneTime }) {
  if (sp.capability !== 'upload_data' || sp.limitScope === 'unlimited') return null;
  if (oneTime) return updates;
  if (pricingMode(sp) === 'fixed' && sp.limitScope !== 'per_month') return updates;
  return updates * cycleMonths;
}

// The one quote. `choice` = { purchase: 'one_time' | 'monthly' | 'quarterly' | 'half_yearly' |
// 'yearly', tenureMonths?, files?, updates?, releaseMode? }. Throws (400) on anything the plan
// does not allow, so a quote that comes back is always purchasable as-is.
function quoteServicePlan(plan, choice = {}) {
  const sp = plan.servicePlan || {};
  const mode = pricingMode(sp);
  const oneTime = choice.purchase === 'one_time';
  const isUpload = sp.capability === 'upload_data';

  let files = null;
  let updates = null;
  if (mode === 'flexible') {
    files = Number(choice.files);
    updates = Number(choice.updates);
    const step = Number(sp.files.step || 1);
    if (!isWhole(files) || files < sp.files.min || files > sp.files.max || (files - sp.files.min) % step !== 0) {
      fail(`Choose ${sp.files.min} to ${sp.files.max} files per update`);
    }
    if (!isWhole(updates) || updates < sp.updatesPerMonth.min || updates > sp.updatesPerMonth.max) {
      fail(`Choose ${sp.updatesPerMonth.min} to ${sp.updatesPerMonth.max} updates`);
    }
  } else if (isUpload) {
    files = Number(sp.filesLimit) || null;
    updates = sp.limitScope === 'unlimited' ? null : Number(sp.portalAccessCount) || null;
  }

  let releaseMode = sp.releaseMode || 'all_at_once';
  if (choice.releaseMode !== undefined && choice.releaseMode !== null && choice.releaseMode !== releaseMode) {
    if (!sp.customerCanChooseRelease || !['all_at_once', 'monthly'].includes(choice.releaseMode)) fail('This plan does not let you choose how updates are released');
    releaseMode = choice.releaseMode;
  }

  const updatePrice = mode === 'flexible' ? updatePriceForFiles(sp, files) : null;

  if (oneTime) {
    const allowed = mode === 'flexible' ? sp.allowOneTime : sp.purchaseType === 'one_time';
    if (!allowed) fail('This plan cannot be bought one-time');
    const total = mode === 'flexible' ? updatePrice * updates : rupees(plan.sellingPrice ?? plan.price);
    if (!(total > 0)) fail('This plan has no price. Please contact support.');
    return {
      pricingMode: mode, purchase: 'one_time', files, updates, updatePrice,
      cycleMonths: null, tenureMonths: null, totalCycles: 1, discountPercent: 0, discount: 0,
      subtotal: total, cyclePrice: total, totalPrice: total, firstPayment: total,
      allowancePerCycle: allowanceFor(sp, { updates, oneTime: true }), releaseMode: 'all_at_once',
      validityDays: Number(sp.oneTimeValidityDays) || DEFAULT_ONE_TIME_VALIDITY_DAYS,
    };
  }

  const cycleMonths = CYCLE_MONTHS[choice.purchase];
  const option = (sp.billingOptions || []).find((item) => item.billingCycle === choice.purchase);
  if (!cycleMonths || !option) fail('The selected billing option is not available for this plan');
  const maxTenure = Math.min(Number(sp.maxTenureMonths) || MAX_TENURE_MONTHS, MAX_TENURE_MONTHS);
  const tenureMonths = Number(choice.tenureMonths);
  if (!isWhole(tenureMonths) || tenureMonths < cycleMonths || tenureMonths % cycleMonths !== 0) fail('Total length must be a whole number of billing periods');
  if (tenureMonths > maxTenure) fail(`This plan can be bought for at most ${maxTenure} months`);

  const perMonth = mode === 'flexible' ? updatePrice * updates : Number(sp.monthlyReferencePrice || 0);
  const subtotal = rupees(perMonth * cycleMonths);
  const discountPercent = Number(option.discountPercent || 0);
  const cyclePrice = cyclePriceFromMonthly(perMonth, cycleMonths, discountPercent);
  if (!(cyclePrice > 0)) fail('This plan has no price. Please contact support.');
  const totalCycles = tenureMonths / cycleMonths;
  return {
    pricingMode: mode, purchase: choice.purchase, files, updates, updatePrice, perMonthPrice: rupees(perMonth),
    cycleMonths, tenureMonths, totalCycles, discountPercent, discount: subtotal - cyclePrice,
    subtotal, cyclePrice, totalPrice: cyclePrice * totalCycles, firstPayment: cyclePrice,
    allowancePerCycle: allowanceFor(sp, { updates, cycleMonths, oneTime: false }), releaseMode,
    validityDays: null,
  };
}

module.exports = {
  CYCLE_MONTHS,
  MAX_TENURE_MONTHS,
  DEFAULT_ONE_TIME_VALIDITY_DAYS,
  rupees,
  pricingMode,
  cyclePriceFromMonthly,
  updatePriceForFiles,
  assertPricingConfig,
  priceRange,
  quoteServicePlan,
};
