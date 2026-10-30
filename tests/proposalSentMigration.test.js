const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const leadModel = require('../models/leadModel');
const { migrateProposalSentTag } = require('../scripts/migrateProposalSentTag');

let db;
const backupFile = path.join(os.tmpdir(), `proposal-tag-backup-${process.pid}.json`);
const leads = () => mongoose.connection.db.collection('leads');
const updatedAt = new Date('2026-01-01');
const add = extra => leads().insertOne({ name: 'Lead', phone: '9000000001', status: 'Contacted', proposals: [], followUps: [], createdAt: updatedAt, updatedAt, ...extra });
const badge = (value, createdAt) => ({ _id: new mongoose.Types.ObjectId(), note: 'Note', badge: value, createdAt });
const run = options => migrateProposalSentTag(mongoose.connection.db, options);

before(async () => {
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri(), { dbName: 'proposal-tag-isolated-test' });
});
beforeEach(() => leads().deleteMany({}));
after(async () => {
  await mongoose.disconnect();
  await db?.stop();
  fs.rmSync(backupFile, { force: true });
});

test('without apply it only counts; apply needs a backup', async () => {
  await add({ status: 'Proposal Sent' });
  assert.deepEqual(await run(), { toTag: 1, statusToContacted: 1, applied: false });
  await assert.rejects(run({ apply: true }), /--backup/);
  assert.equal((await leads().findOne()).status, 'Proposal Sent');
});

test('the status becomes Contacted and every lead that had a proposal gets the badge, keeping its status', async () => {
  const first = new Date('2026-03-01'), later = new Date('2026-04-01'), file = new Date('2026-02-01');
  const status = await add({ status: 'Proposal Sent', followUps: [badge('Contacted', new Date('2026-01-15')), badge('Proposal Sent', later), badge('Proposal Sent', first)] });
  const won = await add({ status: 'Won', followUps: [badge('Proposal Sent', first)] });
  const negative = await add({ status: 'Negative', followUps: [badge('Proposal Sent', first)] });
  const withFile = await add({ proposals: [{ version: 1, uploadedAt: file }], followUps: [badge('Proposal Sent', first)] });
  const noDate = await add({ status: 'Proposal Sent' });
  const untouched = await add({ followUps: [badge('Positive', first)] });

  const result = await run({ apply: true, backupFile });
  assert.deepEqual(result, { toTag: 5, statusToContacted: 2, applied: true, remainingStatus: 0 });

  const read = async ({ insertedId }) => leads().findOne({ _id: insertedId });
  assert.equal((await read(status)).status, 'Contacted');
  assert.deepEqual((await read(status)).proposalSentAt, first);
  assert.equal((await read(won)).status, 'Won');
  assert.equal((await read(negative)).status, 'Negative');
  assert.deepEqual((await read(withFile)).proposalSentAt, file);
  assert.deepEqual((await read(noDate)).proposalSentAt, updatedAt);
  assert.equal((await read(untouched)).proposalSentAt, undefined);

  const all = await leads().find().toArray();
  assert.ok(all.every(row => row.updatedAt.getTime() === updatedAt.getTime()));
  assert.equal((await read(status)).followUps[1].badge, 'Proposal Sent', 'old badges stay as history');
  assert.equal(JSON.parse(fs.readFileSync(backupFile, 'utf8')).length, 5);
});

test('running again changes nothing and keeps the first date, but catches a status added meanwhile', async () => {
  const first = new Date('2026-03-01');
  const { insertedId } = await add({ status: 'Proposal Sent', followUps: [badge('Proposal Sent', first)] });
  await run({ apply: true, backupFile });
  assert.deepEqual(await run(), { toTag: 0, statusToContacted: 0, applied: false });

  await leads().updateOne({ _id: insertedId }, { $set: { status: 'Proposal Sent' } });
  assert.deepEqual(await run({ apply: true, backupFile }), { toTag: 0, statusToContacted: 1, applied: true, remainingStatus: 0 });
  const row = await leads().findOne({ _id: insertedId });
  assert.equal(row.status, 'Contacted');
  assert.deepEqual(row.proposalSentAt, first);
});

test('a migrated lead saves through the model', async () => {
  const { insertedId } = await add({ status: 'Proposal Sent', followUps: [badge('Proposal Sent', new Date())] });
  await run({ apply: true, backupFile });
  const lead = await leadModel.findById(insertedId);
  lead.followUps.push({ note: 'Next', badge: 'Positive' });
  lead.status = 'Positive';
  await lead.save();
  const row = await leads().findOne({ _id: insertedId });
  assert.equal(row.status, 'Positive');
  assert.ok(row.proposalSentAt);
});
