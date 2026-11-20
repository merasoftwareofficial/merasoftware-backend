const { AsyncLocalStorage } = require('node:async_hooks');

const processScope = new AsyncLocalStorage();
const MAX_MINUTES = 24 * 60;
const BSON_OVERHEAD_BYTES = 380; // Wire protocol + TLS record framing baseline per DB round-trip

let startedAt = Date.now();
let lastPruneMinute = 0;
let mongooseInstalled = false;
let childReporterTimer = null;
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
      dbBytes: 0,
      externalCalls: 0,
      externalBytes: 0,
      lastAt: ts,
    };
    bucket.set(key, entry);
  }
  if (ts > entry.lastAt) entry.lastAt = ts;
  return entry;
}

function estimateBytes(value) {
  if (value == null) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  try {
    const json = JSON.stringify(value);
    return json ? Buffer.byteLength(json, 'utf8') : 0;
  } catch {
    return 256;
  }
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

function recordDbOp({ isWrite = false, bytes = 0, collection = 'unknown' } = {}) {
  const ctx = processScope.getStore();
  const name = ctx?.name || `DB: ${collection}`;
  const category = ctx?.category || 'system';
  const entry = getEntry(name, category);
  if (isWrite) entry.dbWrites += 1;
  else entry.dbReads += 1;
  entry.dbBytes += BSON_OVERHEAD_BYTES + Math.max(0, Number(bytes) || 0);
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
  entry.externalBytes += BSON_OVERHEAD_BYTES + Math.max(0, Number(bytes) || 0);
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

  res.write = function wrappedWrite(chunk, encoding, cb) {
    if (chunk) {
      outBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    }
    return origWrite.apply(this, arguments);
  };

  res.end = function wrappedEnd(chunk, encoding, cb) {
    if (chunk && typeof chunk !== 'function') {
      outBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    }
    return origEnd.apply(this, arguments);
  };

  res.once('finish', () => {
    const headerEstimate = 250;
    recordHttp({ name: routeName, outBytes: outBytes + headerEstimate, inBytes });
  });

  return processScope.run({ name: routeName, category: 'api' }, () => next());
}

const READ_HOOKS = ['find', 'findOne', 'countDocuments', 'estimatedDocumentCount', 'distinct'];
const WRITE_HOOKS = ['findOneAndUpdate', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne', 'findOneAndDelete', 'findOneAndReplace'];

function installMongoosePlugin(mongoose) {
  if (mongooseInstalled || !mongoose?.plugin) return;
  mongooseInstalled = true;

  mongoose.plugin(function bandwidthMongoosePlugin(schema) {
    for (const op of READ_HOOKS) {
      schema.post(op, function onRead(result) {
        const col = this?.mongooseCollection?.name || this?.model?.collection?.name || 'unknown';
        const filterBytes = estimateBytes(this?.getFilter?.());
        // Bound result size estimation so huge cursors/arrays don't slow down the event loop
        let resBytes = 0;
        if (Array.isArray(result)) {
          const sampleCount = Math.min(result.length, 5);
          if (sampleCount > 0) {
            let sampleBytes = 0;
            for (let i = 0; i < sampleCount; i++) sampleBytes += estimateBytes(result[i]);
            resBytes = Math.round((sampleBytes / sampleCount) * result.length);
          }
        } else if (result && typeof result === 'object') {
          resBytes = estimateBytes(result);
        }
        recordDbOp({ isWrite: false, bytes: filterBytes + resBytes, collection: col });
      });
    }

    for (const op of WRITE_HOOKS) {
      schema.post(op, function onWrite() {
        const col = this?.mongooseCollection?.name || this?.model?.collection?.name || 'unknown';
        const filterBytes = estimateBytes(this?.getFilter?.());
        const updateBytes = estimateBytes(this?.getUpdate?.());
        recordDbOp({ isWrite: true, bytes: filterBytes + updateBytes, collection: col });
      });
    }

    schema.post('aggregate', function onAggregate(result) {
      const col = this?.model?.collection?.name || 'unknown';
      const pipeBytes = estimateBytes(this?.pipeline?.());
      let resBytes = 0;
      if (Array.isArray(result) && result.length > 0) {
        const sampleCount = Math.min(result.length, 5);
        let sampleBytes = 0;
        for (let i = 0; i < sampleCount; i++) sampleBytes += estimateBytes(result[i]);
        resBytes = Math.round((sampleBytes / sampleCount) * result.length);
      }
      recordDbOp({ isWrite: false, bytes: pipeBytes + resBytes, collection: col });
    });

    schema.post('save', function onSave(doc) {
      const col = this?.collection?.name || doc?.constructor?.collection?.name || 'unknown';
      recordDbOp({ isWrite: true, bytes: estimateBytes(doc), collection: col });
    });

    schema.post('insertMany', function onInsertMany(docs) {
      const col = this?.collection?.name || 'unknown';
      const count = Array.isArray(docs) ? docs.length : 1;
      const sample = Array.isArray(docs) && docs.length ? estimateBytes(docs[0]) * count : estimateBytes(docs);
      recordDbOp({ isWrite: true, bytes: sample, collection: col });
    });
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
    entry.dbBytes += Number(item.dbBytes) || 0;
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
  if (typeof process.send !== 'function') return;
  if (childReporterTimer) return;
  const flush = () => {
    if (!buckets.size || typeof process.send !== 'function') return;
    const summary = new Map();
    for (const bucket of buckets.values()) {
      for (const entry of bucket.values()) {
        const name = entry.name.startsWith('DB: ') ? defaultName : entry.name;
        const cat = entry.name.startsWith('DB: ') ? category : entry.category;
        const key = `${cat}::${name}`;
        let agg = summary.get(key);
        if (!agg) {
          agg = { name, category: cat, runs: 0, httpOutBytes: 0, httpInBytes: 0, dbReads: 0, dbWrites: 0, dbBytes: 0, externalCalls: 0, externalBytes: 0, lastAt: 0 };
          summary.set(key, agg);
        }
        agg.runs += entry.runs;
        agg.httpOutBytes += entry.httpOutBytes;
        agg.httpInBytes += entry.httpInBytes;
        agg.dbReads += entry.dbReads;
        agg.dbWrites += entry.dbWrites;
        agg.dbBytes += entry.dbBytes;
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
          dbBytes: 0,
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
      agg.dbBytes += entry.dbBytes;
      agg.externalCalls += entry.externalCalls;
      agg.externalBytes += entry.externalBytes;
      if (entry.lastAt > agg.lastAt) agg.lastAt = entry.lastAt;
    }
  }

  const totals = {
    totalBytes: 0,
    httpOutBytes: 0,
    httpInBytes: 0,
    dbBytes: 0,
    externalBytes: 0,
    totalRuns: 0,
    totalDbReads: 0,
    totalDbWrites: 0,
    totalExternalCalls: 0,
  };

  const list = [...merged.values()].map(item => {
    const totalBytes = item.httpOutBytes + item.dbBytes + item.externalBytes;
    totals.totalBytes += totalBytes;
    totals.httpOutBytes += item.httpOutBytes;
    totals.httpInBytes += item.httpInBytes;
    totals.dbBytes += item.dbBytes;
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
  installMongoosePlugin,
  attachChildProcess,
  startChildReporter,
  getReport,
  reset,
};
