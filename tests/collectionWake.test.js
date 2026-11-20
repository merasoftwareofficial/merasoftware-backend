const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server');
const { createCollectionWake } = require('../helpers/collectionWake');

test('collectionWake wakes immediately on replica-set writes, filters noise, and prevents missed-wakeup races', async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const conn = await mongoose.createConnection(replSet.getUri()).asPromise();
  try {
    const col = conn.db.collection('wake_test_items');
    await col.insertOne({ _id: 'seed', heartbeatAt: new Date(), status: 'idle' });

    const ignored = new Set(['heartbeatAt', 'updatedAt']);
    const wake = createCollectionWake({
      connection: conn,
      collections: ['wake_test_items'],
      operations: ['insert', 'update', 'replace'],
      maxAwaitTimeMS: 5_000,
      fallbackMs: 5_000,
      filter: change => {
        if (change.operationType !== 'update') return true;
        const fields = Object.keys(change.updateDescription?.updatedFields || {});
        return !fields.length || fields.some(field => !ignored.has(field));
      },
    });

    await wake.start();
    assert.equal(wake.isLive(), true, 'change stream should be live on replica set');

    // 1. Heartbeat-only update must NOT wake or bump version.
    const v0 = wake.version();
    await col.updateOne({ _id: 'seed' }, { $set: { heartbeatAt: new Date() } });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(wake.version(), v0, 'heartbeat-only update should be filtered out');

    // 2. Real change wakes an active waiter well before maxMs (10s).
    const beforeInsert = wake.version();
    const startMs = Date.now();
    const waiting = wake.wait(10_000, beforeInsert);
    setTimeout(() => { void col.insertOne({ _id: 'job-1', status: 'queued' }); }, 40);
    await waiting;
    const elapsed = Date.now() - startMs;
    assert.ok(elapsed < 2_000, `expected fast change-stream wake, got ${elapsed}ms`);
    assert.ok(wake.version() > beforeInsert);

    // 3. Mid-step race guard: change occurs BEFORE wait(maxMs, before) is called -> resolves in 0ms.
    const beforeRace = wake.version();
    await col.updateOne({ _id: 'job-1' }, { $set: { status: 'running' } });
    for (let i = 0; i < 40 && wake.version() === beforeRace; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(wake.version() > beforeRace, 'real update should bump version');
    const raceStart = Date.now();
    await wake.wait(10_000, beforeRace);
    assert.ok(Date.now() - raceStart < 100, 'wait() with stale sinceVersion must resolve immediately');

    // 4. close() resolves a pending waiter immediately.
    const closeStart = Date.now();
    const pendingClose = wake.wait(10_000, wake.version());
    await wake.close();
    await pendingClose;
    assert.ok(Date.now() - closeStart < 500, 'close() must resolve pending wait');
  } finally {
    await conn.close();
    await replSet.stop();
  }
});

test('collectionWake falls back gracefully on standalone MongoDB without crashing', async () => {
  const standalone = await MongoMemoryServer.create();
  const conn = await mongoose.createConnection(standalone.getUri()).asPromise();
  try {
    const wake = createCollectionWake({
      connection: conn,
      collections: ['standalone_items'],
      fallbackMs: 80,
    });
    await wake.start();
    assert.equal(wake.isLive(), false);
    const start = Date.now();
    await wake.wait(5_000, wake.version());
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1_000, `expected fallbackMs (~80ms) cap, got ${elapsed}ms`);
    await wake.close();
  } finally {
    await conn.close();
    await standalone.stop();
  }
});
