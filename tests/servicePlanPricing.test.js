// Pricing SSOT (helpers/servicePlanPricing.js), Flexible Plans Phase 1 step P2b
// (merasoftware/src/docs/plan.md §4 "Price"). Pure: no database.
// Numbers: the approved builder prototype (₹100 / ₹50 / ₹35 slabs) and the 3 live plans.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  updatePriceForFiles, quoteServicePlan, priceRange, assertPricingConfig, cyclePriceFromMonthly,
} = require('../helpers/servicePlanPricing');

const flexible = (extra = {}) => ({
  price: 0,
  servicePlan: {
    capability: 'upload_data', pricingMode: 'flexible',
    files: { min: 5, max: 100, step: 5 }, ratePerFile: 100,
    slabs: [{ fromFile: 11, ratePerFile: 50 }, { fromFile: 21, ratePerFile: 35 }],
    updatesPerMonth: { min: 1, max: 4 }, allowOneTime: true,
    billingOptions: [
      { billingCycle: 'monthly', discountPercent: 0 },
      { billingCycle: 'quarterly', discountPercent: 5 },
      { billingCycle: 'half_yearly', discountPercent: 10 },
    ],
    ...extra,
  },
});
// The live catalogue as audited 27 Oct 2026 (no Flexible Plans fields yet → fixed).
const starter = {
  price: 1490,
  servicePlan: {
    capability: 'upload_data', purchaseType: 'recurring', limitScope: 'per_month', portalAccessCount: 1, filesLimit: 20,
    monthlyReferencePrice: 1490,
    billingOptions: [
      { billingCycle: 'monthly', discountPercent: 0, pricePerCycle: 1490 },
      { billingCycle: 'quarterly', discountPercent: 3, pricePerCycle: 4335.9 },
      { billingCycle: 'half_yearly', discountPercent: 5, pricePerCycle: 8493 },
      { billingCycle: 'yearly', discountPercent: 8, pricePerCycle: 16449.600000000002 },
    ],
  },
};
const singlePage = { price: 1500, servicePlan: { capability: 'upload_data', purchaseType: 'one_time', limitScope: 'per_plan', portalAccessCount: 5, filesLimit: 20 } };
const liveChat = { price: 2500, servicePlan: { capability: 'send_reminders', purchaseType: 'one_time' } };

test('slabs are marginal: prototype prices per update', () => {
  const sp = flexible().servicePlan;
  assert.equal(updatePriceForFiles(sp, 5), 500);
  assert.equal(updatePriceForFiles(sp, 10), 1000);
  assert.equal(updatePriceForFiles(sp, 20), 1500);
  assert.equal(updatePriceForFiles(sp, 100), 4300);
  assert.equal(updatePriceForFiles({ ratePerFile: 40 }, 7), 280);
});

test('flexible recurring: files × updates × months − discount, whole rupees', () => {
  const quote = quoteServicePlan(flexible(), { purchase: 'quarterly', tenureMonths: 6, files: 20, updates: 2 });
  assert.equal(quote.updatePrice, 1500);
  assert.equal(quote.perMonthPrice, 3000);
  assert.equal(quote.subtotal, 9000);
  assert.equal(quote.discount, 450);
  assert.equal(quote.cyclePrice, 8550);
  assert.equal(quote.totalCycles, 2);
  assert.equal(quote.totalPrice, 17100);
  assert.equal(quote.allowancePerCycle, 6); // 2 a month × 3 months, all at once by default
  assert.equal(quote.releaseMode, 'all_at_once');
});

test('flexible one-time: update price × number of updates, 90-day default validity', () => {
  const quote = quoteServicePlan(flexible(), { purchase: 'one_time', files: 50, updates: 3 });
  assert.equal(quote.updatePrice, 2550);
  assert.equal(quote.totalPrice, 7650);
  assert.equal(quote.allowancePerCycle, 3);
  assert.equal(quote.validityDays, 90);
  assert.equal(quoteServicePlan(flexible({ oneTimeValidityDays: 30 }), { purchase: 'one_time', files: 5, updates: 1 }).validityDays, 30);
});

test('flexible choices outside the plan are refused', () => {
  const plan = flexible();
  assert.throws(() => quoteServicePlan(plan, { purchase: 'monthly', tenureMonths: 1, files: 7, updates: 1 }), /5 to 100 files/);
  assert.throws(() => quoteServicePlan(plan, { purchase: 'monthly', tenureMonths: 1, files: 105, updates: 1 }), /5 to 100 files/);
  assert.throws(() => quoteServicePlan(plan, { purchase: 'monthly', tenureMonths: 1, files: 10, updates: 5 }), /1 to 4 updates/);
  assert.throws(() => quoteServicePlan(plan, { purchase: 'yearly', tenureMonths: 12, files: 10, updates: 1 }), /not available/);
  assert.throws(() => quoteServicePlan(plan, { purchase: 'quarterly', tenureMonths: 4, files: 10, updates: 1 }), /whole number/);
  assert.throws(() => quoteServicePlan(flexible({ allowOneTime: false }), { purchase: 'one_time', files: 10, updates: 1 }), /one-time/);
});

test('length cap: plan maximum, never above 12 months', () => {
  assert.throws(() => quoteServicePlan(flexible({ maxTenureMonths: 3 }), { purchase: 'monthly', tenureMonths: 6, files: 5, updates: 1 }), /at most 3 months/);
  assert.equal(quoteServicePlan(flexible(), { purchase: 'half_yearly', tenureMonths: 12, files: 5, updates: 1 }).totalCycles, 2);
  assert.throws(() => quoteServicePlan(flexible(), { purchase: 'monthly', tenureMonths: 13, files: 5, updates: 1 }), /whole number|at most 12/);
});

test('release mode: plan default; customer may change it only when allowed', () => {
  const choice = { purchase: 'quarterly', tenureMonths: 3, files: 5, updates: 2 };
  assert.throws(() => quoteServicePlan(flexible(), { ...choice, releaseMode: 'monthly' }), /release/);
  assert.equal(quoteServicePlan(flexible({ releaseMode: 'monthly' }), choice).releaseMode, 'monthly');
  assert.equal(quoteServicePlan(flexible({ customerCanChooseRelease: true }), { ...choice, releaseMode: 'monthly' }).releaseMode, 'monthly');
});

test('live Starter Update Plan (fixed): rounded prices, 1 update per month for every month', () => {
  assert.equal(quoteServicePlan(starter, { purchase: 'monthly', tenureMonths: 1 }).cyclePrice, 1490);
  const quarterly = quoteServicePlan(starter, { purchase: 'quarterly', tenureMonths: 6 });
  assert.equal(quarterly.cyclePrice, 4336);
  assert.equal(quarterly.allowancePerCycle, 3);
  assert.equal(quarterly.files, 20);
  assert.equal(quoteServicePlan(starter, { purchase: 'half_yearly', tenureMonths: 6 }).cyclePrice, 8493);
  const yearly = quoteServicePlan(starter, { purchase: 'yearly', tenureMonths: 12 });
  assert.equal(yearly.cyclePrice, 16450);
  assert.equal(yearly.allowancePerCycle, 12);
  assert.throws(() => quoteServicePlan(starter, { purchase: 'one_time' }), /one-time/);
});

test('live one-time plans (fixed): own price, own allowance, reminder plan has none', () => {
  const page = quoteServicePlan(singlePage, { purchase: 'one_time' });
  assert.deepEqual([page.totalPrice, page.allowancePerCycle, page.files, page.validityDays], [1500, 5, 20, 90]);
  const chat = quoteServicePlan(liveChat, { purchase: 'one_time' });
  assert.deepEqual([chat.totalPrice, chat.allowancePerCycle, chat.files], [2500, null, null]);
});

test('card price range', () => {
  assert.deepEqual(priceRange(flexible()), { unit: 'update', from: 500, to: 4300 });
  assert.deepEqual(priceRange(starter), { unit: 'month', from: 1490, to: 1490 });
  assert.deepEqual(priceRange(singlePage), { unit: 'one_time', from: 1500, to: 1500 });
});

test('B8: monthly price × months − discount is whole rupees', () => {
  assert.equal(cyclePriceFromMonthly(1490, 3, 3), 4336);
  assert.equal(cyclePriceFromMonthly(1490, 12, 8), 16450);
});

test('config rules for saving a plan', () => {
  assert.doesNotThrow(() => assertPricingConfig(flexible()));
  assert.doesNotThrow(() => assertPricingConfig(starter));
  const bad = (extra, pattern) => assert.throws(() => assertPricingConfig(flexible(extra)), pattern);
  bad({ files: { min: 5, max: 120, step: 5 } }, /at most 100/);
  bad({ files: { min: 5, max: 100, step: 7 } }, /step/);
  bad({ files: { min: 20, max: 10, step: 1 } }, /minimum and maximum/);
  bad({ slabs: [{ fromFile: 1, ratePerFile: 50 }] }, /slab/);
  bad({ slabs: [{ fromFile: 150, ratePerFile: 50 }] }, /slab/);
  bad({ updatesPerMonth: { min: 3, max: 2 } }, /Updates per month/);
  bad({ maxTenureMonths: 24 }, /1 to 12/);
  bad({ billingOptions: [{ billingCycle: 'every_2_years', discountPercent: 0 }] }, /billing option/);
  bad({ allowOneTime: false, billingOptions: [] }, /one-time/);
  bad({ capability: 'send_reminders' }, /collects data/);
  bad({ ratePerFile: 0, slabs: [] }, /more than zero/);
});
