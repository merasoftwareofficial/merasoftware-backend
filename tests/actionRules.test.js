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
