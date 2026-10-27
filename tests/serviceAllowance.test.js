// "Allowed right now" SSOT (helpers/serviceAllowance.js), Flexible Plans Phase 1 step P2d-1
// (merasoftware/src/docs/plan.md §2, Q1). Pure: no database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uploadAllowanceNow, reservationExpr } = require('../helpers/serviceAllowance');

const start = new Date('2026-01-10T00:00:00Z');
const at = (iso) => new Date(iso);

test('existing orders read exactly as before: snapshot count minus used', () => {
  const order = { servicePlanSnapshot: { limitScope: 'per_month', portalAccessCount: 1 }, serviceAccessUsedInCycle: 0 };
  assert.deepEqual(uploadAllowanceNow(order), { unlimited: false, limit: 1, used: 0, remaining: 1, cycleLimit: 1, nextReleaseAt: null });
  assert.equal(uploadAllowanceNow({ ...order, serviceAccessUsedInCycle: 1 }).remaining, 0);
  // Legacy-origin order seen in production: used total above the allowance never goes negative.
  assert.equal(uploadAllowanceNow({ servicePlanSnapshot: { portalAccessCount: 2 }, serviceAccessUsedInCycle: 7 }).remaining, 0);
});

test('unlimited has nothing to count and no reservation condition', () => {
  const order = { servicePlanSnapshot: { limitScope: 'unlimited' }, serviceAccessUsedInCycle: 50 };
  assert.equal(uploadAllowanceNow(order).unlimited, true);
  assert.equal(uploadAllowanceNow(order).remaining, null);
  assert.equal(reservationExpr(order), null);
});

test('all at once: the whole cycle is open from day one', () => {
  const order = { servicePlanSnapshot: { portalAccessCount: 6, updatesPerMonth: 2, releaseMode: 'all_at_once' }, serviceBillingCycleMonths: 3, serviceCurrentCycleStart: start, serviceAccessUsedInCycle: 0 };
  assert.equal(uploadAllowanceNow(order, at('2026-01-11T00:00:00Z')).limit, 6);
});

test('monthly release opens per month and carries unused uploads forward inside the cycle', () => {
  const order = { servicePlanSnapshot: { portalAccessCount: 6, updatesPerMonth: 2, releaseMode: 'monthly' }, serviceBillingCycleMonths: 3, serviceCurrentCycleStart: start, serviceAccessUsedInCycle: 0 };
  const month1 = uploadAllowanceNow(order, at('2026-01-20T00:00:00Z'));
  assert.deepEqual([month1.limit, month1.remaining], [2, 2]);
  assert.equal(month1.nextReleaseAt.toISOString(), '2026-02-10T00:00:00.000Z');
  // Nothing used in month 1 → month 2 has 4 available (carried forward).
  assert.equal(uploadAllowanceNow(order, at('2026-02-10T00:00:00Z')).remaining, 4);
  const month3 = uploadAllowanceNow({ ...order, serviceAccessUsedInCycle: 1 }, at('2026-03-15T00:00:00Z'));
  assert.deepEqual([month3.limit, month3.remaining, month3.nextReleaseAt], [6, 5, null]);
  // Never more than the cycle total, even long after.
  assert.equal(uploadAllowanceNow(order, at('2026-09-01T00:00:00Z')).limit, 6);
});

test('monthly release on a one-month cycle is the same as all at once', () => {
  const order = { servicePlanSnapshot: { portalAccessCount: 2, updatesPerMonth: 2, releaseMode: 'monthly' }, serviceBillingCycleMonths: 1, serviceCurrentCycleStart: start };
  assert.deepEqual([uploadAllowanceNow(order, at('2026-01-11T00:00:00Z')).limit, uploadAllowanceNow(order).nextReleaseAt], [2, null]);
});

test('reservation condition uses the limit allowed right now', () => {
  const order = { servicePlanSnapshot: { portalAccessCount: 6, updatesPerMonth: 2, releaseMode: 'monthly' }, serviceBillingCycleMonths: 3, serviceCurrentCycleStart: start };
  assert.deepEqual(reservationExpr(order, at('2026-01-20T00:00:00Z')), { $lt: [{ $ifNull: ['$serviceAccessUsedInCycle', 0] }, 2] });
  assert.deepEqual(reservationExpr({ servicePlanSnapshot: { portalAccessCount: 5 } }), { $lt: [{ $ifNull: ['$serviceAccessUsedInCycle', 0] }, 5] });
});
