// Real controllers and storage; disposable MongoDB only. No app/env bootstrap or delivery.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
require('../models/productModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const Transaction = require('../models/transactionModel');
const { approveTransaction, rejectTransaction } = require('../controller/user/transactionApprovalController');
const walletPay = require('../controller/user/walletPayInstant');
const { assertProjectAcceptsUpload } = require('../helpers/projectUploadGate');
let database, customer, admin;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  // Index creation is tested explicitly, so its failure does not hide controller assertions.
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await Transaction.createIndexes();
});
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  [customer, admin] = await User.create([
    { name: 'Foundation Client', email: 'client@example.test', roles: ['customer'], walletBalance: 2000 },
    { name: 'Foundation Admin', email: 'admin@example.test', roles: ['admin'] },
  ]);
});
after(async () => { await mongoose.disconnect(); if (database) await database.stop(); });
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
async function fixture(partial = true) {
  const order = await Order.create({
    userId: customer._id, price: 1000, totalAmount: 1000, remainingAmount: 1000,
    isWebsiteProject: true, isPartialPayment: partial, orderVisibility: 'pending-approval',
    installments: partial ? [
      { installmentNumber: 1, amount: 500, percentage: 50 },
      { installmentNumber: 2, amount: 500, percentage: 50, progressThreshold: 90 },
    ] : [],
  });
  const invoice = await Invoice.create({ userId: customer._id, orderId: order._id,
    invoiceNumber: 'FOUNDATION-1', invoiceType: 'project', amount: partial ? 500 : 1000,
    installmentNumber: partial ? 1 : null, dueDate: new Date() });
  return { order, invoice };
}
async function approve(order, invoice, amount, linkInvoice = true) {
  const transaction = await Transaction.create({ userId: customer._id, orderId: order._id,
    ...(linkInvoice ? { invoiceId: invoice._id } : {}),
    transactionId: new mongoose.Types.ObjectId().toString(), description: 'Isolated foundation payment', amount, status: 'pending',
    paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment',
    sourceType: linkInvoice ? 'invoice' : order.isPartialPayment ? 'installment' : 'order',
    installmentNumber: order.isPartialPayment ? 1 : null,
  });
  const res = response();
  await approveTransaction({ userId: admin._id, userRole: 'admin', params: { transactionId: transaction.transactionId }, body: {} }, res);
  assert.equal(res.statusCode, 200, res.body?.message);
  return { transaction, res };
}
test('both statement uniqueness indexes can be created in the same database', async () => {
  await Invoice.createIndexes();
  const indexes = await Invoice.collection.indexes();
  for (const type of ['project_final', 'service_statement']) {
    assert(indexes.some(index => index.unique && index.partialFilterExpression?.invoiceType === type));
  }
  const orderId = new mongoose.Types.ObjectId();
  const data = { userId: customer._id, orderId, amount: 1000, dueDate: new Date() };
  await Invoice.create({ ...data, invoiceNumber: 'STATEMENT-P', invoiceType: 'project_final' });
  await Invoice.create({ ...data, invoiceNumber: 'STATEMENT-S', invoiceType: 'service_statement' });
  for (const type of ['project_final', 'service_statement']) {
    await assert.rejects(Invoice.create({ ...data, invoiceNumber: `DUP-${type}`, invoiceType: type }), { code: 11000 });
  }
});
for (const linkInvoice of [true, false]) {
  test(`partial UPI ${linkInvoice ? 'invoice' : 'installment'} does not settle or advance an installment`, async () => {
    const { order, invoice } = await fixture();
    await approve(order, invoice, 100, linkInvoice);
    const saved = await Order.findById(order._id);
    assert.equal(saved.installments[0].paid, false);
    assert.equal(saved.currentInstallment, 1);
    assert.equal(saved.paymentComplete, false);
    assert.equal(saved.paidAmount, 100);
    assert.equal(saved.remainingAmount, 900);
    assert.equal(saved.orderVisibility, 'pending-approval');
    assert.equal((await Invoice.findById(invoice._id)).status, 'partially_paid');
  });
}
test('two UPI parts settle only the first installment, preserving the future balance', async () => {
  const { order, invoice } = await fixture();
  await approve(order, invoice, 100);
  await approve(order, invoice, 400);
  const saved = await Order.findById(order._id);
  assert.equal(saved.installments[0].paid, true);
  assert.equal(saved.installments[1].paid, false);
  assert.equal(saved.currentInstallment, 2);
  assert.equal(saved.orderVisibility, 'approved');
  assert.equal(saved.paymentComplete, false);
  assert.equal(saved.remainingAmount, 500);
  assert.equal((await Invoice.findById(invoice._id)).status, 'paid');
});
test('partial full-project UPI payment cannot mark project complete or approve work', async () => {
  const { order, invoice } = await fixture(false);
  await approve(order, invoice, 100);
  const saved = await Order.findById(order._id);
  assert.equal(saved.paymentComplete, false);
  assert.equal(saved.remainingAmount, 900);
  assert.equal(saved.orderVisibility, 'pending-approval');
});
test('full-project order-mode wallet part does not approve or complete the project', async () => {
  const { order } = await fixture(false);
  const res = response();
  await walletPay({ userId: customer._id, body: { orderId: String(order._id), amount: 100, parentTransactionId: 'combined-upi' } }, res);
  assert.equal(res.statusCode, 200, res.body?.message);
  const saved = await Order.findById(order._id);
  assert.equal(saved.paymentComplete, false);
  assert.equal(saved.orderVisibility, 'pending-approval');
  assert.equal(saved.remainingAmount, 900);
});
test('a due partially-paid invoice still locks uploads without an offer policy', async () => {
  const { order, invoice } = await fixture(false);
  order.orderVisibility = 'approved'; await order.save();
  invoice.amountPaid = 100; invoice.status = 'partially_paid'; await invoice.save();
  assert.match(await assertProjectAcceptsUpload(order), /payment.*due/i);
});
test('full UPI settlement completes a full-payment project and repeated approval is refused', async () => {
  const { order, invoice } = await fixture(false);
  const { transaction } = await approve(order, invoice, 1000);
  const saved = await Order.findById(order._id);
  assert.equal(saved.paymentComplete, true);
  assert.equal(saved.remainingAmount, 0);
  assert.equal(saved.orderVisibility, 'approved');
  const res = response();
  await approveTransaction({ userId: admin._id, userRole: 'admin', params: { transactionId: transaction.transactionId }, body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(await Transaction.countDocuments({ orderId: order._id }), 1);
});
test('a final statement alone never locks uploads as an extra payable bill', async () => {
  const { order, invoice } = await fixture(false);
  order.orderVisibility = 'approved'; await order.save();
  await Invoice.deleteOne({ _id: invoice._id });
  await Invoice.create({ userId: customer._id, orderId: order._id, invoiceNumber: 'SUMMARY-ONLY',
    invoiceType: 'project_final', amount: 1000, dueDate: new Date() });
  assert.equal(await assertProjectAcceptsUpload(order), null);
});
test('settling an already-cancelled project does not reopen it', async () => {
  const { order, invoice } = await fixture(false);
  order.orderVisibility = 'cancelled'; await order.save();
  await approve(order, invoice, 1000);
  assert.equal((await Order.findById(order._id)).orderVisibility, 'cancelled');
});
test('approval failure after invoice settlement rolls back invoice, payment and order', async () => {
  const { order, invoice } = await fixture(false);
  const transaction = await Transaction.create({ userId: customer._id, orderId: order._id,
    invoiceId: invoice._id, transactionId: 'failure-approval', description: 'Fault injection',
    amount: 1000, status: 'pending', paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice' });
  const original = Order.prototype.save;
  Order.prototype.save = async function (...args) {
    if (String(this._id) === String(order._id)) throw new Error('Injected order save failure');
    return original.apply(this, args);
  };
  const res = response();
  try {
    await approveTransaction({ userId: admin._id, userRole: 'admin', params: { transactionId: transaction.transactionId }, body: {} }, res);
  } finally { Order.prototype.save = original; }
  assert.equal(res.statusCode, 500);
  assert.equal((await Transaction.findById(transaction._id)).status, 'pending');
  assert.equal((await Invoice.findById(invoice._id)).status, 'unpaid');
  assert.equal((await Invoice.findById(invoice._id)).amountPaid, 0);
  assert.equal((await Order.findById(order._id)).paidAmount, 0);
});
test('wallet failure after debit rolls back wallet, payment and invoice', async () => {
  const { order, invoice } = await fixture(false);
  const original = Order.prototype.save;
  Order.prototype.save = async function (...args) {
    if (String(this._id) === String(order._id)) throw new Error('Injected order save failure');
    return original.apply(this, args);
  };
  const res = response();
  try {
    await walletPay({ userId: customer._id, body: { orderId: String(order._id), invoiceId: String(invoice._id), amount: 1000 } }, res);
  } finally { Order.prototype.save = original; }
  assert.equal(res.statusCode, 500);
  assert.equal((await User.findById(customer._id)).walletBalance, 2000);
  assert.equal(await Transaction.countDocuments({ orderId: order._id }), 0);
  assert.equal((await Invoice.findById(invoice._id)).status, 'unpaid');
});
test('sequential order-mode wallet parts settle their invoice and advance only when covered', async () => {
  const { order, invoice } = await fixture();
  for (const amount of [100, 400]) {
    const res = response();
    await walletPay({ userId: customer._id, body: { orderId: String(order._id), installmentNumber: 1, amount } }, res);
    assert.equal(res.statusCode, 200, res.body?.message);
    assert.equal((await Invoice.findById(invoice._id)).amountPaid, amount === 100 ? 100 : 500);
    assert.equal((await Order.findById(order._id)).currentInstallment, amount === 100 ? 1 : 2);
  }
  assert.equal((await User.findById(customer._id)).walletBalance, 1500);
});
test('wallet rejects summary, cross-project invoice and overpayment without debiting', async () => {
  const { order } = await fixture();
  const summary = await Invoice.create({ userId: customer._id, orderId: order._id,
    invoiceNumber: 'NOT-PAYABLE', invoiceType: 'project_final', amount: 1000, dueDate: new Date() });
  const other = await Invoice.create({ userId: customer._id, orderId: new mongoose.Types.ObjectId(),
    invoiceNumber: 'OTHER-PROJECT', invoiceType: 'project', amount: 1000, dueDate: new Date() });
  for (const body of [{ invoiceId: String(summary._id), amount: 100 }, { invoiceId: String(other._id), amount: 100 }, { amount: 501, installmentNumber: 1 }]) {
    const res = response(); await walletPay({ userId: customer._id, body: { orderId: String(order._id), ...body } }, res);
    assert.equal(res.statusCode, 400, res.body?.message);
  }
  assert.equal((await User.findById(customer._id)).walletBalance, 2000);
  assert.equal(await Transaction.countDocuments(), 0);
});
test('two simultaneous wallet payments cannot collect the same installment twice', async () => {
  const { order, invoice } = await fixture();
  const replies = [response(), response()];
  await Promise.all(replies.map(res => walletPay({ userId: customer._id,
    body: { orderId: String(order._id), invoiceId: String(invoice._id), amount: 500 } }, res)));
  assert.deepEqual(replies.map(res => res.statusCode).sort(), [200, 400]);
  assert.equal((await User.findById(customer._id)).walletBalance, 1500);
  assert.equal(await Transaction.countDocuments({ type: 'payment' }), 1);
  assert.equal((await Invoice.findById(invoice._id)).amountPaid, 500);
});
test('combined wallet retry reuses the received payment and does not debit again', async () => {
  const { order, invoice } = await fixture();
  const body = { orderId: String(order._id), invoiceId: String(invoice._id), amount: 100, parentTransactionId: 'retry-combined' };
  for (let index = 0; index < 2; index++) {
    const res = response(); await walletPay({ userId: customer._id, body }, res);
    assert.equal(res.statusCode, 200, res.body?.message);
  }
  assert.equal((await User.findById(customer._id)).walletBalance, 1900);
  assert.equal(await Transaction.countDocuments({ type: 'payment' }), 1);
});
test('combined UPI rejection refunds wallet and reconciles invoice/order exactly once', async () => {
  const { order, invoice } = await fixture();
  const walletResponse = response();
  await walletPay({ userId: customer._id, body: { orderId: String(order._id), invoiceId: String(invoice._id), amount: 100, parentTransactionId: 'reject-combined' } }, walletResponse);
  assert.equal(walletResponse.statusCode, 200);
  const transaction = await Transaction.create({ userId: customer._id, orderId: order._id, invoiceId: invoice._id,
    installmentNumber: 1, transactionId: 'reject-combined', description: 'Pending UPI remainder', amount: 400,
    status: 'pending', paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice' });
  const request = { userId: admin._id, userRole: 'admin', params: { transactionId: transaction.transactionId }, body: { rejectionReason: 'Not received' } };
  const res = response(); await rejectTransaction(request, res);
  assert.equal(res.statusCode, 200, res.body?.message);
  assert.equal((await User.findById(customer._id)).walletBalance, 2000);
  assert.equal((await Invoice.findById(invoice._id)).amountPaid, 0);
  assert.equal((await Order.findById(order._id)).paidAmount, 0);
  assert.equal((await Order.findById(order._id)).remainingAmount, 1000);
  const retry = response(); await rejectTransaction(request, retry);
  assert.equal(retry.statusCode, 400);
  assert.equal(await Transaction.countDocuments({ type: 'refund' }), 1);
});
test('simultaneous approvals of the same UPI payment commit just once', async () => {
  const { order, invoice } = await fixture();
  const transaction = await Transaction.create({ userId: customer._id, orderId: order._id, invoiceId: invoice._id,
    installmentNumber: 1, transactionId: 'concurrent-approve', description: 'Concurrent UPI', amount: 500,
    status: 'pending', paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice' });
  const request = { userId: admin._id, userRole: 'admin', params: { transactionId: transaction.transactionId }, body: {} };
  const replies = [response(), response()];
  await Promise.all(replies.map(res => approveTransaction(request, res)));
  assert.deepEqual(replies.map(res => res.statusCode).sort(), [200, 400]);
  assert.equal((await Invoice.findById(invoice._id)).amountPaid, 500);
  assert.equal((await Order.findById(order._id)).paidAmount, 500);
});
test('combined rejection failure rolls back its refund and rejection together', async () => {
  const { order, invoice } = await fixture();
  const walletReply = response();
  await walletPay({ userId: customer._id, body: { orderId: String(order._id), invoiceId: String(invoice._id), amount: 100, parentTransactionId: 'reject-rollback' } }, walletReply);
  const transaction = await Transaction.create({ userId: customer._id, orderId: order._id, invoiceId: invoice._id,
    installmentNumber: 1, transactionId: 'reject-rollback', description: 'UPI remainder', amount: 400,
    status: 'pending', paymentStatus: 'pending-approval', paymentMethod: 'upi', type: 'payment', sourceType: 'invoice' });
  const original = Order.prototype.save;
  Order.prototype.save = async function (...args) {
    if (String(this._id) === String(order._id)) throw new Error('Injected rejection failure');
    return original.apply(this, args);
  };
  const res = response();
  try {
    await rejectTransaction({ userId: admin._id, userRole: 'admin', params: { transactionId: transaction.transactionId }, body: { rejectionReason: 'Not received' } }, res);
  } finally { Order.prototype.save = original; }
  assert.equal(res.statusCode, 500);
  assert.equal((await User.findById(customer._id)).walletBalance, 1900);
  assert.equal((await Transaction.findById(transaction._id)).status, 'pending');
  assert.equal(await Transaction.countDocuments({ type: 'refund' }), 0);
  assert.equal((await Invoice.findById(invoice._id)).amountPaid, 100);
});
test('final-summary save failure also rolls back the wallet and settled order', async () => {
  const { order, invoice } = await fixture(false);
  const original = Invoice.prototype.save;
  Invoice.prototype.save = async function (...args) {
    if (this.invoiceType === 'project_final') throw new Error('Injected statement failure');
    return original.apply(this, args);
  };
  const res = response();
  try {
    await walletPay({ userId: customer._id, body: { orderId: String(order._id), invoiceId: String(invoice._id), amount: 1000 } }, res);
  } finally { Invoice.prototype.save = original; }
  assert.equal(res.statusCode, 500);
  assert.equal((await User.findById(customer._id)).walletBalance, 2000);
  assert.equal((await Invoice.findById(invoice._id)).status, 'unpaid');
  assert.equal((await Order.findById(order._id)).paidAmount, 0);
  assert.equal(await Transaction.countDocuments(), 0);
});
