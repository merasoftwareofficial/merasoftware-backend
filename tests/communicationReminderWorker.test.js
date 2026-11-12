const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Rule = require('../models/communicationReminderRuleModel');
const Run = require('../models/communicationReminderRunModel');
const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const { EmailDraft, EmailHistory } = require('../models/emailControlModel');
const { processMonthlyRule } = require('../helpers/communicationReminderWorker');
const { createDraft, setEnabled } = require('../helpers/communicationReminderRules');
const { processCommunicationReminders } = require('../helpers/communicationReminderWorker');
const { Queue, State, STATE_ID } = require('../whatsapp/src/models.js');
const { createSender } = require('../whatsapp/src/sender.js');

test('monthly worker leases, catches up once and stops future reminders after payment', async () => {
  const db = await MongoMemoryServer.create();
  const previousFetch = global.fetch, oldKey = process.env.RESEND_API_KEY, oldFrom = process.env.FROM_EMAIL;
  try {
    await mongoose.connect(db.getUri()); await Promise.all([Rule.init(), Run.init(), EmailDraft.init(), EmailHistory.init()]);
    const client = await User.create({ name: 'Worker Client', email: 'worker-client@example.test', roles: ['customer'] });
    const now = new Date(), DAY = 86400000, due = new Date(+now + DAY), orderId = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({ _id: orderId, userId: client._id, isServicePlan: true, salesPackage: { package: { id: 'monthly' } }, orderVisibility: 'approved', servicePlanStatus: 'active', serviceCurrentCycleNumber: 1, serviceTotalCycles: 3, serviceNextBillingDate: due, serviceCyclePrice: 3000, orderItems: [{ name: 'Test package' }] });
    const rule = await Rule.create({ name: 'Test', source: 'monthly_package', enabled: true, revision: 1, activatedAt: new Date(+now - 3 * DAY), createdBy: client._id, steps: [
      { offsetDays: -2, subject: 'Earlier', text: 'Hello {{name}}', channel: 'email' },
      { offsetDays: -1, subject: 'Due soon', text: 'Hello {{name}}: {{amount}}', channel: 'email' },
      { offsetDays: 0, subject: 'Due', text: 'Hello {{name}}', channel: 'email' },
    ] });
    await assert.rejects(Rule.create({ name: 'Duplicate enabled rule', source: 'monthly_package', enabled: true, createdBy: client._id }), error => error.code === 11000);
    const draft = await Rule.create({ name: 'Separate draft', source: 'monthly_package', enabled: false, createdBy: client._id,
      steps: [{ offsetDays: 0, subject: 'Due', text: 'Hello {{name}}', channel: 'email' }] });
    const preview = await require('../helpers/communicationReminderPreview').previewMonthlyRule(draft._id, now);
    assert.equal(preview.count, 1); assert.equal(preview.samples[0].customer, 'Worker Client');
    assert.equal(await Run.countDocuments(), 0, 'preview never creates scheduled runs');
    let calls = 0;
    global.fetch = async () => { calls++; return new Response(JSON.stringify({ id: `isolated-${calls}` }), { status: 200 }); };
    process.env.RESEND_API_KEY = 'isolated-test'; process.env.FROM_EMAIL = 'sender@example.test';
    const outcomes = await Promise.all([processMonthlyRule(rule._id, now), processMonthlyRule(rule._id, now)]);
    assert.equal(outcomes.filter(row => row.claimed).length, 1);
    assert.equal(calls, 1, 'missed earlier milestone is not sent in a burst');
    const rows = await Run.find({ ruleId: rule._id }).sort({ step: 1 }).lean();
    assert.deepEqual(rows.map(row => row.status), ['skipped', 'sent', 'scheduled']);
    await processMonthlyRule(rule._id, now);
    assert.equal(calls, 1, 'repeated scans do not send again');
    await Invoice.collection.insertOne({ _id: new mongoose.Types.ObjectId(), orderId, userId: client._id, invoiceType: 'plan_renewal', serviceCycleNumber: 2, status: 'paid', amount: 3000, amountPaid: 3000, dueDate: due });
    await processMonthlyRule(rule._id, now);
    assert.equal((await Run.findOne({ ruleId: rule._id, step: 2 })).status, 'cancelled');
    assert.equal(calls, 1);
  } finally {
    global.fetch = previousFetch; if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey;
    if (oldFrom === undefined) delete process.env.FROM_EMAIL; else process.env.FROM_EMAIL = oldFrom;
    await mongoose.disconnect(); await db.stop();
  }
});

test('a disabled draft can be activated prospectively and the gated job delivers once', async () => {
  const db = await MongoMemoryServer.create();
  const previousFetch = global.fetch, oldKey = process.env.RESEND_API_KEY, oldFrom = process.env.FROM_EMAIL;
  const oldJobs = process.env.COMMUNICATION_REMINDER_JOBS_ENABLED, oldCrons = process.env.ENABLE_CRONS, oldWhatsApp = process.env.ENABLE_WHATSAPP;
  try {
    await mongoose.connect(db.getUri()); await Promise.all([Rule.init(), Run.init(), EmailDraft.init(), EmailHistory.init()]);
    const client = await User.create({ name: 'Activated Client', email: 'activated-client@example.test', phone: '9876543210', roles: ['customer'] });
    const now = Date.now(), due = new Date(now + 86400000 + 5000), orderId = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({ _id: orderId, userId: client._id, isServicePlan: true, salesPackage: { package: { id: 'monthly' } }, orderVisibility: 'approved', servicePlanStatus: 'active', serviceCurrentCycleNumber: 1, serviceTotalCycles: 3, serviceNextBillingDate: due, serviceCyclePrice: 2500, orderItems: [{ name: 'Care package' }] });
    const draft = await createDraft({ name: 'Next cycle', source: 'monthly_package', steps: [{ offsetDays: -1, subject: 'Due {{amount}}', text: 'Hello {{name}}', channel: 'both' }] }, client._id);
    process.env.COMMUNICATION_REMINDER_JOBS_ENABLED = 'true'; process.env.ENABLE_CRONS = 'true';
    process.env.RESEND_API_KEY = 'isolated-test'; process.env.FROM_EMAIL = 'sender@example.test'; process.env.ENABLE_WHATSAPP = 'true';
    let calls = 0; global.fetch = async () => { calls++; return new Response(JSON.stringify({ id: 'isolated' }), { status: 200 }); };
    const active = await setEnabled(draft._id, true, draft.revision);
    assert.equal(active.enabled, true);
    await processCommunicationReminders(new Date(now + 10000));
    assert.equal(calls, 1); assert.equal((await Run.findOne({ ruleId: draft._id })).status, 'queued');
    assert.equal(await Queue.countDocuments({ status: 'pending' }), 1);
    await processCommunicationReminders(new Date(now + 10000));
    assert.equal(calls, 1, 'repeated jobs preserve delivery identity');
    await Invoice.collection.insertOne({ _id: new mongoose.Types.ObjectId(), orderId, userId: client._id, invoiceType: 'plan_renewal', serviceCycleNumber: 2, status: 'paid', amount: 2500, amountPaid: 2500, dueDate: due });
    await State.updateOne({ _id: STATE_ID }, { $set: { settings: { quietHours: false, typing: false } } }, { upsert: true });
    let whatsappSends = 0;
    const transport = { isConnected: () => true, resolve: async () => 'test@s.whatsapp.net', send: async () => { whatsappSends++; return 'sent'; } };
    await createSender({ Queue, State, transport, config: { timeZone: 'Asia/Kolkata' } }).step();
    assert.equal(whatsappSends, 0, 'payment after queueing blocks the WhatsApp handoff');
    await processCommunicationReminders(new Date(now + 10000));
    assert.equal((await Run.findOne({ ruleId: draft._id })).status, 'partial', 'email sent and cancelled WhatsApp are reported separately');
    assert.equal((await setEnabled(draft._id, false, active.revision)).enabled, false);
  } finally {
    global.fetch = previousFetch;
    for (const [key, value] of [['RESEND_API_KEY', oldKey], ['FROM_EMAIL', oldFrom], ['COMMUNICATION_REMINDER_JOBS_ENABLED', oldJobs], ['ENABLE_CRONS', oldCrons], ['ENABLE_WHATSAPP', oldWhatsApp]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await mongoose.disconnect(); await db.stop();
  }
});

test('a due-day reminder waits for a delayed renewal invoice', async () => {
  const db = await MongoMemoryServer.create();
  const previousFetch = global.fetch, oldKey = process.env.RESEND_API_KEY, oldFrom = process.env.FROM_EMAIL;
  try {
    await mongoose.connect(db.getUri()); await Promise.all([Rule.init(), Run.init(), EmailDraft.init(), EmailHistory.init()]);
    const client = await User.create({ name: 'Delayed billing', email: 'delayed@example.test', roles: ['customer'] });
    const now = new Date(), due = new Date(+now - 60000), orderId = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({ _id: orderId, userId: client._id, isServicePlan: true, salesPackage: { package: { id: 'monthly' } }, orderVisibility: 'approved', servicePlanStatus: 'active', serviceCurrentCycleNumber: 1, serviceTotalCycles: 3, serviceNextBillingDate: due, serviceCyclePrice: 3000, orderItems: [{ name: 'Package' }] });
    const rule = await Rule.create({ name: 'Due day', source: 'monthly_package', enabled: true, revision: 1, activatedAt: new Date(+due - 86400000), createdBy: client._id, steps: [{ offsetDays: 0, subject: 'Due', text: 'Hello {{name}}', channel: 'email' }] });
    let calls = 0; global.fetch = async () => { calls++; return new Response(JSON.stringify({ id: 'delayed' }), { status: 200 }); };
    process.env.RESEND_API_KEY = 'isolated-test'; process.env.FROM_EMAIL = 'sender@example.test';
    await processMonthlyRule(rule._id, now);
    assert.equal((await Run.findOne({ ruleId: rule._id })).status, 'scheduled');
    assert.equal(calls, 0);
    await Invoice.collection.insertOne({ _id: new mongoose.Types.ObjectId(), orderId, userId: client._id, invoiceType: 'plan_renewal', serviceCycleNumber: 2, status: 'unpaid', amount: 3000, amountPaid: 0, dueDate: due });
    await processMonthlyRule(rule._id, now);
    assert.equal((await Run.findOne({ ruleId: rule._id })).status, 'sent');
    assert.equal(calls, 1);
  } finally {
    global.fetch = previousFetch;
    if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey;
    if (oldFrom === undefined) delete process.env.FROM_EMAIL; else process.env.FROM_EMAIL = oldFrom;
    await mongoose.disconnect(); await db.stop();
  }
});
