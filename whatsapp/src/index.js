import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import mongoose from 'mongoose';
import pino from 'pino';
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

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
console.log('Connected to DB');

if (!config.senderEnabled) {
  console.log('Sender disabled (ENABLE_SENDER is not "true") — not connecting to WhatsApp, not sending.');
} else {
  const inbound = createInbound({ Inbox, Rule, State, logger });
  const connection = createConnection({ Auth, State, logger, onMessages: inbound.handle });
  const sender = createSender({ Queue, State, transport: connection.transport, config });
  const lease = createLease(Lock);
  let stopping = false;

  const shutdown = async reason => {
    if (stopping) return;
    stopping = true;
    console.log(`[whatsapp] Stopping (${reason}): closing the link and releasing the sender lock.`);
    await connection.stop().catch(error => console.error('[whatsapp] stop failed:', error.message));
    await lease.release().catch(error => console.error('[whatsapp] lock release failed:', error.message));
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('disconnect', () => shutdown('backend stopped')); // the process that started this one is gone

  let held = false;
  let heartbeatAt = 0;
  // A long send must not let the lease run out under it (the loop renews only between steps).
  setInterval(() => { if (held && !stopping) lease.ensure().catch(error => logger.warn({ err: error }, 'lease renewal failed')); }, 20_000).unref();
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
        const interrupted = await sender.recoverInterrupted();
        if (interrupted) console.log(`${interrupted} message(s) were mid-send at the last stop; marked failed, not resent.`);
        connection.start();
        console.log('Sender lease held — connecting to WhatsApp.');
      }
      const state = await State.findById(STATE_ID).lean();
      if (state?.logoutRequested) await connection.logout();
      if (Date.now() - heartbeatAt > 30_000) {
        heartbeatAt = Date.now();
        await State.updateOne({ _id: STATE_ID }, { $set: { heartbeatAt: new Date() } }, { upsert: true });
      }
      const { waitMs } = await sender.step();
      await sleep(waitMs);
    } catch (error) {
      logger.error({ err: error }, 'sender loop error');
      await sleep(10_000);
    }
  }
}
