// Phase 2 end-to-end verification: Escalation / Timeout Conditions, System Actions, Stage Handoff,
// Plan Deactivation Countdown, Auto-Recovery on Stop, and Portal orderState derivation.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Lead = require('../models/leadModel');
const Event = require('../models/communicationActionEventModel');
const Trail = require('../models/communicationTrailModel');
const Rule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const { createTrail, setTrailEnabled } = require('../helpers/communicationTrails');
const { emitAction } = require('../helpers/actionEvents');
const worker = require('../helpers/actionRuleWorker');
const { getOrderState } = require('../helpers/orderStatusEngine');
const emailController = require('../helpers/emailController');

const DAY = 86400000;
let database, admin, customer, sent;
const realSend = emailController.sendSystemMail;

before(async () => {
  process.env.ACTION_RULES_ENABLED = 'true';
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User.init(), Order.init(), Invoice.init(), Lead.init(), Event.init(), Trail.init(), Rule.init(), Run.init()]);
  admin = await User.create({ name: 'Admin', email: 'admin@test.com', password: 'secret', role: 'ADMIN' });
  customer = await User.create({ name: 'Ravi Kumar', email: 'ravi@test.com', phone: '9876543210', password: 'secret', role: 'GENERAL', isActive: true });
});

after(async () => {
  emailController.sendSystemMail = realSend;
  await mongoose.disconnect();
  if (database) await database.stop();
});

beforeEach(async () => {
  sent = [];
  emailController.sendSystemMail = async (_event, mail) => {
    sent.push(mail);
    return 'sent';
  };
  await Promise.all([
    Order.deleteMany({}),
    Invoice.deleteMany({}),
    Lead.deleteMany({}),
    Event.deleteMany({}),
    Trail.deleteMany({}),
    Rule.deleteMany({}),
    Run.deleteMany({}),
  ]);
});

async function makeServiceOrderAndInvoice(now) {
  const order = await Order.create({
    userId: customer._id,
    price: 2500,
    totalAmount: 2500,
    isServicePlan: true,
    orderVisibility: 'approved',
    servicePlanStatus: 'active',
    servicePlanSnapshot: { serviceName: 'Monthly SEO Care', packageSlug: 'monthly-seo' },
    serviceNextBillingDate: now,
    orderItems: [{ name: 'Monthly SEO Care', price: 2500, quantity: 1 }],
  });
  const invoice = await Invoice.create({
    userId: customer._id,
    orderId: order._id,
    invoiceNumber: `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    invoiceType: 'plan_renewal',
    status: 'unpaid',
    amount: 2500,
    amountPaid: 0,
    dueDate: now,
    lineItems: [{ name: 'Monthly SEO Care', price: 2500, quantity: 1 }],
  });
  return { order, invoice };
}

function buildTwoStageDeactivationTrail() {
  return {
    triggers: ['invoice.created'],
    scope: 'all',
    selectedPackages: [],
    instant: { audience: 'off' },
    reminders: [{
      id: 1,
      audience: 'client',
      clientMode: 'separate',
      clientSteps: [{ amount: 0, unit: 'days', pos: 'after', channel: 'whatsapp', subject: '', text: 'Pay your bill {{name}}' }],
      repeatMode: 'limited',
      repeatForDays: 5,
      repeatEveryDays: 1,
      repeatPerDay: 1,
      countDaysFrom: 'trigger_date',
      condition: 'unpaid',
      stopOn: ['payment.received'],
      onTimeout: {
        enabled: true,
        afterDays: 5,
        condition: 'unpaid',
        actions: [{ key: 'stage.continue', config: {} }],
        nextStageId: 1,
      },
    }],
    stages: [{
      id: 1,
      source: 'previous_timeout',
      parentStageId: 0,
      onStartActions: [{
        key: 'plan.deactivation_countdown',
        config: { graceDays: 3, finalStatus: 'expired', showPortalBanner: true, autoRecoverOnStop: true },
      }],
      instant: {
        audience: 'client',
        client: { channel: 'whatsapp', subject: '', text: 'Warning: plan deactivating in {{deactivationDays}} days' },
      },
      reminder: {
        id: 1,
        audience: 'client',
        clientMode: 'separate',
        clientSteps: [{ amount: 1, unit: 'days', pos: 'after', channel: 'whatsapp', subject: '', text: 'Grace reminder ({{deactivationDays}}d left)' }],
        repeatMode: 'limited',
        repeatForDays: 2,
        repeatEveryDays: 1,
        repeatPerDay: 1,
        countDaysFrom: 'trigger_date',
        condition: 'unpaid',
        stopOn: ['payment.received'],
        onTimeout: {
          enabled: true,
          afterDays: 2,
          condition: 'unpaid',
          actions: [{ key: 'plan.expire', config: { autoRecoverOnStop: false } }],
          nextStageId: null,
        },
      },
    }],
    control: 'auto',
    enabled: true,
  };
}

test('5-day timeout hands off to Stage 2 (3-day deactivation countdown) then expires plan and emits plan.expired', async () => {
  const t0 = new Date('2026-11-01T10:00:00Z');
  const trail = await createTrail(buildTwoStageDeactivationTrail(), admin._id);
  await Rule.updateMany({ trailId: trail._id }, { $set: { activatedAt: new Date(+t0 - 1000) } });

  const { order, invoice } = await makeServiceOrderAndInvoice(t0);
  await emitAction('invoice.created', {
    key: `invoice.created:${invoice._id}`,
    entityId: invoice._id,
    orderId: order._id,
    clientId: customer._id,
    occurredAt: t0,
    matchKeys: [`invoice:${invoice._id}`, `order:${order._id}`],
    details: { dueDate: t0 },
  });

  // Day 0: process event + dispatch Day 0 reminder (Stage 2 must NOT run yet)
  await worker.processEvents();
  await worker.dispatchDue(t0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Pay your bill/);
  let freshOrder = await Order.findById(order._id).lean();
  assert.equal(Boolean(freshOrder.deactivationCountdown?.active), false);

  // Day 5: Stage 1 timeout fires -> hands off to Stage 2
  const t5 = new Date(+t0 + 5 * DAY);
  await worker.dispatchDue(t5);
  // Dispatch Stage 2 immediate onStartActions (deactivation countdown) & instant warning message
  await worker.dispatchDue(t5);

  freshOrder = await Order.findById(order._id).lean();
  assert.equal(freshOrder.deactivationCountdown?.active, true);
  assert.equal(freshOrder.servicePlanStatus, 'active');

  const stateDuringCountdown = getOrderState(freshOrder, t5);
  assert.equal(stateDuringCountdown.code, 'plan_active');
  assert.equal(stateDuringCountdown.tone, 'warning');
  assert.equal(stateDuringCountdown.deactivationDaysRemaining, 3);

  // Day 8: countdown ends -> plan expires and emits plan.expired
  const t8 = new Date(+t5 + 3 * DAY);
  await worker.dispatchDue(t8);

  freshOrder = await Order.findById(order._id).lean();
  assert.equal(freshOrder.servicePlanStatus, 'expired');
  assert.equal(freshOrder.deactivationCountdown?.active, false);
  const expiredState = getOrderState(freshOrder);
  assert.equal(expiredState.label, 'Expired');

  const expiredEvent = await Event.findOne({ action: 'plan.expired', entityId: order._id }).lean();
  assert.ok(expiredEvent, 'plan.expired trigger event should be emitted');
});

test('payment.received during deactivation countdown cancels expiry and clears countdown', async () => {
  const t0 = new Date('2026-11-01T10:00:00Z');
  const trail = await createTrail(buildTwoStageDeactivationTrail(), admin._id);
  await Rule.updateMany({ trailId: trail._id }, { $set: { activatedAt: new Date(+t0 - 1000) } });

  const { order, invoice } = await makeServiceOrderAndInvoice(t0);
  await emitAction('invoice.created', {
    key: `invoice.created:${invoice._id}`,
    entityId: invoice._id,
    orderId: order._id,
    clientId: customer._id,
    occurredAt: t0,
    matchKeys: [`invoice:${invoice._id}`, `order:${order._id}`],
    details: { dueDate: t0 },
  });

  await worker.processEvents();
  const t5 = new Date(+t0 + 5 * DAY);
  await worker.dispatchDue(t5);
  await worker.dispatchDue(t5);

  let freshOrder = await Order.findById(order._id).lean();
  assert.equal(freshOrder.deactivationCountdown?.active, true);

  // Day 6: Client pays -> payment.received arrives
  const t6 = new Date(+t5 + 1 * DAY);
  await Invoice.updateOne({ _id: invoice._id }, { $set: { status: 'paid', amountPaid: 2500 } });
  await emitAction('payment.received', {
    key: `payment.received:${invoice._id}`,
    entityId: invoice._id,
    orderId: order._id,
    clientId: customer._id,
    occurredAt: t6,
    matchKeys: [`invoice:${invoice._id}`, `order:${order._id}`],
  });
  await worker.processEvents();

  freshOrder = await Order.findById(order._id).lean();
  assert.equal(freshOrder.deactivationCountdown?.active, false);
  assert.equal(freshOrder.servicePlanStatus, 'active');

  // Day 8: nothing expires
  const t8 = new Date(+t5 + 3 * DAY);
  await worker.dispatchDue(t8);
  freshOrder = await Order.findById(order._id).lean();
  assert.equal(freshOrder.servicePlanStatus, 'active');
});

test('upload_pending timeout pauses plan, creates lead once, and upload.completed auto-resumes plan', async () => {
  const t0 = new Date('2026-11-01T10:00:00Z');
  const trail = await createTrail({
    triggers: ['plan.started'],
    scope: 'all',
    instant: { audience: 'off' },
    reminders: [{
      id: 1,
      audience: 'client',
      clientMode: 'separate',
      clientSteps: [{ amount: 0, unit: 'days', pos: 'after', channel: 'whatsapp', subject: '', text: 'Please upload your monthly data' }],
      repeatMode: 'limited',
      repeatForDays: 5,
      repeatEveryDays: 1,
      repeatPerDay: 1,
      countDaysFrom: 'trigger_date',
      condition: 'upload_pending',
      stopOn: ['upload.completed'],
      onTimeout: {
        enabled: true,
        afterDays: 5,
        condition: 'upload_pending',
        actions: [
          { key: 'plan.pause', config: { autoRecoverOnStop: true } },
          { key: 'lead.create', config: { stage: 'Positive', note: 'No upload in 5 days' } },
        ],
      },
    }],
    stages: [],
    control: 'auto',
    enabled: true,
  }, admin._id);
  await Rule.updateMany({ trailId: trail._id }, { $set: { activatedAt: new Date(+t0 - 1000) } });

  const { order } = await makeServiceOrderAndInvoice(t0);
  await emitAction('plan.started', {
    key: `plan.started:${order._id}`,
    entityId: order._id,
    orderId: order._id,
    clientId: customer._id,
    occurredAt: t0,
    matchKeys: [`order:${order._id}`],
  });

  await worker.processEvents();
  const t5 = new Date(+t0 + 5 * DAY);
  await worker.dispatchDue(t5);

  let freshOrder = await Order.findById(order._id).lean();
  assert.equal(freshOrder.servicePlanStatus, 'paused');
  assert.equal(freshOrder.automationPause?.active, true);

  const leads = await Lead.find({ email: 'ravi@test.com' }).lean();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].status, 'Positive');

  // Client uploads data on Day 6 -> auto-resumes plan to active
  const t6 = new Date(+t5 + 1 * DAY);
  await emitAction('upload.completed', {
    key: `upload.completed:${order._id}`,
    entityId: order._id,
    orderId: order._id,
    clientId: customer._id,
    occurredAt: t6,
    matchKeys: [`order:${order._id}`],
  });
  await worker.processEvents();

  freshOrder = await Order.findById(order._id).lean();
  assert.equal(freshOrder.servicePlanStatus, 'active');
  assert.equal(freshOrder.automationPause?.active, false);
});

test('setTrailEnabled toggles system_action and stage_handoff rules together with reminders', async () => {
  const trail = await createTrail(buildTwoStageDeactivationTrail(), admin._id);
  let rules = await Rule.find({ trailId: trail._id }).lean();
  assert.ok(rules.some(r => r.kind === 'stage_handoff'));
  assert.ok(rules.some(r => r.kind === 'system_action'));
  assert.ok(rules.every(r => r.enabled === true));

  await setTrailEnabled(trail._id, false);
  rules = await Rule.find({ trailId: trail._id }).lean();
  assert.ok(rules.every(r => r.enabled === false && r.control === 'off'));

  await setTrailEnabled(trail._id, true);
  rules = await Rule.find({ trailId: trail._id }).lean();
  assert.ok(rules.every(r => r.enabled === true && r.control === 'auto'));
});
