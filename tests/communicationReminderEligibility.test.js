const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Rule = require('../models/communicationReminderRuleModel');
const Run = require('../models/communicationReminderRunModel');
const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const { maySendReminder } = require('../helpers/communicationReminderEligibility');
const { Queue, State } = require('../whatsapp/src/models.js');
const { createSender } = require('../whatsapp/src/sender.js');
const { EmailDraft } = require('../models/emailControlModel');
const { decide, sendSystemMail } = require('../helpers/emailController');
const { dispatchReminder } = require('../helpers/communicationReminderDispatch');
const { reconcileReminderRun } = require('../helpers/communicationReminderReconcile');

test('handoff eligibility rechecks rule, client, actual invoice and due date', async () => {
  const database = await MongoMemoryServer.create();
  const originalFetch = global.fetch, previousKey = process.env.RESEND_API_KEY, previousFrom = process.env.FROM_EMAIL, previousWhatsApp = process.env.ENABLE_WHATSAPP;
  try {
    await mongoose.connect(database.getUri());
    const client = await User.create({ name: 'Test Client', email: 'reminder-client@example.test', phone: '9876543210', roles: ['customer'] });
    const rule = await Rule.create({ name: 'Test', source: 'monthly_package', enabled: true, revision: 1, createdBy: client._id });
    const orderId = new mongoose.Types.ObjectId(), invoiceId = new mongoose.Types.ObjectId(), due = new Date(Date.now() + 7 * 86400000);
    await Order.collection.insertOne({ _id: orderId, userId: client._id, isServicePlan: true, salesPackage: { package: { id: 'monthly' } }, orderVisibility: 'approved', servicePlanStatus: 'active', serviceCurrentCycleNumber: 1, serviceTotalCycles: 3, serviceNextBillingDate: due, serviceCyclePrice: 3000 });
    const run = await Run.create({ ruleId: rule._id, ruleRevision: 1, source: 'monthly_package', occurrenceKey: `${orderId}:2`, step: 0,
      entityId: orderId, clientId: client._id, cycle: 2, anchorAt: due, dueAt: due, subject: 'Reminder', text: 'Please pay.', channel: 'whatsapp' });
    assert.equal((await maySendReminder(run._id)).allowed, true, 'an upcoming cycle is eligible');
    await Invoice.collection.insertOne({ _id: invoiceId, orderId, userId: client._id, invoiceType: 'plan_renewal', serviceCycleNumber: 2, dueDate: due, status: 'paid', amount: 3000, amountPaid: 3000 });
    assert.equal((await maySendReminder(run._id)).allowed, false, 'a paid invoice never falls back to a projection');
    await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { status: 'partially_paid', amountPaid: 1000 } });
    assert.equal((await maySendReminder(run._id)).candidate.amount, 2000);
    let accepted = 0, acceptedBody;
    global.fetch = async (_url, options) => { accepted++; acceptedBody = JSON.parse(options.body); return new Response(JSON.stringify({ id: 'isolated-provider-id' }), { status: 200 }); };
    process.env.RESEND_API_KEY = 'isolated-test'; process.env.FROM_EMAIL = 'sender@example.test';
    const mail = () => ({ reviewed: true, to: [client.email], subject: 'Reminder', text: 'Please pay.', reminderRunId: run._id });
    assert.equal(await sendSystemMail('reminder.automated', mail(), 'test-reminder-one', '/test', { channel: 'email' }), 'sent');
    assert.equal(await sendSystemMail('reminder.automated', mail(), 'test-reminder-one', '/test', { channel: 'email' }), 'sent');
    assert.equal(accepted, 1, 'the existing delivery idempotency path prevents duplicate email');
    assert.equal(String((await EmailDraft.findOne({ dedupeKey: 'test-reminder-one' })).reminderRunId), String(run._id));
    process.env.ENABLE_WHATSAPP = 'true';
    const originalCreate = Queue.create;
    try {
      Queue.create = async () => { throw new Error('isolated queue failure'); };
      await assert.rejects(sendSystemMail('reminder.automated', mail(), 'test-reminder-both', '/test', { channel: 'both' }), /queue failure/);
    } finally { Queue.create = originalCreate; }
    assert.equal(await sendSystemMail('reminder.automated', mail(), 'test-reminder-both', '/test', { channel: 'both' }), 'sent');
    assert.equal(accepted, 2, 'retry sends the email only once');
    const bothDraft = await EmailDraft.findOne({ dedupeKey: 'test-reminder-both' }).lean();
    assert.equal(await Queue.countDocuments({ emailDraftId: bothDraft._id }), 1, 'failed WhatsApp part is queued on retry');
    const tracking = await Run.create({ ruleId: rule._id, ruleRevision: 1, source: 'monthly_package', occurrenceKey: `${orderId}:2`, step: 3,
      entityId: orderId, clientId: client._id, cycle: 2, anchorAt: due, dueAt: due, subject: 'Tracking', text: 'Reminder', channel: 'both', status: 'queued', emailDraftId: bothDraft._id });
    await Queue.updateMany({ emailDraftId: bothDraft._id }, { $set: { reminderRunId: tracking._id } });
    assert.equal((await reconcileReminderRun(tracking._id)).status, 'queued');
    await Queue.updateMany({ emailDraftId: bothDraft._id }, { $set: { status: 'sent', sentAt: new Date() } });
    assert.equal((await reconcileReminderRun(tracking._id)).status, 'sent', 'both channel results must finish before sent');
    assert.ok((await Run.findById(tracking._id)).sentAt, 'completion time is recorded when both channels have real timestamps');
    await Queue.deleteMany({ emailDraftId: bothDraft._id });
    const scheduled = await Run.create({ ruleId: rule._id, ruleRevision: 1, source: 'monthly_package', occurrenceKey: `${orderId}:2`, step: 1,
      entityId: orderId, clientId: client._id, cycle: 2, anchorAt: due, dueAt: new Date(Date.now() - 1000), subject: 'Due {{amount}}', text: 'Hello {{name}}', channel: 'email' });
    assert.equal(await dispatchReminder(scheduled._id), 'sent');
    assert.match(acceptedBody.subject, /2,000/); assert.match(acceptedBody.text, /Test Client/);
    assert.equal(await dispatchReminder(scheduled._id), 'not-due');
    assert.equal(accepted, 3, 'a delivered run is not sent twice');
    const partial = await Run.create({ ruleId: rule._id, ruleRevision: 1, source: 'monthly_package', occurrenceKey: `${orderId}:2`, step: 4,
      entityId: orderId, clientId: client._id, cycle: 2, anchorAt: due, dueAt: new Date(Date.now() - 1000), subject: 'Due', text: 'Hello {{name}}', channel: 'both' });
    try {
      Queue.create = async () => { throw new Error('isolated queue failure'); };
      assert.equal(await dispatchReminder(partial._id), 'partial');
    } finally { Queue.create = originalCreate; }
    const partialResult = await Run.findById(partial._id).lean();
    assert.ok(partialResult.emailDraftId);
    assert.deepEqual(partialResult.channelOutcomes, { email: 'sent', whatsapp: 'failed' });
    const { retryQueueFailure } = require('../helpers/communicationReminderRetry');
    await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { status: 'paid', amountPaid: 3000 } });
    await assert.rejects(retryQueueFailure(partial._id), /changed/);
    await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { status: 'partially_paid', amountPaid: 1000 } });
    assert.equal((await retryQueueFailure(partial._id)).status, 'queued');
    assert.equal(accepted, 4, 'retry does not repeat the accepted email');
    assert.equal(await Queue.countDocuments({ reminderRunId: partial._id }), 1);
    await assert.rejects(retryQueueFailure(partial._id), /cannot be retried safely/);
    await Queue.deleteMany({ reminderRunId: partial._id });
    await Run.updateOne({ _id: run._id }, { $set: { expectedAmount: 2000 } });
    await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { amountPaid: 1500 } });
    assert.equal((await maySendReminder(run._id)).allowed, false, 'a changed partial balance cannot send stale wording');
    await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { amountPaid: 1000 } });
    await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { dueDate: new Date(+due + 86400000) } });
    assert.equal((await maySendReminder(run._id)).allowed, false, 'changed due date invalidates the old run');
    await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { dueDate: due } });
    await Rule.updateOne({ _id: rule._id }, { $set: { enabled: false } });
    assert.equal((await maySendReminder(run._id)).allowed, false, 'disabled rule cannot hand off');
    await Rule.updateOne({ _id: rule._id }, { $set: { enabled: true, revision: 2 } });
    assert.equal((await maySendReminder(run._id)).allowed, false, 'old rule revision cannot hand off');
    await Rule.updateOne({ _id: rule._id }, { $set: { revision: 1 } });
    let sends = 0;
    const transport = { isConnected: () => true, resolve: async () => 'test@s.whatsapp.net', send: async () => { sends++; return 'test-id'; } };
    const queued = await Queue.create({ to: '919876543210', text: 'Reminder', reminderRunId: run._id });
    await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { status: 'paid', amountPaid: 3000 } });
    const paidRun = await Run.create({ ruleId: rule._id, ruleRevision: 1, source: 'monthly_package', occurrenceKey: `${orderId}:2`, step: 2,
      entityId: orderId, clientId: client._id, cycle: 2, anchorAt: due, dueAt: new Date(Date.now() - 1000), subject: 'Reminder', text: 'Please pay.', channel: 'email' });
    assert.equal(await dispatchReminder(paidRun._id), 'cancelled');
    assert.equal(accepted, 4, 'a paid invoice cannot dispatch a new run');
    let providerCalls = 0;
    global.fetch = async () => { providerCalls++; throw new Error('Provider must not be contacted'); };
    process.env.RESEND_API_KEY = 'isolated-test'; process.env.FROM_EMAIL = 'sender@example.test';
    const email = await EmailDraft.create({ event: 'invoice.project', application: 'portal', to: [client.email], status: 'pending', subject: 'Reminder', text: 'Please pay.', plain: 'Please pay.', html: '<p>Please pay.</p>', reminderRunId: run._id, expiresAt: new Date(Date.now() + 60000) });
    const delivery = await decide(String(email._id), null, { choice: 'send', channels: 'email', subject: email.subject, text: email.text }, { application: 'portal', portalAdmin: true });
    assert.equal(delivery.status, 'failed'); assert.equal(providerCalls, 0, 'payment recorded before email handoff blocks the provider');
    // The sender's quiet hours (22:00-08:00 IST) must not decide this test: open sending so it passes at any hour.
    const openSending = () => State.updateOne({ _id: 'main' }, { $set: { settings: { quietHours: false, typing: false } } }, { upsert: true });
    await openSending();
    await createSender({ Queue, State, transport, config: { timeZone: 'Asia/Kolkata' } }).step();
    assert.equal((await Queue.findById(queued._id)).status, 'cancelled', 'payment recorded while queued cancels WhatsApp');
    assert.equal(sends, 0);
    await State.deleteMany({});
    await openSending();
    await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { status: 'unpaid', amountPaid: 0 } });
    const racing = await Queue.create({ to: '919876543210', text: 'Race reminder', reminderRunId: run._id });
    const raceTransport = { isConnected: () => true,
      resolve: async () => { await Invoice.collection.updateOne({ _id: invoiceId }, { $set: { status: 'paid', amountPaid: 3000 } }); return 'test@s.whatsapp.net'; },
      send: async (_jid, _text, _typing, options) => { if (!await options.beforeSend()) throw Object.assign(new Error('changed'), { code: 'FINAL_MESSAGE_CHANGED' }); sends++; return 'test-id'; } };
    await createSender({ Queue, State, transport: raceTransport, config: { timeZone: 'Asia/Kolkata' } }).step();
    assert.equal((await Queue.findById(racing._id)).status, 'cancelled', 'payment at handoff is rechecked');
    assert.equal(sends, 0);
    await User.updateOne({ _id: client._id }, { $set: { isActive: false } });
    assert.equal((await maySendReminder(run._id)).allowed, false, 'inactive customer cannot receive');
  } finally { global.fetch = originalFetch; if (previousKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previousKey; if (previousFrom === undefined) delete process.env.FROM_EMAIL; else process.env.FROM_EMAIL = previousFrom; if (previousWhatsApp === undefined) delete process.env.ENABLE_WHATSAPP; else process.env.ENABLE_WHATSAPP = previousWhatsApp; await mongoose.disconnect(); await database.stop(); }
});
