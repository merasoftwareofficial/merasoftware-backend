const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const bandwidthTracker = require('../helpers/bandwidthTracker');

test('attachMongoClient measures native BSON outbound/inbound bytes per process and supports 1h/24h/reset', async () => {
  const server = await MongoMemoryServer.create();
  const conn = await mongoose.createConnection(server.getUri(), { monitorCommands: true }).asPromise();
  try {
    bandwidthTracker.reset();
    // Attaching twice must be idempotent (WeakSet).
    bandwidthTracker.attachMongoClient(conn.getClient());
    bandwidthTracker.attachMongoClient(conn.getClient());

    const col = conn.db.collection('bw_test_docs');

    await bandwidthTracker.runWithProcess('Phase5 Test Cron', 'cron', async () => {
      await col.insertOne({ _id: 'doc-1', title: 'Hello Render Bandwidth', payload: 'x'.repeat(200) });
      await col.findOne({ _id: 'doc-1' });
    });

    // Unscoped DB call must automatically fall back to DB: <collection>
    await col.find({ _id: 'doc-1' }).toArray();

    const r1 = bandwidthTracker.getReport('1h');
    const r24 = bandwidthTracker.getReport('24h');
    assert.equal(r1.window, '1h');
    assert.equal(r24.window, '24h');

    const cronRow = r24.processes.find(p => p.name === 'Phase5 Test Cron');
    assert.ok(cronRow, 'scoped cron process must appear in report');
    assert.equal(cronRow.category, 'cron');
    assert.equal(cronRow.runs, 1);
    assert.equal(cronRow.dbWrites, 1);
    assert.equal(cronRow.dbReads, 1);
    assert.ok(cronRow.dbOutBytes > 300, `expected real outbound BSON bytes, got ${cronRow.dbOutBytes}`);
    assert.ok(cronRow.dbInBytes > 200, `expected real inbound BSON reply bytes, got ${cronRow.dbInBytes}`);

    const fallbackRow = r24.processes.find(p => p.name === 'DB: bw_test_docs');
    assert.ok(fallbackRow, 'unscoped DB call must appear under DB: <collection>');
    assert.equal(fallbackRow.dbReads, 1);
    assert.ok(fallbackRow.dbOutBytes > 0);

    bandwidthTracker.reset();
    assert.equal(bandwidthTracker.getReport('24h').processes.length, 0);
  } finally {
    await conn.close();
    await server.stop();
  }
});
