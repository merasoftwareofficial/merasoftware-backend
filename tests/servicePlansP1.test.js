// Flexible Plans P1 (merasoftware/src/docs/plan.md §3 B2–B4):
//   B3 renewal bills the order's frozen serviceCyclePrice (snapshot option only as fallback),
//   B4 a recurring service is sold for at most 12 months (enforced by the backend),
//   B2 the admin client workspace counts plans and projects apart.
// Isolated: in-memory MongoDB, no mail / Drive / WhatsApp.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const userModel = require('../models/userModel');
const orderModel = require('../models/orderProductModel');
const invoiceModel = require('../models/invoiceModel');
const { resolveServiceRenewalPrice } = require('../helpers/serviceBillingSchedule');
const { resolvePurchase, MAX_SERVICE_TENURE_MONTHS } = require('../helpers/servicePlanPurchase');
const { processServicePlanRenewals } = require('../cron/servicePlanRenewalCron');
const getAdminUserWorkspace = require('../controller/user/getAdminUserWorkspace');

const NOW = new Date('2026-10-27T10:00:00+05:30');
const days = (n) => new Date(NOW.getTime() + n * 86400000);
const id = () => new mongoose.Types.ObjectId();
const snapshot = (pricePerCycle) => ({ serviceName: 'Starter Update Plan', billingOptions: [{ billingCycle: 'monthly', pricePerCycle }] });
let database;

before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri(), { dbName: 'service-plans-p1' });
});
after(async () => { await mongoose.disconnect(); await database?.stop(); });

test('renewal price: frozen order price wins over the snapshot option', () => {
  assert.equal(resolveServiceRenewalPrice({ serviceCyclePrice: 1000, serviceSelectedBillingCycle: 'monthly', servicePlanSnapshot: snapshot(1490) }), 1000);
});

test('renewal price: order without serviceCyclePrice falls back to its snapshot option', () => {
  assert.equal(resolveServiceRenewalPrice({ serviceSelectedBillingCycle: 'monthly', servicePlanSnapshot: snapshot(1490) }), 1490);
  assert.equal(resolveServiceRenewalPrice({ serviceCyclePrice: 0, serviceSelectedBillingCycle: 'monthly', servicePlanSnapshot: snapshot(1490) }), 1490);
});

test('renewal price: nothing to bill gives 0', () => {
  assert.equal(resolveServiceRenewalPrice({ serviceSelectedBillingCycle: 'yearly', servicePlanSnapshot: snapshot(1490) }), 0);
  assert.equal(resolveServiceRenewalPrice({}), 0);
});

test('tenure: up to 12 months is accepted, longer is refused', () => {
  const servicePlan = { billingOptions: [{ billingCycle: 'monthly', pricePerCycle: 1490 }, { billingCycle: 'yearly', pricePerCycle: 16450 }, { billingCycle: 'every_2_years', pricePerCycle: 30000 }] };
  assert.equal(MAX_SERVICE_TENURE_MONTHS, 12);
  // The tenure rule now lives in the quote (servicePlanPricing.js), reached through resolvePurchase().
  const plan = { _id: 'p1', price: 1490, servicePlan: { ...servicePlan, monthlyReferencePrice: 1490 } };
  const buy = (selectedBillingCycle, tenureMonths) => resolvePurchase(plan, { selectedBillingCycle, tenureMonths });
  assert.equal(buy('monthly', 12).billingSelection.totalCycles, 12);
  assert.equal(buy('yearly', 12).billingSelection.totalCycles, 1);
  assert.throws(() => buy('monthly', 24), /at most 12 months/);
  assert.throws(() => buy('yearly', 36), /at most 12 months/);
  assert.throws(() => buy('every_2_years', 24), /not available/);
});

test('renewal cron bills the frozen order price, not the snapshot option', async () => {
  const customer = await userModel.create({ name: 'Ravi', email: 'ravi-p1@example.test', password: 'x', role: 'customer' });
  const base = { userId: customer._id, price: 1490, isServicePlan: true, servicePlanStatus: 'active', serviceNextBillingDate: days(-1),
    serviceSelectedBillingCycle: 'monthly', serviceBillingCycleMonths: 1, serviceTotalCycles: 6, serviceCurrentCycleNumber: 1,
    serviceCurrentCycleEnd: days(-1), servicePlanSnapshot: snapshot(1490), orderItems: [{ name: 'Starter Update Plan', price: 1490 }] };
  const [frozen, legacy] = await orderModel.collection.insertMany([
    { ...base, serviceCyclePrice: 1000 },
    { ...base },
  ]).then((result) => Object.values(result.insertedIds));

  await processServicePlanRenewals(NOW);

  const bill = async (orderId) => invoiceModel.findOne({ orderId, invoiceType: 'plan_renewal' }).lean();
  assert.equal((await bill(frozen)).amount, 1000);
  assert.equal((await bill(legacy)).amount, 1490);
});

test('admin workspace counts plans and projects apart', async () => {
  const customer = await userModel.create({ name: 'Asha', email: 'asha-p1@example.test', password: 'x', role: 'customer' });
  await orderModel.collection.insertMany([
    { userId: customer._id, isWebsiteProject: true, orderVisibility: 'approved', projectProgress: 40, createdAt: days(-10) },
    { userId: customer._id, isServicePlan: true, orderVisibility: 'approved', servicePlanStatus: 'active', createdAt: days(-5) },
    { userId: customer._id, isServicePlan: true, orderVisibility: 'approved', servicePlanStatus: 'expired', createdAt: days(-3) },
  ]);

  let body;
  const res = { status() { return this; }, json(payload) { body = payload; return this; } };
  await getAdminUserWorkspace({ userRole: 'admin', query: { customerId: String(customer._id) } }, res);

  assert.equal(body.success, true, body.message);
  const { summary } = body.data;
  assert.equal(summary.totalOrders, 3);
  assert.equal(summary.activePlans, 1);
  // Only the project is counted in the project buckets; the expired plan is not "completed work".
  assert.equal(summary.activeOrders + summary.pendingOrders + summary.completedOrders + summary.rejectedOrders, 1);
});
