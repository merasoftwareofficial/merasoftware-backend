const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Invoice = require('../models/invoiceModel');
const Monthly = require('../models/monthlyInvoiceModel');
const Order = require('../models/orderProductModel');
require('../models/productModel');
const readInvoices = require('../helpers/customerInvoices');
const scoped = require('../controller/user/getMyInvoices');
const dashboard = require('../controller/user/getAdminClients').dashboard;
let db, customer, other, order;
const id = () => new mongoose.Types.ObjectId();
async function invoke(handler, req) {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler(req, res); return res;
}
before(async () => {
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri(), { dbName: 'merasoftware-fix-test' });
  customer = id(); other = id(); order = id();
  await User.collection.insertMany([
    { _id: customer, name: 'Active', email: 'one@example.test', roles: ['customer'], status: 'active', createdAt: new Date('2026-10-12') },
    { _id: other, name: 'Inactive', email: 'two@example.test', roles: ['customer'], status: 'inactive', createdAt: new Date('2026-09-10') },
    { name: 'Guest', email: 'guest@example.test', roles: ['customer'], isGuest: true, createdAt: new Date('2020-01-01') },
  ]);
  await Order.collection.insertOne({ _id: order, userId: customer, createdAt: new Date('2026-10-15') });
  await Invoice.collection.insertMany([
    { userId: customer, orderId: order, invoiceNumber: 'OWN-1', amount: 100, invoiceDate: new Date('2026-10-15') },
    { userId: other, orderId: id(), invoiceNumber: 'OTHER', amount: 999, invoiceDate: new Date('2026-10-16') },
  ]);
  await Monthly.collection.insertOne({ userId: customer, orderId: order, invoiceNumber: 'OWN-2', amount: 200, invoiceDate: new Date('2026-10-17') });
});
after(async () => { await mongoose.disconnect(); await db.stop(); });

test('scoped invoice list matches shared projection and cannot cross account boundary', async () => {
  const all = await readInvoices({ userId: customer });
  const own = await invoke(scoped, { userId: String(customer), query: { orderId: String(order) } });
  assert.equal(own.code, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(own.body.data)), JSON.parse(JSON.stringify(all)));
  const target = await invoke(scoped, { userId: String(customer), query: { invoiceId: String(all[0]._id) } });
  assert.equal(target.body.data.length, 1);
  assert.equal(String(target.body.data[0]._id), String(all[0]._id));
  const denied = await invoke(scoped, { userId: String(other), query: { orderId: String(order) } });
  assert.deepEqual(denied.body.data, []);
  const invalid = await invoke(scoped, { userId: String(customer), query: { orderId: { $ne: '' } } });
  assert.equal(invalid.code, 400);
});

test('dashboard keeps exact client statistics/latest activity, bounds rows, and never purges guests', async () => {
  const req = { userRole: 'admin', query: { monthStart: '2026-10-01T00:00:00Z', monthEnd: '2026-11-01T00:00:00Z' } };
  const res = await invoke(dashboard, req);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.total, 2);
  assert.equal(res.body.data.active, 1);
  assert.equal(res.body.data.inactive, 1);
  assert.equal(res.body.data.joinedThisMonth, 1);
  assert.equal(String(res.body.data.recentClients[0]._id), String(customer));
  assert.ok(await User.exists({ email: 'guest@example.test' }));
  const rows = Array.from({ length: 8 }, (_, index) => ({ email: `more${index}@example.test`, roles: ['customer'], createdAt: new Date('2026-01-01') }));
  await User.collection.insertMany(rows);
  assert.equal((await invoke(dashboard, req)).body.data.recentClients.length, 6);
  assert.equal((await invoke(dashboard, { ...req, userRole: 'customer' })).code, 403);
  assert.equal((await invoke(dashboard, { ...req, query: {} })).code, 400);
});

test('database activity reduction matches legacy candidates across all five collections', async () => {
  const customers = Array.from({ length: 5 }, () => id());
  const at = day => new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`);
  await User.collection.insertMany(customers.map((_id, i) => ({ _id, email: `activity${i}@example.test`, roles: ['customer'], createdAt: at(1), updatedAt: at(2) })));
  const fields = [
    [Order, { checkpoints: [{ completedAt: at(20) }], messages: [{ timestamp: at(19) }], projectNodeEvents: [{ occurredAt: at(18) }], monthlyRenewalHistory: [{ renewalDate: at(17) }] }],
    [require('../models/updateRequestModel'), { instructions: [{ timestamp: at(17) }], developerNotes: [{ timestamp: at(19) }], developerMessages: [{ timestamp: at(20) }], completedAt: at(16) }],
    [require('../models/transactionModel'), { paymentStatus: 'rejected', rejectedAt: at(20), verificationDate: at(18) }],
    [Monthly, { status: 'paid', paidDate: at(20) }],
    [require('../models/ticketModel'), { messages: [{ timestamp: at(19) }], statusHistory: [{ timestamp: at(20) }] }],
  ];
  for (let i = 0; i < fields.length; i++) {
    const [model, extra] = fields[i];
    await model.collection.insertMany(Array.from({ length: 3 }, (_, n) => ({ userId: customers[i], transactionId: `activity-${i}-${n}`, invoiceNumber: `activity-${i}-${n}`, ticketId: `activity-${i}-${n}`, createdAt: at(3 + n), updatedAt: at(4 + n), ...extra })));
  }
  const req = { userRole: 'admin', query: {} };
  await User.updateOne({ email: 'guest@example.test' }, { $set: { lastActivityAt: new Date() } });
  const response = await invoke(require('../controller/user/getAdminClients'), req);
  const expectedSources = ['checkpoint_completed', 'developer_message', 'payment_updated', 'invoice_paid', 'ticket_status_updated'];
  for (let i = 0; i < customers.length; i++) {
    const row = response.body.data.find(candidate => String(candidate._id) === String(customers[i]));
    assert.equal(row.latestActivitySource, expectedSources[i]);
    assert.equal(new Date(row.latestActivityAt).getTime(), at(20).getTime());
  }
});

test('admin order-scoped workspace retains invoice grouping and excludes other orders', async () => {
  const workspace = require('../controller/user/getAdminUserWorkspace');
  const res = await invoke(workspace, { userRole: 'admin', query: { customerId: String(customer), orderId: String(order) } });
  assert.equal(res.code, 200);
  assert.equal(res.body.data.orders.length, 1);
  assert.equal(res.body.data.invoices.length, 2);
  assert.ok(res.body.data.invoices.every(invoice => String(invoice.orderId?._id || invoice.orderId) === String(order)));
  const general = await invoke(workspace, { userRole: 'admin', query: { customerId: String(customer), orderId: 'general' } });
  assert.equal(general.body.data.orders.length, 0);
  assert.equal(general.body.data.invoices.length, 0);
});
