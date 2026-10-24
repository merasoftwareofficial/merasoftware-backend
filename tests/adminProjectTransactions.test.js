const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const Category = require('../models/categoryBasePriceModel');
const createProject = require('../controller/order/adminCreateProjectOrder');
const approveProject = require('../controller/order/approveProjectOrder');
let database, admin, customer;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User.init(), Order.init(), Invoice.init(), Transaction.init(), Category.init()]);
});
after(async () => { await mongoose.disconnect(); if (database) await database.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [admin, customer] = await User.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Client', email: 'client@example.test', roles: ['customer'] },
  ]);
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
});
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
async function create(body = {}) {
  const res = response();
  await createProject({ userId: admin._id, userRole: 'admin', params: { customerId: String(customer._id) },
    body: { category: 'standard_websites', sellingPrice: 1000, paymentType: 'full', ...body } }, res);
  return res;
}
test('failed final statement leaves no created project, payment or invoice', async () => {
  const save = Invoice.prototype.save;
  Invoice.prototype.save = async function (...args) {
    if (this.invoiceType === 'project_final') throw new Error('Injected statement failure');
    return save.apply(this, args);
  };
  let res;
  try { res = await create({ recordPayment: { paymentMethod: 'cash' }, creationKey: 'atomic-create-failure-01' }); }
  finally { Invoice.prototype.save = save; }
  assert.equal(res.statusCode, 500);
  assert.equal(await Order.countDocuments(), 0);
  assert.equal(await Invoice.countDocuments(), 0);
  assert.equal(await Transaction.countDocuments(), 0);
  const retry = await create({ creationKey: 'atomic-create-failure-01', recordPayment: { paymentMethod: 'cash' } });
  assert.equal(retry.statusCode, 201, retry.body?.message);
});
test('manual approval failure leaves its original invoice/order unpaid', async () => {
  const created = await create();
  assert.equal(created.statusCode, 201, created.body?.message);
  const save = Order.prototype.save;
  Order.prototype.save = async function (...args) {
    if (String(this._id) === String(created.body.data._id)) throw new Error('Injected approval failure');
    return save.apply(this, args);
  };
  const res = response();
  try { await approveProject({ userId: admin._id, userRole: 'admin', params: { orderId: String(created.body.data._id) }, body: { mode: 'approve_with_payment', paymentMethod: 'cash' } }, res); }
  finally { Order.prototype.save = save; }
  assert.equal(res.statusCode, 500);
  const invoice = await Invoice.findOne({ orderId: created.body.data._id, invoiceType: 'project' });
  assert.equal(invoice.status, 'unpaid');
  assert.equal(invoice.amountPaid, 0);
  assert.equal(await Transaction.countDocuments(), 0);
  const order = await Order.findById(created.body.data._id);
  assert.equal(order.paidAmount, 0);
  assert.equal(order.orderVisibility, 'pending-approval');
});
test('successful create-with-payment and retried key produce one consistent project', async () => {
  const body = { creationKey: 'atomic-create-success-01', paymentType: 'partial', installmentCount: 3, recordPayment: { paymentMethod: 'cash' } };
  const first = await create(body);
  assert.equal(first.statusCode, 201, first.body?.message);
  const retry = await create(body);
  assert.equal(retry.statusCode, 200, retry.body?.message);
  assert.equal(String(first.body.data._id), String(retry.body.data._id));
  assert.equal(await Transaction.countDocuments(), 1);
  const order = await Order.findById(first.body.data._id);
  assert.equal(order.paidAmount, 300);
  assert.equal(order.remainingAmount, 700);
  assert.equal(order.installments[0].paid, true);
  assert.equal(order.currentInstallment, 2);
  assert.equal(order.paymentComplete, false);
});
test('concurrent manual approvals collect one first payment', async () => {
  const created = await create({ paymentType: 'partial', installmentCount: 2 });
  const request = { userId: admin._id, userRole: 'admin', params: { orderId: String(created.body.data._id) }, body: { mode: 'approve_with_payment', paymentMethod: 'cash' } };
  const replies = [response(), response()];
  await Promise.all(replies.map(res => approveProject(request, res)));
  assert.deepEqual(replies.map(res => res.statusCode).sort(), [200, 400]);
  assert.equal(await Transaction.countDocuments({ orderId: created.body.data._id }), 1);
  const order = await Order.findById(created.body.data._id);
  assert.equal(order.paidAmount, 500);
  assert.equal(order.remainingAmount, 500);
  assert.equal(order.currentInstallment, 2);
});
test('concurrent approve/reject cannot leave a received project rejected', async () => {
  const created = await create();
  const base = { userId: admin._id, userRole: 'admin', params: { orderId: String(created.body.data._id) } };
  const yes = response(), no = response();
  await Promise.all([
    approveProject({ ...base, body: { mode: 'approve_with_payment', paymentMethod: 'cash' } }, yes),
    approveProject({ ...base, body: { mode: 'reject', rejectionReason: 'Not proceeding' } }, no),
  ]);
  assert.deepEqual([yes.statusCode, no.statusCode].sort(), [200, 400]);
  const order = await Order.findById(created.body.data._id);
  if (yes.statusCode === 200) {
    assert.equal(order.orderVisibility, 'approved');
    assert.equal(order.paidAmount, 1000);
    assert.equal(await Transaction.countDocuments(), 1);
  } else {
    assert.equal(order.orderVisibility, 'payment-rejected');
    assert.equal(order.paidAmount, 0);
    assert.equal(await Transaction.countDocuments(), 0);
  }
});
test('simultaneous create requests with one key leave one complete project and invoice', async () => {
  const body = { creationKey: 'simultaneous-creation-01', recordPayment: { paymentMethod: 'cash' } };
  const replies = await Promise.all([create(body), create(body)]);
  assert(replies.some(res => res.statusCode === 201));
  assert(replies.every(res => [200, 201, 409].includes(res.statusCode)));
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await Invoice.countDocuments({ invoiceType: 'project' }), 1);
  assert.equal(await Invoice.countDocuments({ invoiceType: 'project_final' }), 1);
  assert.equal(await Transaction.countDocuments(), 1);
  assert.equal((await Order.findOne()).projectCreationComplete, true);
});
