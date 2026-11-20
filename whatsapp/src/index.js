import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import mongoose from 'mongoose';
import pino from 'pino';
import bandwidthTracker from '../../helpers/bandwidthTracker.js';
import collectionWakeModule from '../../helpers/collectionWake.js';
bandwidthTracker.startChildReporter('WhatsApp Worker', 'worker');
const { createCollectionWake } = collectionWakeModule;
import { loadConfig } from './config.js';
import { Auth, Inbox, Lock, Queue, Rule, State, STATE_ID } from './models.js';
import { createInbound } from './inbound.js';
import { createLease } from './lease.js';
import { createSender } from './sender.js';
import { createConnection } from './whatsapp.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });

// Run on its own (a separate Render service), it needs an open port for Render and UptimeRobot.
// It shows nothing private: the QR and the queue are read by the portal backend from the database.
if (!config.embedded) {
  http.createServer((req, res) => {
    if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true }));
    }
    res.writeHead(404).end();
  }).listen(config.port, () => console.log(`Health check on port ${config.port}`));
}

// Render's free plan shows no memory graph; this line in the logs is how memory is watched.
setInterval(() => console.log(`[whatsapp] memory rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`), 10 * 60_000).unref();

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000, monitorCommands: true });
bandwidthTracker.attachMongoClient(mongoose.connection.getClient());
console.log('Connected to DB');

if (!config.senderEnabled) {
  console.log('Sender disabled (ENABLE_SENDER is not "true") — not connecting to WhatsApp, not sending.');
} else {
  const inbound = createInbound({ Inbox, Queue, Rule, State, logger });
  const connection = createConnection({ Auth, State, logger, onMessages: inbound.handle });
  const sender = createSender({ Queue, State, transport: connection.transport, config });
  const lease = createLease(Lock, { renewEveryMs: 35_000 });
  const IDLE_SAFETY_MS = 300_000;
  const IGNORED_STATE_FIELDS = new Set(['heartbeatAt', 'updatedAt', 'sendingUntil']);
  const wake = createCollectionWake({
    connection: mongoose.connection,
    collections: [Queue.collection.name, State.collection.name],
    operations: ['insert', 'update', 'replace'],
    maxAwaitTimeMS: 60_000,
    fallbackMs: 10_000,
    filter: change => {
      if (change.ns?.coll !== State.collection.name || change.operationType !== 'update') return true;
      const fields = [
        ...Object.keys(change.updateDescription?.updatedFields || {}),
        ...(change.updateDescription?.removedFields || []),
      ];
      return !fields.length || fields.some(field => !IGNORED_STATE_FIELDS.has(field));
    },
  });
  let stopping = false;

  const shutdown = async reason => {
    if (stopping) return;
    stopping = true;
    console.log(`[whatsapp] Stopping (${reason}): closing the link and releasing the sender lock.`);
    await wake.close().catch(() => {});
    await connection.stop().catch(error => console.error('[whatsapp] stop failed:', error.message));
    await lease.release().catch(error => console.error('[whatsapp] lock release failed:', error.message));
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('disconnect', () => shutdown('backend stopped')); // the process that started this one is gone

  let held = false;
  const keepalive = setInterval(() => {
    if (!held || stopping) return;
    lease.ensure().catch(error => logger.warn({ err: error }, 'lease renewal failed'));
    State.updateOne({ _id: STATE_ID }, { $set: { heartbeatAt: new Date() } }, { upsert: true })
      .catch(error => logger.warn({ err: error }, 'heartbeat update failed'));
  }, 40_000);
  keepalive.unref();

  await wake.start();
  while (!stopping) {
    try {
      const nowHeld = await lease.ensure();
      if (!nowHeld) {
        if (held) await connection.stop();
        held = false;
        await sleep(30_000);
        continue;
      }
      if (!held) {
        held = true;
        await State.updateOne({ _id: STATE_ID }, { $set: { heartbeatAt: new Date() } }, { upsert: true });
        const interrupted = await sender.recoverInterrupted();
        if (interrupted) console.log(`${interrupted} message(s) were mid-send at the last stop; marked failed, not resent.`);
        connection.start();
        console.log('Sender lease held — connecting to WhatsApp.');
      }
      const before = wake.version();
      const state = await State.findById(STATE_ID).select('-qr').lean();
      if (state?.logoutRequested) await connection.logout();
      const result = await bandwidthTracker.runWithProcess('WhatsApp Worker', 'worker', () => sender.step(state));
      if (['empty', 'paused', 'offline'].includes(result.reason)) {
        const retryMs = result.nextDueAt ? Math.max(1000, new Date(result.nextDueAt).getTime() - Date.now()) : IDLE_SAFETY_MS;
        await wake.wait(Math.min(IDLE_SAFETY_MS, retryMs), before);
      } else if (result.reason === 'gap') {
        await wake.wait(Math.max(500, result.gapLeftMs || result.waitMs), before);
      } else {
        await wake.wait(result.waitMs, before);
      }
    } catch (error) {
      logger.error({ err: error }, 'sender loop error');
      await sleep(10_000);
    }
  }
}
