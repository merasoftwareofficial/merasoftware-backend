const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
require('../models/productModel');
const { EmailDraft, EmailTemplate, EmailHistory, EmailPolicy } = require('../models/emailControlModel');
const Legacy = require('../models/messageTemplateModel');
const { requestMiddleware } = require('../helpers/emailController');
const { initializeProjectTimeline } = require('../helpers/projectNodeService');
const nodes = require('../controller/order/projectNodeController');
const auth = require('../middleware/authToken');
let db, server, base, admin, customer, other, order;
before(async () => {
  process.env.TOKEN_SECRET_KEY = 'node-settings-isolated';
  process.env.ENABLE_WHATSAPP = 'true';
  db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri());
  await Promise.all([EmailDraft, EmailTemplate, EmailHistory, User].map(model => model.init()));
  const app = express(); app.use(express.json()); app.use(require('cookie-parser')()); app.use(requestMiddleware);
  app.all('/settings', auth, require('../controller/admin/mySettings'));
  app.post('/projects/:orderId/nodes', auth, nodes.createProjectNode);
  app.post('/projects/:orderId/message', auth, nodes.prepareProjectNodeMessage);
  app.use('/email-control', require('../routes/emailControl'));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map(collection => collection.deleteMany({})));
  [admin, customer, other] = await User.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Ravi', email: 'ravi@example.test', phone: '+919876543210', roles: ['customer'] },
    { name: 'Other', email: 'other@example.test', roles: ['admin'] },
  ]);
  order = new Order({ userId: customer._id, price: 1000, isWebsiteProject: true, projectSnapshot: { displayName: 'Ravi Website', category: 'standard_websites' } });
  initializeProjectTimeline({ order, startingNodeTitle: 'Started', actorId: admin._id }); await order.save();
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });
async function api(path, body, user = admin, method = 'POST') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const add = body => api(`/projects/${order._id}/nodes`, { title: 'Design ready', cumulativeProgress: 35.5, requestId: randomUUID(), ...body });

test('node save opens one central dynamic review; same request and message retry never duplicate work', async () => {
  const requestId = randomUUID();
  const saved = await add({ requestId }); assert.equal(saved.success, true, saved.message);
  assert.equal(saved.emailStatus, 'awaiting-review');
  const draft = await EmailDraft.findById(saved.emailDraftIds[0]);
  assert.ok(draft.html.includes('Ravi')); assert.ok(draft.html.includes('35.5%')); assert.ok(draft.html.includes('Design ready'));
  assert.equal(draft.values.get('project'), 'Ravi Website');
  const retry = await add({ requestId }); assert.deepEqual(retry.emailDraftIds, saved.emailDraftIds);
  const conflict = await add({ requestId, title: 'Different' }); assert.equal(conflict.status, 409);
  assert.equal((await Order.findById(order._id)).projectNodes.length, 2);
  assert.equal(await EmailDraft.countDocuments(), 1);
  const skip = await api(`/email-control/drafts/${draft._id}/decision`, { choice: 'skip' }); assert.equal(skip.success, true);
  const review = await api(`/projects/${order._id}/message`, { nodeId: saved.savedNodeId }); assert.equal(review.emailStatus, 'skipped');
});
test('concurrent same-key node requests persist only one node and recover through retry', async () => {
  const requestId = randomUUID(); await Promise.all([add({ requestId }), add({ requestId })]);
  const retry = await add({ requestId }); assert.equal(retry.success, true);
  assert.equal((await Order.findById(order._id)).projectNodes.length, 2); assert.equal(await EmailDraft.countDocuments(), 1);
});
test('message preparation failure preserves node and retry prepares it without mutation', async () => {
  const create = EmailDraft.create; EmailDraft.create = async () => { throw new Error('Injected draft outage'); };
  let saved; try { saved = await add(); } finally { EmailDraft.create = create; }
  assert.equal(saved.success, true); assert.equal(saved.emailStatus, 'unavailable');
  const recovered = await api(`/projects/${order._id}/message`, { nodeId: saved.savedNodeId }); assert.equal(recovered.emailStatus, 'awaiting-review');
  assert.equal((await Order.findById(order._id)).projectNodes.length, 2);
});
test('Off saves work without draft, invalid work does not draft, customer cannot add nodes', async () => {
  await EmailPolicy.create({ event: 'sendProjectUpdateEmail', mode: 'off' });
  assert.equal((await add()).emailStatus, 'disabled-or-unavailable'); assert.equal(await EmailDraft.countDocuments(), 0);
  assert.equal((await add({ cumulativeProgress: 20 })).success, false);
  assert.equal((await api(`/projects/${order._id}/nodes`, { title: 'Forged', cumulativeProgress: 90 }, customer)).status, 403);
});
test('phone-only project builder supports WhatsApp without fabricating an email', () => {
  const mail = require('../helpers/emailTemplates').buildTemplatedMail('sendProjectUpdateEmail', { name: 'Ravi', phone: '+919876543210' }, { projectProgress: 20 });
  assert.deepEqual(mail.to, []); assert.equal(mail.phone, '+919876543210');
});
test('interrupted staged draft is recovered, expired draft never creates another notification', async () => {
  const saved = await add();
  const id = saved.emailDraftIds[0];
  await EmailDraft.updateOne({ _id: id }, { $set: { status: 'staged' } });
  const recovered = await api(`/projects/${order._id}/message`, { nodeId: saved.savedNodeId });
  assert.equal(recovered.emailStatus, 'awaiting-review'); assert.equal((await EmailDraft.findById(id)).status, 'pending');
  await EmailDraft.updateOne({ _id: id }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await api(`/projects/${order._id}/message`, { nodeId: saved.savedNodeId })).emailStatus, 'expired');
  assert.equal(await EmailDraft.countDocuments(), 1);
});
test('deleted or hidden nodes cannot prepare a new customer notification', async () => {
  await EmailPolicy.create({ event: 'sendProjectUpdateEmail', mode: 'off' });
  const saved = await add(); await EmailPolicy.deleteMany({});
  await Order.updateOne({ _id: order._id, 'projectNodes.nodeId': saved.savedNodeId }, { $set: { 'projectNodes.$.visibleToClient': false } });
  assert.equal((await api(`/projects/${order._id}/message`, { nodeId: saved.savedNodeId })).emailStatus, 'not-available');
  assert.equal(await EmailDraft.countDocuments(), 0);
});
test('legacy migration is repeatable, excludes broadcasts and preserves edited central templates', async () => {
  const { migrateNodeTemplates } = require('../helpers/migrateNodeTemplates');
  await Legacy.create([{ name: 'Old', message: 'Hello {{name}}' }, { name: 'Broadcast', message: 'Broadcast only', purpose: 'broadcast' }]);
  await migrateNodeTemplates({ apply: true }); await migrateNodeTemplates({ apply: true });
  assert.equal(await EmailTemplate.countDocuments(), 1); assert.equal(await Legacy.countDocuments(), 2);
  const { systemTemplate } = require('../helpers/emailTemplates');
  const legacy = require('../helpers/legacyProjectUpdateTemplate');
  const row = await EmailTemplate.create({ event: 'sendProjectUpdateEmail', system: true, name: 'Standard', ...legacy });
  const upgraded = await systemTemplate('sendProjectUpdateEmail'); assert.ok(!upgraded.text.includes('working diligently'));
  await EmailTemplate.updateOne({ _id: row._id }, { $set: { text: 'My edited template {{name}}' } });
  assert.equal((await systemTemplate('sendProjectUpdateEmail')).text, 'My edited template {{name}}');
  await EmailTemplate.deleteOne({ legacySourceId: { $exists: true } });
  await systemTemplate('sendProjectUpdateEmail');
  assert.equal(await EmailTemplate.countDocuments({ legacySourceId: { $exists: true } }), 0, 'deleted imported templates stay deleted');
});
test('admin contacts normalize and persist for the authenticated admin only; login stays unchanged', async () => {
  const result = await api('/settings', { name: 'New Admin', contactEmail: 'CONTACT@example.test', whatsappNumbers: ['+919876543210', '+14155552671'], userId: String(other._id), email: 'forged@example.test' }, admin, 'PATCH');
  assert.equal(result.success, true, result.message); assert.equal(result.data.contactEmail, 'contact@example.test');
  assert.equal(result.data.loginEmail, 'admin@example.test'); assert.deepEqual(result.data.whatsappNumbers, ['+919876543210', '+14155552671']);
  assert.equal((await User.findById(other._id)).name, 'Other');
  assert.equal((await api('/settings', null, admin, 'GET')).data.name, 'New Admin');
  assert.equal((await api('/settings', null, customer, 'GET')).status, 403);
  await User.updateOne({ _id: admin._id }, { $set: { roles: ['customer'] } });
  assert.equal((await api('/settings', null, admin, 'GET')).status, 403);
});
test('invalid contacts and duplicate normalized numbers cannot change saved settings', async () => {
  for (const body of [
    { contactEmail: 'invalid' }, { whatsappNumbers: ['+91123'] }, { whatsappNumbers: ['+919876543210', '+919876543210'] },
    { whatsappNumbers: ['+919876543210', '+14155552671', '+919876543211'] },
  ]) assert.equal((await api('/settings', { name: 'Admin', contactEmail: '', whatsappNumbers: [], ...body }, admin, 'PATCH')).status, 400);
  assert.equal((await User.findById(admin._id)).adminContact.email, '');
});
