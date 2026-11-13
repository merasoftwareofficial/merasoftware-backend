const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const service = require('../helpers/communicationActions');

let mongo;
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

const userId = new mongoose.Types.ObjectId();

test('list shows every catalog action with no changes at first', async () => {
  const { actions, surfaces, categories } = await service.list();
  assert.equal(actions.length, 178);
  assert.deepEqual(surfaces, ['Admin', 'Client', 'Website', 'System']);
  assert.ok(categories.includes('Website preview'));
  assert.ok(categories.includes('Reservations'));
  assert.ok(actions.every(row => !row.changed && !row.archived && !row.deleted));
});

test('move, archive, delete and reset are saved and read back', async () => {
  const moved = await service.update('A01', { surface: 'Website', category: 'Orders' }, userId);
  assert.equal(moved.surface, 'Website');
  assert.equal(moved.category, 'Orders');
  assert.equal(moved.changed, true);

  await service.update('A02', { archived: true }, userId);
  await service.update('A03', { deleted: true }, userId);

  const { actions } = await service.list();
  const byId = Object.fromEntries(actions.map(row => [row.id, row]));
  assert.equal(byId.A01.surface, 'Website');
  assert.equal(byId.A01.category, 'Orders');
  assert.equal(byId.A02.archived, true);
  assert.equal(byId.A03.deleted, true);

  const reset = await service.update('A01', { reset: true }, userId);
  assert.equal(reset.surface, 'Admin');
  assert.equal(reset.changed, false);
});

test('update rejects an unknown action and bad input without saving anything', async () => {
  await assert.rejects(service.update('Z99', { archived: true }, userId), /Unknown action/);
  await assert.rejects(service.update('A05', { surface: 'Other' }, userId), /valid surface/);
  await assert.rejects(service.update('A05', {}, userId), /Nothing to change/);
  const { actions } = await service.list();
  assert.equal(actions.find(row => row.id === 'A05').changed, false);
});
