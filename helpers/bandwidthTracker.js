const { AsyncLocalStorage } = require('node:async_hooks');
const mongoose = require('mongoose');

const { BSON } = mongoose.mongo;
const processScope = new AsyncLocalStorage();
const MAX_MINUTES = 24 * 60;
const TLS_FRAME_OVERHEAD_BYTES = 180;
const MAX_IN_FLIGHT = 5_000;

const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify', 'bulkWrite', 'commitTransaction']);
const INTERNAL_COMMANDS = new Set(['hello', 'isMaster', 'ismaster', 'ping', 'buildInfo', 'saslStart', 'saslContinue', 'endSessions', 'listIndexes', 'createIndexes']);

let startedAt = Date.now();
let lastPruneMinute = 0;
let childReporterTimer = null;
const attachedClients = new WeakSet();
const buckets = new Map(); // minuteKey -> Map<processKey, entry>

function currentMinuteKey(ts = Date.now()) {
  return Math.floor(ts / 60_000);
}

function pruneOldBuckets(nowMin) {
  if (nowMin === lastPruneMinute) return;
  lastPruneMinute = nowMin;
  const cutoff = nowMin - MAX_MINUTES;
  for (const key of buckets.keys()) {
    if (key < cutoff) buckets.delete(key);
  }
}

function getEntry(name, category = 'system', ts = Date.now()) {
  const minKey = currentMinuteKey(ts);
  pruneOldBuckets(minKey);
  let bucket = buckets.get(minKey);
  if (!bucket) {
    bucket = new Map();
    buckets.set(minKey, bucket);
  }
  const key = `${category}::${name}`;
  let entry = bucket.get(key);
  if (!entry) {
    entry = {
      name,
      category,
      runs: 0,
      httpOutBytes: 0,
      httpInBytes: 0,
      dbReads: 0,
      dbWrites: 0,
      dbOutBytes: 0,
      dbInBytes: 0,
      externalCalls: 0,
      externalBytes: 0,
      lastAt: ts,
    };
    bucket.set(key, entry);
  }
  if (ts > entry.lastAt) entry.lastAt = ts;
  return entry;
}

function safeBsonSize(doc) {
  if (!doc || typeof doc !== 'object') return 0;
  try {
    return BSON.calculateObjectSize(doc);
  } catch {
    return 256;
  }
}

function collectionFromCommand(commandName, command) {
  if (!command || typeof command !== 'object') return 'unknown';
  if (commandName === 'getMore' && typeof command.collection === 'string') return command.collection;
  const direct = command[commandName];
  return typeof direct === 'string' ? direct : 'unknown';
}

function normalizeRoutePath(rawPath = '') {
  const clean = String(rawPath || '/').split('?')[0];
  return clean
    .replace(/\/[a-f0-9]{24}(?=\/|$)/gi, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:uuid')
    .replace(/\/\d{5,}(?=\/|$)/g, '/:num');
}

function recordRun(name, category = 'system') {
  const entry = getEntry(name, category);
  entry.runs += 1;
}

function recordDbOp({ isWrite = false, outBytes = 0, inBytes = 0, collection = 'unknown', ctx = undefined, countOp = true } = {}) {
  const active = ctx !== undefined ? ctx : processScope.getStore();
  const name = active?.name || `DB: ${collection}`;
  const category = active?.category || 'system';
  const entry = getEntry(name, category);
  if (countOp) {
    if (isWrite) entry.dbWrites += 1;
    else entry.dbReads += 1;
  }
  if (outBytes > 0) entry.dbOutBytes += outBytes;
  if (inBytes > 0) entry.dbInBytes += inBytes;
}

function recordHttp({ name, outBytes = 0, inBytes = 0 }) {
  const entry = getEntry(name, 'api');
  entry.runs += 1;
  entry.httpOutBytes += Math.max(0, Number(outBytes) || 0);
  entry.httpInBytes += Math.max(0, Number(inBytes) || 0);
}

function recordExternal({ name, category, bytes = 0, calls = 1 } = {}) {
  const ctx = processScope.getStore();
  const label = name || ctx?.name || 'External HTTP';
  const cat = category || ctx?.category || 'system';
  const entry = getEntry(label, cat);
  entry.externalCalls += calls;
  entry.externalBytes += TLS_FRAME_OVERHEAD_BYTES + Math.max(0, Number(bytes) || 0);
}

function runWithProcess(name, category, fn) {
  recordRun(name, category);
  return processScope.run({ name, category }, fn);
}

function expressMiddleware(req, res, next) {
  if (req.path === '/api/bandwidth-control/usage' || req.path === '/api/bandwidth-control/reset') {
    return next();
  }
  const routeName = `API: ${req.method} ${normalizeRoutePath(req.originalUrl || req.url)}`;
  const inBytes = Number(req.headers['content-length']) || 0;
  let outBytes = 0;

  const origWrite = res.write;
  const origEnd = res.end;

  res.write = function wrappedWrite(chunk, encoding) {
    if (chunk) {
      outBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    }
    return origWrite.apply(this, arguments);
  };

  res.end = function wrappedEnd(chunk, encoding) {
    if (chunk && typeof chunk !== 'function') {
      outBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    }
    return origEnd.apply(this, arguments);
  };

  res.once('finish', () => {
    recordHttp({ name: routeName, outBytes: outBytes + 250, inBytes });
  });

  return processScope.run({ name: routeName, category: 'api' }, () => next());
}

/**
 * Native MongoDB driver command monitoring (requires monitorCommands: true on mongoose.connect).
 * Measures exact BSON wire sizes via BSON.calculateObjectSize and links commandStarted -> commandSucceeded
 * via event.requestId so AsyncLocalStorage attribution is never lost across shared TCP socket callbacks.
 */
function attachMongoClient(client) {
  if (!client || typeof client.on !== 'function' || attachedClients.has(client)) return;
  attachedClients.add(client);

  const inFlight = new Map();

  client.on('commandStarted', event => {
    const commandName = event?.commandName || 'unknown';
    const isInternal = INTERNAL_COMMANDS.has(commandName);
    const collection = isInternal ? 'driver' : collectionFromCommand(commandName, event.command);
    const ctx = isInternal
      ? { name: 'MongoDB Driver Heartbeat', category: 'system' }
      : (processScope.getStore() || null);
    const isWrite = WRITE_COMMANDS.has(commandName);
    const outBytes = TLS_FRAME_OVERHEAD_BYTES + safeBsonSize(event.command);

    recordDbOp({ isWrite, outBytes, collection, ctx, countOp: true });

    if (event.requestId !== undefined) {
      if (inFlight.size >= MAX_IN_FLIGHT) {
        inFlight.delete(inFlight.keys().next().value);
      }
      inFlight.set(event.requestId, { ctx, isWrite, collection });
    }
  });

  client.on('commandSucceeded', event => {
    const meta = event?.requestId !== undefined ? inFlight.get(event.requestId) : null;
    if (event?.requestId !== undefined) inFlight.delete(event.requestId);
    if (!meta) return;
    const inBytes = safeBsonSize(event.reply);
    if (inBytes > 0) {
      recordDbOp({ isWrite: meta.isWrite, inBytes, collection: meta.collection, ctx: meta.ctx, countOp: false });
    }
  });

  client.on('commandFailed', event => {
    if (event?.requestId !== undefined) inFlight.delete(event.requestId);
  });
}

function ingestDelta(items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item?.name) continue;
    const entry = getEntry(item.name, item.category || 'worker', item.lastAt || Date.now());
    entry.runs += Number(item.runs) || 0;
    entry.httpOutBytes += Number(item.httpOutBytes) || 0;
    entry.httpInBytes += Number(item.httpInBytes) || 0;
    entry.dbReads += Number(item.dbReads) || 0;
    entry.dbWrites += Number(item.dbWrites) || 0;
    entry.dbOutBytes += Number(item.dbOutBytes) || 0;
    entry.dbInBytes += Number(item.dbInBytes) || 0;
    entry.externalCalls += Number(item.externalCalls) || 0;
    entry.externalBytes += Number(item.externalBytes) || 0;
  }
}

function attachChildProcess(child) {
  if (!child || typeof child.on !== 'function') return;
  child.on('message', msg => {
    if (msg && msg.__bandwidthDelta) ingestDelta(msg.__bandwidthDelta);
  });
}

function startChildReporter(defaultName, category = 'worker', intervalMs = 30_000) {
  if (typeof process.send !== 'function' || childReporterTimer) return;
  const flush = () => {
    if (!buckets.size || typeof process.send !== 'function') return;
    const summary = new Map();
    for (const bucket of buckets.values()) {
      for (const entry of bucket.values()) {
        const isUnassigned = entry.name.startsWith('DB: ');
        const name = isUnassigned ? defaultName : entry.name;
        const cat = isUnassigned ? category : entry.category;
        const key = `${cat}::${name}`;
        let agg = summary.get(key);
        if (!agg) {
          agg = { name, category: cat, runs: 0, httpOutBytes: 0, httpInBytes: 0, dbReads: 0, dbWrites: 0, dbOutBytes: 0, dbInBytes: 0, externalCalls: 0, externalBytes: 0, lastAt: 0 };
          summary.set(key, agg);
        }
        agg.runs += entry.runs;
        agg.httpOutBytes += entry.httpOutBytes;
        agg.httpInBytes += entry.httpInBytes;
        agg.dbReads += entry.dbReads;
        agg.dbWrites += entry.dbWrites;
        agg.dbOutBytes += entry.dbOutBytes;
        agg.dbInBytes += entry.dbInBytes;
        agg.externalCalls += entry.externalCalls;
        agg.externalBytes += entry.externalBytes;
        if (entry.lastAt > agg.lastAt) agg.lastAt = entry.lastAt;
      }
    }
    buckets.clear();
    if (summary.size) {
      try { process.send({ __bandwidthDelta: [...summary.values()] }); } catch { /* parent gone */ }
    }
  };
  childReporterTimer = setInterval(flush, intervalMs);
  childReporterTimer.unref?.();
  process.once('beforeExit', flush);
}

function getReport(windowParam = '24h') {
  const minutes = windowParam === '1h' ? 60 : MAX_MINUTES;
  const nowMin = currentMinuteKey();
  pruneOldBuckets(nowMin);
  const cutoff = nowMin - minutes;

  const merged = new Map();
  for (const [minKey, bucket] of buckets.entries()) {
    if (minKey <= cutoff) continue;
    for (const [key, entry] of bucket.entries()) {
      let agg = merged.get(key);
      if (!agg) {
        agg = {
          name: entry.name,
          category: entry.category,
          runs: 0,
          httpOutBytes: 0,
          httpInBytes: 0,
          dbReads: 0,
          dbWrites: 0,
          dbOutBytes: 0,
          dbInBytes: 0,
          externalCalls: 0,
          externalBytes: 0,
          lastAt: 0,
        };
        merged.set(key, agg);
      }
      agg.runs += entry.runs;
      agg.httpOutBytes += entry.httpOutBytes;
      agg.httpInBytes += entry.httpInBytes;
      agg.dbReads += entry.dbReads;
      agg.dbWrites += entry.dbWrites;
      agg.dbOutBytes += entry.dbOutBytes;
      agg.dbInBytes += entry.dbInBytes;
      agg.externalCalls += entry.externalCalls;
      agg.externalBytes += entry.externalBytes;
      if (entry.lastAt > agg.lastAt) agg.lastAt = entry.lastAt;
    }
  }

  const totals = {
    totalBytes: 0,
    httpOutBytes: 0,
    httpInBytes: 0,
    dbOutBytes: 0,
    dbInBytes: 0,
    externalBytes: 0,
    totalRuns: 0,
    totalDbReads: 0,
    totalDbWrites: 0,
    totalExternalCalls: 0,
  };

  const list = [...merged.values()].map(item => {
    // Render bills outbound egress: HTTP responses + outbound DB commands + external requests.
    const totalBytes = item.httpOutBytes + item.dbOutBytes + item.externalBytes;
    totals.totalBytes += totalBytes;
    totals.httpOutBytes += item.httpOutBytes;
    totals.httpInBytes += item.httpInBytes;
    totals.dbOutBytes += item.dbOutBytes;
    totals.dbInBytes += item.dbInBytes;
    totals.externalBytes += item.externalBytes;
    totals.totalRuns += item.runs;
    totals.totalDbReads += item.dbReads;
    totals.totalDbWrites += item.dbWrites;
    totals.totalExternalCalls += item.externalCalls;
    return { ...item, totalBytes, lastAt: item.lastAt ? new Date(item.lastAt).toISOString() : null };
  });

  list.sort((a, b) => b.totalBytes - a.totalBytes || (b.dbReads + b.dbWrites) - (a.dbReads + a.dbWrites));

  const processes = list.map(item => ({
    ...item,
    percent: totals.totalBytes > 0 ? Math.round((item.totalBytes / totals.totalBytes) * 1000) / 10 : 0,
  }));

  return {
    window: windowParam === '1h' ? '1h' : '24h',
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    generatedAt: new Date().toISOString(),
    totals,
    processes,
  };
}

function reset() {
  buckets.clear();
  startedAt = Date.now();
}

module.exports = {
  runWithProcess,
  recordRun,
  recordDbOp,
  recordHttp,
  recordExternal,
  expressMiddleware,
  attachMongoClient,
  attachChildProcess,
  startChildReporter,
  getReport,
  reset,
};
