// Phase 3 end-to-end verification: SSOT resolvePaymentDueDate priority, quoteKey stability,
// renewal with paymentDueDays > 0, hard auto-pause on overdue + auto-resume on payment,
// until_due repeat, due-date-anchored onTimeout (0 extra days), back-date guard, and Service Plan scope linking.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const User = require('../models/userModel');
const Product = require('../models/productModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Event = require('../models/communicationActionEventModel');
const Trail = require('../models/communicationTrailModel');
const Rule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const { resolvePaymentDueDate, resolveGraceCutoff, DAY } = require('../helpers/paymentDueDate');
const { quotePackage } = require('../helpers/salesPackages');
const { planQuoteKey, quoteServicePlan } = require('../helpers/servicePlanPricing');
const { processServicePlanRenewals, pauseOverdueServicePlans, expireUnpaidOneTimeProjects } = require('../cron/servicePlanRenewalCron');
const { settleServiceCycle } = require('../helpers/serviceCycleSettlement');
const { list: listCommunicationActions } = require('../helpers/communicationActions');
const { createTrail } = require('../helpers/communicationTrails');
const worker = require('../helpers/actionRuleWorker');

let database, admin, customer;

before(async () => {
  process.env.ACTION_RULES_ENABLED = 'true';
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([
    User.init(), Product.init(), Order.init(), Invoice.init(),
    Event.init(), Trail.init(), Rule.init(), Run.init(),
  ]);
  admin = await User.create({ name: 'Admin', email: 'admin@due.test', password: 'secret', role: 'ADMIN' });
  customer = await User.create({ name: 'Anil Sharma', email: 'anil@due.test', phone: '9876543210', password: 'secret', role: 'GENERAL', isActive: true });
});

after(async () => {
  await mongoose.disconnect();
  await database.stop();
});

beforeEach(async () => {
  await Promise.all([
    Product.deleteMany({}), Order.deleteMany({}), Invoice.deleteMany({}),
    Event.deleteMany({}), Trail.deleteMany({}), Rule.deleteMany({}), Run.deleteMany({}),
  ]);
});

test('1. resolvePaymentDueDate keeps dueDate = billing/invoice date (never shifted by graceDays) & resolveGraceCutoff adds graceDays', () => {
  const base = new Date('2026-11-01T00:00:00.000Z');
  const explicit = new Date('2026-11-25T00:00:00.000Z');
  const instDue = new Date('2026-11-12T00:00:00.000Z');
  const orderWithFirstPurchaseOffer = {
    isServicePlan: true,
    paymentPolicy: { mode: 'pay_later', dueDays: 15, cycleScope: 'first_purchase' },
    servicePlanSnapshot: { paymentDueDays: 7 },
  };
  const orderWithEveryCycleOffer = {
    isServicePlan: true,
    paymentPolicy: { mode: 'pay_later', dueDays: 15, cycleScope: 'every_cycle' },
    servicePlanSnapshot: { paymentDueDays: 7 },
  };

  // 1. Explicit admin dueDate wins over everything
  assert.equal(
    +resolvePaymentDueDate({ explicitDueDate: explicit, order: orderWithFirstPurchaseOffer, installmentDueDate: instDue, invoiceDate: base, cycleNumber: 1 }),
    +explicit,
  );
  // 2. Offer dueDays wins on Cycle 1
  assert.equal(
    +resolvePaymentDueDate({ order: orderWithFirstPurchaseOffer, invoiceDate: base, cycleNumber: 1 }),
    +base + 15 * DAY,
  );
  // 2b. Cycle 2 with first_purchase offer keeps dueDate = Billing Cycle Date (base); graceCutoff adds 7 grace days
  const cycle2Due = resolvePaymentDueDate({ order: orderWithFirstPurchaseOffer, invoiceDate: base, cycleNumber: 2 });
  assert.equal(+cycle2Due, +base);
  assert.equal(+resolveGraceCutoff({ order: orderWithFirstPurchaseOffer, dueDate: cycle2Due }), +base + 7 * DAY);
  // 2c. Cycle 2 with every_cycle offer keeps offer dueDays (15)
  assert.equal(
    +resolvePaymentDueDate({ order: orderWithEveryCycleOffer, invoiceDate: base, cycleNumber: 2 }),
    +base + 15 * DAY,
  );
  // 3. Installment dueDate wins when no explicit/offer dueDate
  assert.equal(
    +resolvePaymentDueDate({ installmentDueDate: instDue, invoiceDate: base }),
    +instDue,
  );
  // 4. Fallback = invoiceDate (0 days)
  assert.equal(
    +resolvePaymentDueDate({ invoiceDate: base }),
    +base,
  );
});

test('2. Editing paymentDueDays or graceEndAction never invalidates Sales Package quoteKey or Service Plan planQuoteKey', () => {
  const pkg = {
    id: 'starter-pack', name: 'Starter Pack', description: 'Desc', category: 'standard_websites',
    status: 'published', regularPrice: 10000, discountedPrice: 8000, offerExtraPrice: 0,
    offerSlug: '', inclusions: ['5 pages'], terms: [], linkedPlanIds: [], order: 1, pages: [],
    billing: 'one_time', portalUploads: true, paymentOptions: ['full'],
  };
  const q0 = quotePackage({ ...pkg, paymentDueDays: 0, graceEndAction: 'keep_open' }, []);
  const q10 = quotePackage({ ...pkg, paymentDueDays: 10, graceEndAction: 'auto_cancel' }, []);
  assert.equal(q0.quoteKey, q10.quoteKey);

  const plan = {
    _id: new mongoose.Types.ObjectId(),
    serviceName: 'Monthly Care',
    price: 2000,
    sellingPrice: 2000,
    servicePlan: {
      pricingMode: 'fixed', purchaseType: 'recurring', capability: 'upload_data',
      monthlyReferencePrice: 2000, maxTenureMonths: 12,
      billingOptions: [{ billingCycle: 'monthly', discountPercent: 0 }],
      limitScope: 'per_month', portalAccessCount: 4, filesLimit: 10,
      paymentDueDays: 0,
    },
  };
  const quote = quoteServicePlan(plan, { purchase: 'monthly', tenureMonths: 3 });
  const k0 = planQuoteKey(plan, quote);
  const k14 = planQuoteKey({ ...plan, servicePlan: { ...plan.servicePlan, paymentDueDays: 14 } }, quote);
  assert.equal(k0, k14);
});

test('3. Renewal stays active for paymentDueDays > 0, auto-pauses on overdue, and resumes on payment (0-day pauses immediately)', async () => {
  const start = new Date('2026-10-01T00:00:00.000Z');
  const renewNow = new Date('2026-11-01T00:00:00.000Z');

  // A) Plan with paymentDueDays = 7
  const activePlan = await Order.create({
    userId: customer._id, price: 2000, totalAmount: 2000, orderVisibility: 'approved',
    isServicePlan: true, servicePlanStatus: 'active', serviceAutoRenew: true,
    serviceCurrentCycleNumber: 1, serviceCurrentCycleStart: start, serviceCurrentCycleEnd: renewNow,
    serviceNextBillingDate: renewNow, serviceSelectedBillingCycle: 'monthly', serviceBillingCycleMonths: 1,
    serviceTenureMonths: 6, serviceTotalCycles: 6, serviceCyclePrice: 2000, serviceAccessUsedInCycle: 2,
    orderItems: [{ id: 'p1', name: 'Care Plan 7d', type: 'main', quantity: 1, originalPrice: 2000, finalPrice: 2000 }],
    servicePlanSnapshot: { serviceName: 'Care Plan 7d', paymentDueDays: 7 },
  });

  // B) Legacy plan with paymentDueDays = 0
  const zeroPlan = await Order.create({
    userId: customer._id, price: 1500, totalAmount: 1500, orderVisibility: 'approved',
    isServicePlan: true, servicePlanStatus: 'active', serviceAutoRenew: true,
    serviceCurrentCycleNumber: 1, serviceCurrentCycleStart: start, serviceCurrentCycleEnd: renewNow,
    serviceNextBillingDate: renewNow, serviceSelectedBillingCycle: 'monthly', serviceBillingCycleMonths: 1,
    serviceTenureMonths: 6, serviceTotalCycles: 6, serviceCyclePrice: 1500,
    orderItems: [{ id: 'p0', name: 'Legacy Plan 0d', type: 'main', quantity: 1, originalPrice: 1500, finalPrice: 1500 }],
    servicePlanSnapshot: { serviceName: 'Legacy Plan 0d', paymentDueDays: 0 },
  });

  await processServicePlanRenewals(renewNow);

  const afterRenew7 = await Order.findById(activePlan._id).lean();
  const afterRenew0 = await Order.findById(zeroPlan._id).lean();
  assert.equal(afterRenew7.servicePlanStatus, 'active');
  assert.equal(afterRenew7.serviceCurrentCycleNumber, 2);
  assert.equal(afterRenew0.servicePlanStatus, 'paused');

  const inv7 = await Invoice.findOne({ orderId: activePlan._id, invoiceType: 'plan_renewal' }).lean();
  assert.ok(inv7);
  // Due date = exact billing cycle date (renewNow), never shifted by grace days
  assert.equal(+new Date(inv7.dueDate), +renewNow);

  // Day 5 (inside 7-day grace window): invoice marked overdue, plan stays active!
  await pauseOverdueServicePlans(new Date(+renewNow + 5 * DAY));
  assert.equal((await Order.findById(activePlan._id).lean()).servicePlanStatus, 'active');
  assert.equal((await Invoice.findById(inv7._id).lean()).status, 'overdue');

  // Day 8 (after 7-day grace cutoff): hard auto-pause
  const pausedCount = await pauseOverdueServicePlans(new Date(+renewNow + 8 * DAY));
  assert.equal(pausedCount, 1);
  assert.equal((await Order.findById(activePlan._id).lean()).servicePlanStatus, 'paused');

  // Client pays on Day 9 -> auto-resumes active and preserves Cycle 2 dates
  const paidInv = await Invoice.findByIdAndUpdate(
    inv7._id,
    { $set: { status: 'paid', amountPaid: 2000, paidDate: new Date(+renewNow + 9 * DAY) } },
    { new: true },
  );
  const resumed = await settleServiceCycle({ orderId: activePlan._id, invoice: paidInv, now: new Date(+renewNow + 9 * DAY), skipNotification: true });
  assert.equal(resumed.servicePlanStatus, 'active');
  assert.equal(resumed.serviceCurrentCycleNumber, 2);
  assert.equal(+new Date(resumed.serviceCurrentCycleStart), +new Date(afterRenew7.serviceCurrentCycleStart));
});

test('4. until_due repeat, due-date-anchored onTimeout (0 extra days), and isBackdated guard', async () => {
  const trail = await createTrail({
    triggers: ['invoice.created'],
    scope: 'all',
    enabled: true,
    control: 'auto',
    instant: { audience: 'off' },
    reminders: [{
      id: 1,
      audience: 'client',
      countDaysFrom: 'due_date',
      condition: 'unpaid',
      clientSteps: [{ amount: 3, unit: 'days', pos: 'before', channel: 'whatsapp', text: 'Pay before due' }],
      repeatMode: 'until_due',
      repeatEveryDays: 1,
      repeatPerDay: 1,
      stopOn: ['payment.received'],
      onTimeout: {
        enabled: true,
        afterDays: 0,
        condition: 'unpaid',
        actions: [{ key: 'plan.expire', config: {} }],
      },
    }],
  }, admin._id);

  const rules = await Rule.find({ trailId: trail._id }).lean();
  const remRule = rules.find(r => r.kind === 'reminder');
  const sysRule = rules.find(r => r.kind === 'system_action');
  assert.equal(remRule.repeat.mode, 'until_due');
  assert.equal(sysRule.timeoutAfterDays, 0);

  const now = new Date();
  const futureDue = new Date(+now + 5 * DAY);
  const event = {
    key: 'inv-future', action: 'invoice.created', entityId: new mongoose.Types.ObjectId(),
    clientId: customer._id, occurredAt: now, details: { dueDate: futureDue }, matchKeys: ['inv:1'],
  };
  // Reminder starts 3d before due, repeats every 1d until due -> 3d before, 2d before, 1d before, on due (4 sends)
  const remRuns = worker.planRuns(remRule, event, futureDue, null);
  assert.equal(remRuns.length, 4);
  assert.equal(+new Date(remRuns[remRuns.length - 1].dueAt), +futureDue);

  // System action anchored to exact dueDate (+0 extra days)
  const sysRuns = worker.planRuns(sysRule, event, futureDue, null);
  assert.equal(sysRuns.length, 1);
  assert.equal(+new Date(sysRuns[0].dueAt), +futureDue);

  // Back-date guard: past dueDate with isBackdated=true skips immediate system_action
  const pastDue = new Date(+now - 3 * DAY);
  const backdatedEvent = { ...event, key: 'inv-backdated', details: { dueDate: pastDue, isBackdated: true } };
  assert.equal(worker.planRuns(sysRule, backdatedEvent, pastDue, null).length, 0);
});

test('5. Service Plans appear in communicationActions catalog and match Include/Exclude scope', async () => {
  const plan = await Product.create({
    serviceName: 'SEO Growth Plan',
    category: 'service_plan',
    isServicePlan: true,
    price: 3000,
    sellingPrice: 3000,
    servicePlan: { pricingMode: 'fixed', purchaseType: 'recurring', capability: 'send_reminders', paymentDueDays: 5 },
  });

  const catalog = await listCommunicationActions({ view: 'catalog' });
  const planSlug = `plan:${String(plan._id)}`;
  const found = catalog.packages.find(p => p.slug === planSlug);
  assert.ok(found, 'Active service plan must be listed in scope packages');
  assert.equal(found.name, 'Plan: SEO Growth Plan');

  const order = await Order.create({
    userId: customer._id, productId: plan._id, price: 3000, totalAmount: 3000,
    orderVisibility: 'approved', isServicePlan: true, servicePlanStatus: 'active',
    orderItems: [{ id: String(plan._id), name: 'SEO Growth Plan', type: 'main', quantity: 1, originalPrice: 3000, finalPrice: 3000 }],
    servicePlanSnapshot: { serviceName: 'SEO Growth Plan', paymentDueDays: 5 },
  });
  const inv = await Invoice.create({
    userId: customer._id, orderId: order._id, invoiceNumber: 'INV-SCOPE-1',
    invoiceType: 'project', amount: 3000, status: 'unpaid', invoiceDate: new Date(), dueDate: new Date(Date.now() + 5 * DAY),
  });

  const ctx = await worker.resolveEventContext({ action: 'invoice.created', entityId: inv._id, orderId: order._id, details: {} });
  assert.equal(ctx.packageSlug, planSlug);
  assert.equal(worker.ruleMatchesContext({ condition: 'unpaid', scope: { kind: 'include', includedPackages: [planSlug] } }, ctx), true);
  assert.equal(worker.ruleMatchesContext({ condition: 'unpaid', scope: { kind: 'exclude', excludedPackages: [planSlug] } }, ctx), false);
});

test('6. paymentDueRibbon derives window from active before_due Trail, shows overdue/paused, and clears on payment', async () => {
  const { loadBeforeDueRules, buildPaymentDueAlert } = require('../helpers/paymentDueRibbon');

  await createTrail({
    triggers: ['invoice.created'],
    scope: 'all',
    enabled: true,
    control: 'auto',
    instant: { audience: 'off' },
    reminders: [{
      id: 1,
      audience: 'client',
      countDaysFrom: 'due_date',
      condition: 'unpaid',
      clientSteps: [{ amount: 5, unit: 'days', pos: 'before', channel: 'whatsapp', text: '5d before due' }],
      repeatMode: 'off',
      stopOn: ['payment.received'],
    }],
  }, admin._id);

  const rules = await loadBeforeDueRules();
  const now = new Date('2026-11-10T00:00:00.000Z');
  const order = {
    _id: new mongoose.Types.ObjectId(),
    orderVisibility: 'approved',
    isServicePlan: true,
    servicePlanStatus: 'active',
    servicePlanSnapshot: { serviceName: 'Growth Care' },
  };

  // Outside 5-day before_due window (10 days left) -> null
  assert.equal(
    buildPaymentDueAlert({
      order,
      invoice: { _id: new mongoose.Types.ObjectId(), status: 'unpaid', amount: 2000, amountPaid: 0, dueDate: new Date(+now + 10 * DAY) },
      rules,
      now,
    }),
    null,
  );

  // Inside 5-day before_due window (4 days left) -> due_soon with ribbonWindowDays = 5
  const dueSoon = buildPaymentDueAlert({
    order,
    invoice: { _id: new mongoose.Types.ObjectId(), status: 'unpaid', amount: 2000, amountPaid: 0, dueDate: new Date(+now + 4 * DAY) },
    rules,
    now,
  });
  assert.equal(dueSoon.kind, 'due_soon');
  assert.equal(dueSoon.daysRemaining, 4);
  assert.equal(dueSoon.ribbonWindowDays, 5);

  // Overdue + paused -> overdue + isPaused
  const pausedOverdue = buildPaymentDueAlert({
    order: { ...order, servicePlanStatus: 'paused' },
    invoice: { _id: new mongoose.Types.ObjectId(), status: 'overdue', amount: 2000, amountPaid: 0, dueDate: new Date(+now - 2 * DAY) },
    rules,
    now,
  });
  assert.equal(pausedOverdue.kind, 'overdue');
  assert.equal(pausedOverdue.isPaused, true);
  assert.equal(pausedOverdue.daysOverdue, 2);

  // Paid invoice -> null (clears ribbon)
  assert.equal(
    buildPaymentDueAlert({
      order,
      invoice: { _id: new mongoose.Types.ObjectId(), status: 'paid', amount: 2000, amountPaid: 2000, dueDate: new Date(+now + 2 * DAY) },
      rules,
      now,
    }),
    null,
  );
});

test('7. Phase 5: One-time auto_cancel (zero-paid only), past before_due skip, and grace_end_date anchor', async () => {
  const created = new Date('2026-11-01T00:00:00.000Z');
  const zeroPaidOrder = await Order.create({
    userId: customer._id, price: 5000, totalAmount: 5000, paidAmount: 0, orderVisibility: 'approved',
    isServicePlan: false, createdAt: created,
    orderItems: [{ id: 'ot1', name: 'One-Time Web', type: 'main', quantity: 1, originalPrice: 5000, finalPrice: 5000 }],
    salesPackage: { package: { id: 'ot-web', name: 'One-Time Web', paymentDueDays: 5, graceEndAction: 'auto_cancel' } },
  });
  await Invoice.create({
    userId: customer._id, orderId: zeroPaidOrder._id, invoiceNumber: 'INV-OT-0',
    invoiceType: 'project', amount: 5000, amountPaid: 0, status: 'unpaid', invoiceDate: created, dueDate: created,
  });

  const partialPaidOrder = await Order.create({
    userId: customer._id, price: 5000, totalAmount: 5000, paidAmount: 1000, orderVisibility: 'approved',
    isServicePlan: false, createdAt: created,
    orderItems: [{ id: 'ot2', name: 'One-Time Partial', type: 'main', quantity: 1, originalPrice: 5000, finalPrice: 5000 }],
    salesPackage: { package: { id: 'ot-web', name: 'One-Time Partial', paymentDueDays: 5, graceEndAction: 'auto_cancel' } },
  });
  await Invoice.create({
    userId: customer._id, orderId: partialPaidOrder._id, invoiceNumber: 'INV-OT-1',
    invoiceType: 'project', amount: 5000, amountPaid: 1000, status: 'partially_paid', invoiceDate: created, dueDate: created,
  });

  // Day 3 (inside grace): neither cancelled
  assert.equal(await expireUnpaidOneTimeProjects(new Date(+created + 3 * DAY)), 0);

  // Day 6 (after 5d grace): zero-paid cancelled, partial-paid NEVER cancelled
  assert.equal(await expireUnpaidOneTimeProjects(new Date(+created + 6 * DAY)), 1);
  assert.equal((await Order.findById(zeroPaidOrder._id).lean()).orderVisibility, 'cancelled');
  assert.equal((await Order.findById(partialPaidOrder._id).lean()).orderVisibility, 'approved');

  // Past before_due auto-skip on Month-1 unpaid buy when dueDate = today
  const now = new Date('2026-11-10T10:00:00.000Z');
  const rule = {
    _id: new mongoose.Types.ObjectId(), revision: 1, kind: 'reminder', baseDate: 'due_date',
    steps: [
      { timingRef: 'before_due', unit: 'days', days: 2, channel: 'whatsapp', text: '2d before' },
      { timingRef: 'after_due', unit: 'days', days: 2, channel: 'whatsapp', text: '2d after' },
    ],
    repeat: { mode: 'off' }, stopOn: ['payment.received'],
  };
  const runs = worker.planRuns(rule, { key: 'inv:now', action: 'invoice.created', entityId: zeroPaidOrder._id, clientId: customer._id, occurredAt: now, matchKeys: [] }, now, null);
  assert.equal(runs.length, 1, 'Past before_due step must be skipped on real event');
  assert.equal(runs[0].text, '2d after');
});
