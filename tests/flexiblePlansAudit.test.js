const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { collectAudit, installWriteGuard } = require('../scripts/readOnlyAuditFlexiblePlans');

// Fixtures go in raw (no schema validation): the audit reads whatever production holds.
const id = () => new mongoose.Types.ObjectId();
const ids = { customer: id(), plan: id(), project: id(), quarterly: id(), monthly: id(), orphan: id(), deletedProduct: id() };
let database, db, report;
const COLLECTIONS = ['products', 'orders', 'updaterequests', 'monthlyinvoices', 'invoices', 'transactions'];
const counts = () => Promise.all(COLLECTIONS.map(name => db.collection(name).countDocuments()));
let countsBefore;

before(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri(), { dbName: 'flexible-plans-audit' });
  db = mongoose.connection.db;
  await db.collection('products').insertMany([
    { _id: ids.plan, serviceName: 'Starter Update Plan', category: 'service_plan', isServicePlan: true, sellingPrice: 1490,
      servicePlan: { planType: 'website_updates', capability: 'upload_data', purchaseType: 'recurring', limitScope: 'per_month', portalAccessCount: 1, filesLimit: 20,
        billingOptions: [{ billingCycle: 'monthly', discountPercent: 0, pricePerCycle: 1490 }, { billingCycle: 'quarterly', discountPercent: 3, pricePerCycle: 4335.9 }, { billingCycle: 'every_2_years', discountPercent: 10, pricePerCycle: 32184 }] } },
    { serviceName: 'Live Chat', category: 'feature_upgrades' },
  ]);
  await db.collection('orders').insertMany([
    // A project carries the default legacy counters too; it must NOT count as legacy.
    { _id: ids.project, userId: ids.customer, isWebsiteProject: true, updatesUsed: 0, currentMonthUpdatesUsed: 0 },
    { _id: ids.quarterly, userId: ids.customer, isServicePlan: true, servicePlanStatus: 'active', serviceSelectedBillingCycle: 'quarterly', serviceBillingCycleMonths: 3, serviceTenureMonths: 24, serviceCyclePrice: 4000,
      servicePlanSnapshot: { serviceName: 'Starter Update Plan', limitScope: 'per_month', billingOptions: [{ billingCycle: 'quarterly', pricePerCycle: 4335.9 }] } },
    { _id: ids.monthly, userId: ids.customer, isServicePlan: true, servicePlanStatus: 'paused', serviceSelectedBillingCycle: 'monthly', serviceBillingCycleMonths: 1, serviceTenureMonths: 6, serviceCyclePrice: 1490,
      servicePlanSnapshot: { serviceName: 'Starter Update Plan', limitScope: 'per_month', billingOptions: [{ billingCycle: 'monthly', pricePerCycle: 1490 }] } },
    // Old update plan whose product row is gone.
    { _id: ids.orphan, userId: ids.customer, productId: ids.deletedProduct, updatesUsed: 3, orderItems: [{ type: 'main', name: 'Yearly Update Plan' }], price: 3000 },
  ]);
  await db.collection('updaterequests').insertMany([{ updatePlanId: ids.orphan }, { updatePlanId: ids.orphan }, { updatePlanId: ids.quarterly }, { updatePlanId: id() }]);
  await db.collection('monthlyinvoices').insertOne({ orderId: ids.orphan, amount: 3000, status: 'paid' });
  await db.collection('invoices').insertMany([{ orderId: ids.quarterly, amount: 4335.9, invoiceType: 'project' }, { orderId: ids.project, amount: 5000, invoiceType: 'project' }]);
  await db.collection('transactions').insertMany([
    { orderId: ids.orphan, amount: 3000, type: 'payment', status: 'completed' },
    { orderId: ids.orphan, amount: 3000, type: 'renewal', status: 'completed' },
    { orderId: ids.orphan, amount: 500, type: 'payment', status: 'pending' },
  ]);
  countsBefore = await counts();
  installWriteGuard();
  report = await collectAudit(db);
});

after(async () => { await mongoose.disconnect(); await database.stop(); });

test('classifies orders by their own flags, not by default counters', () => {
  assert.deepEqual(report.ordersByKind, { project: 1, service: 2, other: 1 });
  assert.equal(report.others[0].id, String(ids.orphan));
  assert.equal(report.others[0].product, 'product deleted');
});

test('legacy candidate shows everything a customer would need to see', () => {
  const old = report.others[0];
  assert.equal(old.name, 'Yearly Update Plan');
  assert.equal(old.updateRequests, 2);
  assert.equal(old.monthlyInvoices, 1);
  assert.equal(old.transactions, 3);
  assert.equal(old.completedAmount, 6000);
});

test('flags catalogue settings the new rules change', () => {
  const plan = report.servicePlans.find(p => p.name === 'Starter Update Plan');
  assert.equal(plan.hasMultiYear, true);
  assert.equal(plan.hasFractionalPrice, true);
  assert.equal(plan.perMonthButLongerCycle, true);
});

test('flags service orders affected by known problems', () => {
  assert.equal(report.services.total, 2);
  assert.equal(report.services.tenureOver12, 1);
  assert.deepEqual(report.services.renewalPriceDiffers, [String(ids.quarterly)]);
  assert.deepEqual(report.services.perMonthButLongerCycle, [String(ids.quarterly)]);
  assert.deepEqual(report.services.legacyOrigin, []);
});

test('counts records by the kind of order they belong to', () => {
  assert.deepEqual(report.records.updateRequestsByOrderKind, { other: 2, service: 1, 'order missing': 1 });
  assert.deepEqual(report.records.monthlyInvoicesByOrderKind, { other: 1 });
  assert.deepEqual(report.records.fractionalInvoices, { project: 1 });
  assert.deepEqual(report.records.renewalTransactionsByOrderKind, { other: 1 });
});

test('write guard blocks writes and the audit changed nothing', async () => {
  // The guard throws before any command is sent, so the call fails synchronously.
  assert.throws(() => db.collection('orders').deleteMany({}), /READ-ONLY: blocked deleteMany/);
  assert.throws(() => db.collection('orders').insertOne({}), /READ-ONLY: blocked insertOne/);
  assert.throws(() => db.collection('orders').createIndex({ userId: 1 }), /READ-ONLY: blocked createIndex/);
  assert.deepEqual(await counts(), countsBefore);
});
