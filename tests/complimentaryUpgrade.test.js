const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.RESEND_API_KEY = 'not-a-real-provider-key';
process.env.FROM_EMAIL = 'sender@example.test';
process.env.TOKEN_SECRET_KEY = 'isolated-complimentary-upgrade-secret';
process.env.FORNTEND_URL = 'https://portal.example.test';

// Real routes, mail scope, review decision, WhatsApp queue and invoice reads on an isolated database. Only the mail provider is fake.
const mongoose = require('mongoose');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
require('../models/developerModel'); // getOrderDetails populates the assigned developer
const { EmailDraft, EmailHistory, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');
const { requestMiddleware } = require('../helpers/emailController');
const { recordCompleted } = require('../helpers/complimentaryUpgrade');
const { generateInvoiceDocumentPdf } = require('../helpers/generateInvoiceDocumentPdf');

const nativeFetch = global.fetch;
let db, server, base, admin, customer, mails;
const cookie = (user, role) => `token=${jwt.sign({ _id: String(user._id), role }, process.env.TOKEN_SECRET_KEY)}`;
async function call(path, method = 'POST', body, auth = cookie(admin, 'admin')) {
  const response = await nativeFetch(`${base}${path}`, { method, headers: { Cookie: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const project = (fields = {}) => Order.create({ userId: customer._id, price: 25000, isWebsiteProject: true, projectProgress: 100, orderVisibility: 'approved', projectSnapshot: { displayName: 'Sharma Billing App' }, ...fields });
async function open(orderId, event) {
  const result = await call(`/admin/projects/${orderId}/complimentary-upgrade`, 'POST', { event });
  assert.equal(result.status, 200, result.message);
  assert.equal(result.emailDraftIds.length, 1);
  return call(`/email-control/drafts/${result.emailDraftIds[0]}`, 'GET').then(review => review.data);
}
const send = (draft, channels) => call(`/email-control/drafts/${draft._id}/decision`, 'POST', { choice: 'send', channels, subject: draft.subject, subjectDoc: draft.templateSubjectDoc, doc: draft.templateDoc || draft.doc, templateId: draft.selectedTemplateId });

before(async () => {
  db = await MongoMemoryServer.create();
  process.env.MONGODB_URI = db.getUri();
  await mongoose.connect(db.getUri(), { dbName: 'complimentary-upgrade-isolated-test' });
  await Promise.all([Queue.init(), Invoice.init()]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const authToken = require('../middleware/authToken');
  app.use(requestMiddleware);
  app.use('/email-control', require('../routes/emailControl'));
  app.post('/admin/projects/:orderId/complimentary-upgrade', authToken, require('../controller/order/complimentaryUpgrade'));
  app.get('/my-invoices', authToken, require('../controller/user/getMyInvoices'));
  app.get('/order-details/:orderId', authToken, require('../controller/order/getOrderDetails'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (url, options) => { mails.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 }); };
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true'; mails = [];
  await Promise.all([User, Order, Invoice, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate, Queue].map(model => model.deleteMany({})));
  admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
  customer = await User.create({ name: 'Ravi', email: 'ravi@example.test', phone: '9876543210', roles: ['customer'] });
});
after(async () => {
  global.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('each of the three messages names the product, never "website", and only Completed leaves an invoice', async () => {
  const order = await project();
  for (const event of ['project.upgrade.offer', 'project.upgrade.started']) {
    const draft = await open(order._id, event);
    assert.equal(draft.event, event);
    assert.match(draft.subject, /Sharma Billing App/);
    assert.doesNotMatch(`${draft.subject} ${draft.text}`, /website/i);
    assert.equal((await send(draft, 'whatsapp')).data.status, 'queued');
  }
  assert.equal(await Invoice.countDocuments(), 0);
  assert.equal(await Queue.countDocuments({ to: '919876543210' }), 2);

  const done = await open(order._id, 'project.upgrade.completed');
  assert.match(done.text, /project-details\//);
  assert.equal((await send(done, 'email')).data.status, 'sent');
  const [invoice] = await Invoice.find().lean();
  assert.equal(invoice.invoiceType, 'complimentary_upgrade');
  assert.equal(invoice.amount, 0); assert.equal(invoice.status, 'paid');
  assert.equal(String(invoice.orderId), String(order._id)); assert.equal(String(invoice.userId), String(customer._id));
  assert.match(invoice.invoiceNumber, /^INV-\d{6}-\d{4}$/);
  assert.equal(invoice.lineItems[0].name, 'Complimentary upgrade — Sharma Billing App');
  assert.match(invoice.notes, /free of cost/);
});

test('a retried send of the same Completed message never adds a second invoice', async () => {
  const order = await project();
  const done = await open(order._id, 'project.upgrade.completed');
  await send(done, 'email');
  await recordCompleted(done._id);
  await Promise.all([recordCompleted(done._id), recordCompleted(done._id)]);
  assert.equal(await Invoice.countDocuments({ orderId: order._id }), 1);
});

test('two Completed messages are two upgrades, with their own invoice numbers', async () => {
  const order = await project();
  await send(await open(order._id, 'project.upgrade.completed'), 'email');
  await send(await open(order._id, 'project.upgrade.completed'), 'email');
  const numbers = (await Invoice.find({ orderId: order._id }).lean()).map(row => row.invoiceNumber);
  assert.equal(numbers.length, 2); assert.notEqual(numbers[0], numbers[1]);
});

test('only an admin, only a completed project, only the three upgrade messages', async () => {
  const order = await project();
  assert.equal((await call(`/admin/projects/${order._id}/complimentary-upgrade`, 'POST', { event: 'project.upgrade.offer' }, cookie(customer, 'customer'))).status, 403);
  assert.equal((await call(`/admin/projects/${order._id}/complimentary-upgrade`, 'POST', { event: 'lead.message' })).status, 400);
  const running = await project({ projectProgress: 60 });
  assert.equal((await call(`/admin/projects/${running._id}/complimentary-upgrade`, 'POST', { event: 'project.upgrade.offer' })).status, 409);
  const cancelled = await project({ orderVisibility: 'cancelled' });
  assert.equal((await call(`/admin/projects/${cancelled._id}/complimentary-upgrade`, 'POST', { event: 'project.upgrade.offer' })).status, 409);
  assert.equal(await EmailDraft.countDocuments(), 0);
});

test('a message turned Off in Email Templates is not prepared', async () => {
  const order = await project();
  await EmailPolicy.create({ event: 'project.upgrade.offer', mode: 'off' });
  const result = await call(`/admin/projects/${order._id}/complimentary-upgrade`, 'POST', { event: 'project.upgrade.offer' });
  assert.equal(result.status, 409); assert.match(result.message, /Complimentary upgrade offer is On/);
});

test('the customer finds the invoice by type and on the project; the PDF is the complimentary one', async () => {
  const order = await project();
  await send(await open(order._id, 'project.upgrade.completed'), 'email');
  await Invoice.create({ userId: customer._id, orderId: order._id, invoiceNumber: 'INV-209901-0001', invoiceType: 'project', amount: 25000, dueDate: new Date() });
  const asCustomer = cookie(customer, 'customer');

  const listed = await call('/my-invoices?invoiceType=complimentary_upgrade', 'GET', null, asCustomer);
  assert.equal(listed.data.length, 1); assert.equal(listed.data[0].invoiceType, 'complimentary_upgrade');
  assert.equal((await call('/my-invoices?invoiceType=nonsense', 'GET', null, asCustomer)).status, 400);
  assert.equal((await call('/my-invoices?invoiceType=complimentary_upgrade', 'GET', null, cookie(admin, 'admin'))).data.length, 0, 'only the owner’s own');

  for (const auth of [asCustomer, cookie(admin, 'admin')]) {
    const details = await call(`/order-details/${order._id}`, 'GET', null, auth);
    assert.equal(details.data.complimentaryUpgrades.length, 1);
    assert.equal(details.data.complimentaryUpgrades[0].amount, 0);
  }

  const invoice = await Invoice.findOne({ invoiceType: 'complimentary_upgrade' }).populate('orderId').lean();
  const pdf = await generateInvoiceDocumentPdf({ invoice, order: invoice.orderId, customer });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});
