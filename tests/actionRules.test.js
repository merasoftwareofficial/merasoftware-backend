// Action rules phase 1 (all docs/Reminder.md §4). In-memory replica set: no real customer is contacted;
// the mail sender is replaced with a stub.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Invoice = require('../models/invoiceModel');
const Event = require('../models/communicationActionEventModel');
const Rule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const { createProjectInvoice, markProjectInvoicePaid } = require('../helpers/paymentRecording');
const { cleanRule, createRule, updateRule, setRuleEnabled } = require('../helpers/actionRules');
const worker = require('../helpers/actionRuleWorker');
const { maySendReminder } = require('../helpers/communicationReminderEligibility');
const emailController = require('../helpers/emailController');

const DAY = 86400000;
let database, admin, customer, sent;
const realSend = emailController.sendSystemMail;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User.init(), Invoice.init(), Event.init(), Rule.init(), Run.init()]);
});
after(async () => { emailController.sendSystemMail = realSend; await mongoose.disconnect(); if (database) await database.stop(); });
beforeEach(async () => {
  process.env.ACTION_RULES_ENABLED = 'true';
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [admin, customer] = await User.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Client', email: 'client@example.test', phone: '9876543210', roles: ['customer'] },
  ]);
  sent = [];
  emailController.sendSystemMail = async (event, mail, key) => { sent.push({ event, mail, key }); return 'sent'; };
});

const invoice = (extra = {}) => createProjectInvoice({ customerId: customer._id, orderId: new mongoose.Types.ObjectId(), amount: 1000,
  lineItems: [{ name: "Website", quantity: 1, price: 1000, total: 1000 }], ...extra });
const reminder = { action: 'invoice.created', control: 'auto', stopOn: ['payment.received'],
  steps: [{ afterDays: 0, channel: 'whatsapp', text: 'Invoice ready' }, { afterDays: 3, channel: 'email', subject: 'Reminder', text: 'Please pay' }],
  repeat: { everyDays: 2, times: 2 } };
async function activeRule(raw = reminder) {
  const rule = await createRule(raw, admin._id);
  await setRuleEnabled(rule._id, true);
  return rule;
}

test('form rules: a reminder needs a stop, an email needs a subject', () => {
  assert.throws(() => cleanRule({ ...reminder, stopOn: [] }), /needs a stop action/);
  assert.throws(() => cleanRule({ ...reminder, steps: [{ afterDays: 0, channel: 'email', text: 'x' }] }), /needs a subject/);
  assert.throws(() => cleanRule({ ...reminder, action: 'nope' }), /Choose the action/);
  const one = cleanRule({ action: 'plan.started', steps: [{ afterDays: 0, channel: 'whatsapp', text: 'Welcome' }] });
  assert.equal(one.control, 'off');
});

test('switch off: no action is recorded', async () => {
  process.env.ACTION_RULES_ENABLED = 'false';
  await invoice();
  assert.equal(await Event.countDocuments(), 0);
});

test('aborted transaction leaves no action; committed one leaves exactly one', async () => {
  const session = await mongoose.startSession();
  await assert.rejects(session.withTransaction(async () => {
    await invoice({ session });
    throw new Error('payment failed');
  }));
  assert.equal(await Event.countDocuments(), 0);
  await session.withTransaction(() => invoice({ session }));
  await session.endSession();
  assert.equal(await Event.countDocuments({ action: 'invoice.created' }), 1);
});

test('invoice created schedules steps and repeats once, even if handled twice', async () => {
  await activeRule();
  const bill = await invoice();
  await worker.processEvents();
  const event = await Event.findOne({ action: 'invoice.created' }).lean();
  assert.equal(event.status, 'done');
  assert.ok(event.expiresAt > new Date(Date.now() + DAY - 60000), 'log entry expires about 24 hours after handling');
  await Event.updateOne({ _id: event._id }, { $set: { status: 'new' } });
  await worker.processEvents();
  const runs = await Run.find({ source: 'action' }).sort({ step: 1 }).lean();
  assert.equal(runs.length, 4);
  const days = runs.map(run => Math.round((run.dueAt - event.occurredAt) / DAY));
  assert.deepEqual(days, [0, 3, 5, 7]);
  assert.equal(String(runs[0].entityId), String(bill._id));
  assert.equal(runs[0].subject, 'Invoice created');
});

test('full payment stops the remaining reminders of that invoice only', async () => {
  await activeRule();
  const [paid, other] = [await invoice(), await invoice()];
  await worker.processEvents();
  await markProjectInvoicePaid({ invoice: paid, customerId: customer._id, paymentMethod: 'cash', actorId: admin._id, amount: 1000 });
  await worker.processEvents();
  assert.equal(await Run.countDocuments({ entityId: paid._id, status: 'cancelled' }), 4);
  assert.equal(await Run.countDocuments({ entityId: other._id, status: 'scheduled' }), 4);
});

test('partial payment does not stop reminders', async () => {
  await activeRule();
  const bill = await invoice();
  await worker.processEvents();
  await markProjectInvoicePaid({ invoice: bill, customerId: customer._id, paymentMethod: 'cash', actorId: admin._id, amount: 400 });
  await worker.processEvents();
  assert.equal(await Event.countDocuments({ action: 'payment.received' }), 0);
  assert.equal(await Run.countDocuments({ entityId: bill._id, status: 'scheduled' }), 4);
});

test('check before sending: a paid invoice gets no reminder even without a stop action', async () => {
  await activeRule();
  const bill = await invoice();
  await worker.processEvents();
  await Invoice.updateOne({ _id: bill._id }, { $set: { status: 'paid' } });
  await worker.dispatchDue(new Date());
  const first = await Run.findOne({ entityId: bill._id, step: 0 }).lean();
  assert.equal(first.status, 'cancelled');
  assert.equal(first.reason, 'Invoice is already paid.');
  assert.equal(sent.length, 0);
});

test('due message is sent once, with the customer details', async () => {
  await activeRule();
  const bill = await invoice();
  await worker.processEvents();
  assert.equal(await worker.dispatchDue(new Date()), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'reminder.automated');
  assert.equal(sent[0].mail.values.name, 'Client');
  assert.equal(sent[0].mail.values.amount, '₹1,000');
  const run = await Run.findOne({ entityId: bill._id, step: 0 }).lean();
  assert.equal(run.status, 'sent');
  await worker.dispatchDue(new Date());
  assert.equal(sent.length, 1, 'no second send');
});

test('handoff check: right phone allowed, changed phone refused, rule off refused', async () => {
  const rule = await activeRule();
  await invoice();
  await worker.processEvents();
  const run = await Run.findOne({ step: 0 }).lean();
  assert.equal((await maySendReminder(run._id, { phone: '919876543210' })).allowed, true);
  assert.equal((await maySendReminder(run._id, { phone: '919999999999' })).allowed, false);
  await setRuleEnabled(rule._id, false);
  assert.equal((await maySendReminder(run._id)).reason, 'Rule is off.');
});

test('missed steps: only the latest due message goes, older ones are skipped', async () => {
  await activeRule();
  await invoice();
  await worker.processEvents();
  await worker.dispatchDue(new Date(Date.now() + 4 * DAY));
  const runs = await Run.find({ source: 'action' }).sort({ step: 1 }).lean();
  assert.deepEqual(runs.map(run => run.status), ['skipped', 'sent', 'scheduled', 'scheduled']);
  assert.equal(sent.length, 1);
});

test('editing a rule makes a new version; planned messages keep their text', async () => {
  const rule = await activeRule();
  await invoice();
  await worker.processEvents();
  const edited = await updateRule(rule._id, { ...reminder, steps: [{ afterDays: 0, channel: 'whatsapp', text: 'New text' }, reminder.steps[1]] });
  assert.equal(edited.revision, 2);
  const run = await Run.findOne({ step: 0 }).lean();
  assert.equal(run.text, 'Invoice ready');
  await invoice();
  await worker.processEvents();
  assert.equal(await Run.countDocuments({ text: 'New text', ruleRevision: 2 }), 1);
});

test('a rule turned on later does not reach back to older actions', async () => {
  await invoice();
  await activeRule();
  await worker.processEvents();
  assert.equal(await Run.countDocuments({ source: 'action' }), 0);
});

test('project completed: once per round, stopped only when the whole project is paid', async () => {
  const { projectCompleted } = require('../helpers/actionEvents');
  await activeRule({ action: 'project.completed', control: 'auto', stopOn: ['payment.received'],
    steps: [{ afterDays: 1, channel: 'whatsapp', text: 'Project ready, please pay' }], repeat: { everyDays: 2, times: 1 } });
  const orderId = new mongoose.Types.ObjectId();
  const order = { _id: orderId, userId: customer._id, projectProgress: 100, lifecycleEvents: [{ eventType: 'completed' }] };
  await projectCompleted(order);
  await projectCompleted(order);
  assert.equal(await Event.countDocuments({ action: 'project.completed' }), 1);
  const [first, second] = [await invoice({ orderId }), await invoice({ orderId })];
  await worker.processEvents();
  assert.equal(await Run.countDocuments({ action: 'project.completed', status: 'scheduled' }), 2);
  await markProjectInvoicePaid({ invoice: first, customerId: customer._id, paymentMethod: 'cash', actorId: admin._id, amount: 1000 });
  await worker.processEvents();
  assert.equal(await Run.countDocuments({ action: 'project.completed', status: 'scheduled' }), 2, 'one invoice still open');
  await markProjectInvoicePaid({ invoice: second, customerId: customer._id, paymentMethod: 'cash', actorId: admin._id, amount: 1000 });
  await worker.processEvents();
  assert.equal(await Run.countDocuments({ action: 'project.completed', status: 'cancelled' }), 2);
});

test('due-date relative steps: 3d before due, on due date, and 2d after due', async () => {
  const due = new Date('2026-12-10T10:00:00.000Z');
  const rule = await activeRule({
    action: 'invoice.created',
    control: 'auto',
    condition: 'unpaid',
    stopOn: ['payment.received'],
    steps: [
      { timingRef: 'before_due', days: 3, channel: 'whatsapp', text: '3 days left' },
      { timingRef: 'on_due', days: 0, channel: 'whatsapp', text: 'Due today' },
      { timingRef: 'after_due', days: 2, channel: 'whatsapp', text: 'Overdue' },
    ],
  });
  await invoice({ dueDate: due });
  await worker.processEvents();
  const runs = await Run.find({ ruleId: rule._id }).sort({ step: 1 }).lean();
  assert.equal(runs.length, 3);
  assert.equal(runs[0].dueAt.toISOString(), '2026-12-07T10:00:00.000Z');
  assert.equal(runs[1].dueAt.toISOString(), '2026-12-10T10:00:00.000Z');
  assert.equal(runs[2].dueAt.toISOString(), '2026-12-12T10:00:00.000Z');
});

test('condition (paid vs unpaid) and package scope (digital-growth-package) filter rules cleanly', async () => {
  const Order = require('../models/orderProductModel');
  const dgpOrder = await Order.create({
    userId: customer._id,
    orderNumber: `ORD-DGP-${Date.now()}`,
    price: 4999,
    orderItems: [{ name: 'Digital Growth Package', quantity: 1, price: 4999 }],
    salesPackage: { packageSlug: 'digital-growth-package', packageName: 'Digital Growth Package', months: 1 },
  });
  const otherOrder = await Order.create({
    userId: customer._id,
    orderNumber: `ORD-OTH-${Date.now()}`,
    price: 9999,
    orderItems: [{ name: 'Basic Website', quantity: 1, price: 9999 }],
  });

  const dgpUnpaidRule = await activeRule({
    kind: 'template',
    control: 'auto',
    action: 'invoice.created',
    condition: 'unpaid',
    scope: { kind: 'package', packageSlug: 'digital-growth-package' },
    steps: [{ timingRef: 'after_action', days: 0, channel: 'whatsapp', text: 'Pay for Digital Growth Package' }],
  });
  await invoice({ orderId: dgpOrder._id });
  await invoice({ orderId: otherOrder._id });
  await worker.processEvents();
  assert.equal(await Run.countDocuments({ ruleId: dgpUnpaidRule._id }), 1);
});

test('admin audience resolves and verifies against configured teamContacts', async () => {
  await User.updateOne({ _id: admin._id }, { $set: { adminContact: { email: admin.email, whatsappNumbers: ['+919999988888'] } } });
  const adminRule = await activeRule({
    kind: 'template',
    control: 'auto',
    audience: 'admin',
    action: 'invoice.created',
    steps: [{ timingRef: 'after_action', days: 0, channel: 'both', subject: 'Admin alert', text: 'New invoice' }],
  });
  await invoice();
  await worker.processEvents();
  const run = await Run.findOne({ ruleId: adminRule._id }).lean();
  assert.equal(run.audience, 'admin');
  assert.equal((await worker.actionEligibility(run, { emails: [admin.email], phone: '+919999988888' })).allowed, true);
  assert.equal((await worker.actionEligibility(run, { phone: '+911111122222' })).allowed, false);
});

test('action-aware validation rejects unsupported condition or scope for payment.received', () => {
  assert.throws(() => cleanRule({
    kind: 'template',
    action: 'payment.received',
    condition: 'unpaid',
    steps: [{ timingRef: 'after_action', days: 0, channel: 'whatsapp', text: 'Thanks' }],
  }), /valid condition/i);
  assert.throws(() => cleanRule({
    kind: 'template',
    action: 'payment.received',
    condition: 'anytime',
    scope: { kind: 'monthly' },
    steps: [{ timingRef: 'after_action', days: 0, channel: 'whatsapp', text: 'Thanks' }],
  }), /scope is not available/i);
});

test('doAlso validation rejects Won stage, unknown type, or empty note', () => {
  assert.throws(() => cleanRule({
    kind: 'template',
    action: 'whatsapp.ad_received',
    doAlso: [{ type: 'change_lead_stage', stage: 'Won' }],
    steps: [{ timingRef: 'after_action', days: 0, channel: 'whatsapp', text: 'Hi' }],
  }), /valid lead stage/i);
  assert.throws(() => cleanRule({
    kind: 'template',
    action: 'whatsapp.ad_received',
    doAlso: [{ type: 'add_lead_note', note: '   ' }],
    steps: [{ timingRef: 'after_action', days: 0, channel: 'whatsapp', text: 'Hi' }],
  }), /follow-up note/i);
  const valid = cleanRule({
    kind: 'template',
    action: 'whatsapp.ad_received',
    doAlso: [{ type: 'change_lead_stage', stage: 'Positive' }, { type: 'add_lead_note', note: 'Auto replied' }, { type: 'stop_reminders' }],
    steps: [{ timingRef: 'after_action', days: 0, channel: 'whatsapp', text: 'Hi' }],
  });
  assert.equal(valid.doAlso.length, 3);
});

test('whatsapp.ad_received plans lead-only run and executeDoAlso updates non-Won lead', async () => {
  const Lead = require('../models/leadModel');
  const lead = await Lead.create({ phone: '+919811122233', status: 'Inquiry', source: 'WhatsApp ad', name: 'Asha' });
  const rule = await activeRule({
    kind: 'template',
    control: 'auto',
    audience: 'customer',
    action: 'whatsapp.ad_received',
    doAlso: [{ type: 'change_lead_stage', stage: 'Positive' }, { type: 'add_lead_note', note: 'Replied to {name}' }],
    steps: [{ timingRef: 'after_action', days: 0, channel: 'whatsapp', text: 'Welcome {name}' }],
  });
  const { whatsappAdReceived } = require('../helpers/actionEvents');
  await whatsappAdReceived({ _id: new mongoose.Types.ObjectId(), phone: '919811122233', text: 'Interested', sentAt: new Date() }, { leadId: lead._id });
  await worker.processEvents();
  const run = await Run.findOne({ ruleId: rule._id }).lean();
  assert.ok(run, 'run created for lead');
  assert.equal(String(run.leadId), String(lead._id));
  assert.equal(run.clientId, null);
  assert.equal((await worker.actionEligibility(run, { phone: '+919811122233' })).allowed, true);

  await worker.executeDoAlso(run, { lead }, { name: 'Asha' }, text => text.replace('{name}', 'Asha'));
  const updated = await Lead.findById(lead._id).lean();
  assert.equal(updated.status, 'Positive');
  assert.equal(updated.followUps.length, 2);
  assert.equal(updated.followUps[1].note, 'Replied to Asha');

  // Won leads never change status via change_lead_stage.
  const wonLead = await Lead.create({ phone: '+919811122244', status: 'Won', source: 'WhatsApp ad', name: 'Matured', convertedToUserId: customer._id });
  await worker.executeDoAlso({ ...run, leadId: wonLead._id, clientId: customer._id }, { lead: wonLead }, { name: 'Matured' }, text => text);
  const wonAfter = await Lead.findById(wonLead._id).lean();
  assert.equal(wonAfter.status, 'Won');
});

test('placeholders and formatting: normalizes single braces, renders new links, bold/italic in email & WhatsApp', () => {
  const { render, compose } = require('../helpers/emailMarkup');
  const { messageText } = require('../helpers/whatsappQueue');

  const raw = 'Hi {name}, **{{planName}}** _pending_ {{amount}}\n- View: {{packageLink}}';
  const normalized = worker.normalizePlaceholders(raw);
  assert.equal(normalized, 'Hi {{name}}, **{{planName}}** _pending_ {{amount}}\n- View: {{packageLink}}');

  const filled = render(normalized, { name: 'Riya', planName: 'Growth', amount: '₹4,999', packageLink: 'https://merasoftware.com/package/digital_growth' });
  const mail = compose(filled);
  assert.match(mail.html, /<strong>Growth<\/strong>/);
  assert.match(mail.html, /<em>pending<\/em>/);
  assert.match(mail.html, /href="https:\/\/merasoftware\.com\/package\/digital_growth"/);
  assert.doesNotMatch(mail.html, /<em>growth<\/em>/);

  const wa = messageText({ subject: 'Payment Due', text: filled, plain: mail.text });
  assert.match(wa, /^\*Payment Due\*/);
  assert.match(wa, /\*Growth\* _pending_/);
});

test('review mode: stages pending EmailDraft instead of auto-sending and marks run queued', async () => {
  const rule = await activeRule({
    kind: 'template',
    action: 'plan.started',
    audience: 'customer',
    condition: 'anytime',
    steps: [{ timingRef: 'after_action', days: 0, channel: 'whatsapp', text: 'Hi {{name}}, plan started.' }],
    control: 'review',
    enabled: true,
  });
  assert.equal(rule.control, 'review');
  assert.equal(rule.enabled, true);

  const Order = require('../models/orderProductModel');
  const order = await Order.create({ userId: customer._id, price: 4999, orderItems: [{ name: 'Review Plan', qty: 1, price: 4999 }] });
  await require('../helpers/actionEvents').emitAction('plan.started', {
    key: `plan.started:${order._id}:review-test-${Date.now()}`,
    entityId: order._id,
    clientId: customer._id,
    orderId: order._id,
    matchKeys: [`order:${order._id}`],
  });
  await worker.processEvents();
  const run = await Run.findOne({ ruleId: rule._id }).lean();
  assert.ok(run, 'run planned for review rule');

  const check = await worker.stillValid(run);
  assert.equal(check.ok, true);
  assert.equal(check.control, 'review');

  const emailController = require('../helpers/emailController');
  const origSend = emailController.sendSystemMail;
  let captured = null;
  emailController.sendSystemMail = async (_event, _mail, _key, _source, opts) => {
    captured = opts;
    return 'staged-review';
  };
  try {
    const res = await worker.dispatchRun(run._id, new Date(Date.now() + 1000));
    assert.equal(res, 'queued');
    assert.equal(captured?.reviewOnly, true);
    const after = await Run.findById(run._id).lean();
    assert.equal(after.status, 'queued');
  } finally {
    emailController.sendSystemMail = origSend;
  }
});

test('origin tracking and turning on a draft rule: new stays new, migrated becomes migrated_edited, off promotes to auto', async () => {
  const newRule = await createRule({
    kind: 'template',
    action: 'plan.started',
    steps: [{ timingRef: 'after_action', days: 0, channel: 'whatsapp', text: 'Draft hi {{name}}' }],
    control: 'off',
    enabled: false,
  }, admin._id);
  assert.equal(newRule.origin, 'new');
  assert.equal(newRule.control, 'off');

  const turnedOn = await setRuleEnabled(newRule._id, true);
  assert.equal(turnedOn.enabled, true);
  assert.equal(turnedOn.control, 'auto');

  const migrated = await createRule({
    kind: 'reminder',
    action: 'invoice.created',
    origin: 'migrated',
    migratedFrom: 'old-rule-123',
    steps: [{ timingRef: 'before_due', days: 3, channel: 'whatsapp', text: 'Due soon' }],
    stopOn: ['payment.received'],
    control: 'auto',
    enabled: true,
  }, admin._id);
  assert.equal(migrated.origin, 'migrated');
  assert.equal(migrated.migratedFrom, 'old-rule-123');

  const edited = await updateRule(migrated._id, {
    kind: 'reminder',
    action: 'invoice.created',
    steps: [{ timingRef: 'before_due', days: 2, channel: 'whatsapp', text: 'Due in 2d' }],
    stopOn: ['payment.received'],
    control: 'auto',
    enabled: true,
  });
  assert.equal(edited.origin, 'migrated_edited');
  assert.equal(edited.migratedFrom, 'old-rule-123');
});

test('broadcast.sent plans lead-only run, blocks converted/blocked leads, and migrates legacy rules idempotently', async () => {
  const Lead = require('../models/leadModel');
  const LegacyRule = require('../models/communicationReminderRuleModel');
  const { migrateLegacyReminderRules } = require('../helpers/migrateLegacyReminderRules');

  const legacyMonthly = await LegacyRule.create({
    name: 'Legacy monthly',
    source: 'monthly_package',
    enabled: false,
    createdBy: admin._id,
    steps: [{ offsetDays: -3, channel: 'whatsapp', subject: 'Due', text: 'Pay {{name}}' }],
  });
  const legacyBroadcast = await LegacyRule.create({
    name: 'Legacy broadcast',
    source: 'broadcast',
    enabled: true,
    activatedAt: new Date(Date.now() - 1000),
    createdBy: admin._id,
    steps: [{ offsetDays: 2, channel: 'whatsapp', subject: 'Follow up', text: 'Hi {{name}}' }],
  });

  const firstRun = await migrateLegacyReminderRules();
  assert.equal(firstRun.migrated, 2);
  const secondRun = await migrateLegacyReminderRules();
  assert.equal(secondRun.migrated, 0);
  assert.equal(secondRun.skipped, 2);

  const migratedBroadcast = await Rule.findOne({ migratedFrom: String(legacyBroadcast._id) }).lean();
  assert.equal(migratedBroadcast.action, 'broadcast.sent');
  assert.equal(migratedBroadcast.origin, 'migrated');
  assert.equal(migratedBroadcast.enabled, true);

  const lead = await Lead.create({ name: 'Broadcast Lead', phone: '9876500011', status: 'Inquiry' });
  await require('../helpers/actionEvents').broadcastSent(new mongoose.Types.ObjectId(), lead._id);
  await worker.processEvents();
  const run = await Run.findOne({ ruleId: migratedBroadcast._id, leadId: lead._id }).lean();
  assert.ok(run, 'broadcast.sent run planned');
  assert.equal((await worker.stillValid(run)).ok, true);

  await Lead.updateOne({ _id: lead._id }, { $set: { convertedToUserId: customer._id } });
  const afterConvert = await worker.stillValid(run);
  assert.equal(afterConvert.ok, false);

  await LegacyRule.deleteMany({ _id: { $in: [legacyMonthly._id, legacyBroadcast._id] } });
});
