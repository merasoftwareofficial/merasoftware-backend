const { test } = require('node:test');
const assert = require('node:assert/strict');
const { packageReminderCandidate } = require('../helpers/packageReminderEligibility');
const { planPackageRuns } = require('../helpers/packageReminderSchedule');

const order = () => ({ _id: 'order-1', isServicePlan: true, salesPackage: { package: { id: 'monthly-package' } },
  orderVisibility: 'approved', servicePlanStatus: 'active', serviceCurrentCycleNumber: 1, serviceTotalCycles: 3,
  serviceNextBillingDate: new Date('2026-12-01T00:00:00Z'), serviceCyclePrice: 3000 });
const invoice = () => ({ _id: 'invoice-1', orderId: 'order-1', invoiceType: 'plan_renewal', serviceCycleNumber: 2,
  dueDate: new Date('2026-12-01T00:00:00Z'), amount: 3000, amountPaid: 1000, status: 'partially_paid' });

test('same cycle changes from a projection to its actual outstanding invoice', () => {
  const projected = packageReminderCandidate(order());
  assert.equal(projected.cycle, 2); assert.equal(projected.amount, 3000); assert.equal(projected.projected, true);
  const actual = packageReminderCandidate({ ...order(), servicePlanStatus: 'paused' }, invoice());
  assert.equal(actual.cycle, projected.cycle); assert.equal(actual.amount, 2000); assert.equal(actual.projected, false);
});
test('settled, cancelled, wrong-order and non-renewal invoices never become debt reminders', () => {
  assert.equal(packageReminderCandidate(order(), { ...invoice(), status: 'paid' }), null);
  assert.equal(packageReminderCandidate(order(), { ...invoice(), amountPaid: 3000 }), null);
  assert.equal(packageReminderCandidate(order(), { ...invoice(), orderId: 'other' }), null);
  assert.equal(packageReminderCandidate(order(), { ...invoice(), invoiceType: 'project' }), null);
  assert.equal(packageReminderCandidate({ ...order(), orderVisibility: 'cancelled' }, invoice()), null);
});
test('stopped renewal prevents new cycle reminders but existing debt remains eligible', () => {
  const stopped = { ...order(), serviceAutoRenewalStoppedAt: new Date() };
  assert.equal(packageReminderCandidate(stopped), null);
  assert.equal(packageReminderCandidate(stopped, invoice()).amount, 2000);
});
test('final cycle, unrelated plan and legacy offer-policy order do not create new candidates', () => {
  assert.equal(packageReminderCandidate({ ...order(), serviceCurrentCycleNumber: 3 }), null);
  assert.equal(packageReminderCandidate({ ...order(), salesPackage: undefined }), null);
  assert.equal(packageReminderCandidate({ ...order(), paymentPolicy: { reminderOffsets: [-1] } }), null);
  assert.equal(packageReminderCandidate({ ...order(), paymentPolicy: { reminderOffsets: [-1] } }, invoice()), null);
});
test('planning is opt-in, prospective and keeps invoice and projection under the same identity', () => {
  const service = { ...order(), userId: 'client-1' };
  const rule = { _id: 'rule-1', revision: 1, enabled: true, source: 'monthly_package', activatedAt: new Date('2026-11-29T00:00:00Z'), steps: [
    { offsetDays: -3, subject: 'Soon', text: 'Hello', channel: 'whatsapp' },
    { offsetDays: 0, subject: 'Due', text: 'Hello', channel: 'email' },
  ] };
  const projected = planPackageRuns(rule, service);
  assert.equal(projected.length, 1, 'step before activation is not backfilled');
  assert.equal(projected[0].step, 1);
  assert.equal(projected[0].occurrenceKey, 'order-1:2');
  const actual = planPackageRuns(rule, { ...service, servicePlanStatus: 'paused' }, invoice());
  assert.equal(actual[0].occurrenceKey, projected[0].occurrenceKey);
  assert.deepEqual(planPackageRuns({ ...rule, enabled: false }, service), []);
  assert.deepEqual(planPackageRuns({ ...rule, activatedAt: new Date('2026-12-02') }, service), []);
});
