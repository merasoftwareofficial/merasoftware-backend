require('dotenv').config();
const mongoose = require('mongoose');
const bandwidthTracker = require('../helpers/bandwidthTracker');
const { createCollectionWake } = require('../helpers/collectionWake');
bandwidthTracker.installMongoosePlugin(mongoose);
bandwidthTracker.startChildReporter('Portfolio Worker', 'worker');
const { randomUUID, createHash } = require('node:crypto');
const orderModel = require('../models/orderProductModel');
require('../models/userModel');
require('../models/productModel');
const Outbox = require('../models/portfolioOutboxModel');
const { portfolioSource } = require('../helpers/portfolioSource');
const leaseSchema = new mongoose.Schema({ _id: String, owner: String, expires: Date });
const Lease = mongoose.models.PortfolioWorkerLease || mongoose.model('PortfolioWorkerLease', leaseSchema);
const owner = randomUUID();
const ORDER_SELECT = 'userId productId projectSnapshot servicePlanSnapshot orderItems isWebsiteProject isServicePlan projectProgress orderVisibility servicePlanStatus planStatus isActive updatesUsed totalYearlyDaysRemaining linkedProjectOrderId projectLink portfolioCaptureAllowed createdAt';
const FULL_RECONCILE_MS = 6 * 60 * 60_000;
const CAPTURE_POLL_MS = 5 * 60_000;
const FALLBACK_POLL_MS = 5 * 60_000;
const MAX_INCREMENTAL_IDS = 500;
let stopping = false;

function configuration() {
  const target = new URL(process.env.PORTFOLIO_WEBSITE_URL || '');
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Set PORTFOLIO_WEBSITE_URL to the target website origin.');
  if (target.pathname !== '/' || target.search || target.hash) throw new Error('PORTFOLIO_WEBSITE_URL must be an origin without a path.');
  const secret = process.env.PORTFOLIO_INTEGRATION_SECRET || '';
  if (secret.length < 32) throw new Error('Set a shared PORTFOLIO_INTEGRATION_SECRET of at least 32 characters.');
  return { target: target.origin, secret };
}
async function website(path, options = {}) {
  const { target, secret } = configuration();
  const reqBytes = typeof options.body === 'string' ? Buffer.byteLength(options.body, 'utf8') : 0;
  const response = await fetch(`${target}/api/portfolio/${path}`, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(150_000),
    headers: { Authorization: `Bearer ${secret}`, ...options.headers },
  });
  bandwidthTracker.recordExternal({ name: 'Portfolio Worker', category: 'worker', bytes: reqBytes + (Number(response.headers?.get?.('content-length')) || 256) });
  if (!response.ok) throw new Error(`Portfolio website returned HTTP ${response.status}.`);
  return response.json();
}
async function claimLease() {
  try {
    return await Lease.findOneAndUpdate({ _id: 'portfolio', $or: [{ owner }, { expires: { $lt: new Date() } }] },
      { $set: { owner, expires: new Date(Date.now() + 600_000) } }, { upsert: true, new: true });
  } catch (error) { if (error.code === 11000) return null; throw error; }
}
async function assertLease() {
  const lease = await Lease.findOneAndUpdate({ _id: 'portfolio', owner, expires: { $gt: new Date() } }, { $set: { expires: new Date(Date.now() + 600_000) } }, { new: true });
  if (!lease) throw new Error('Portfolio worker lease expired.');
}
async function record(source, run, beforeRow) {
  const id = source.id;
  const hash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const before = beforeRow !== undefined ? beforeRow : await Outbox.findById(id).lean();
  if (!before || before.hash !== hash) {
    const revision = Math.max(Date.now(), (before?.revision || 0) + 1);
    await Outbox.updateOne({ _id: id }, { $set: { hash, source: { ...source, revision }, revision, lastSeen: run, pending: true, attempts: 0, nextAttemptAt: new Date(), lastError: '' } }, { upsert: true });
    return true;
  }
  return false;
}
async function reconcile() {
  const run = randomUUID();
  const existingRows = await Outbox.find({}).select('_id hash revision source').lean();
  const existing = new Map(existingRows.map(row => [String(row._id), row]));
  const seen = new Set();
  // A cursor bounds memory; tombstones are emitted only after a successful full scan.
  const cursor = orderModel.find({}).select(ORDER_SELECT)
    .populate('userId', '_id name isGuest')
    .populate('productId', 'serviceName category isWebsiteUpdate isMonthlyRenewablePlan isMonthlyLimitedPlan updateCount')
    .lean().cursor();
  let count = 0;
  try {
    for await (const order of cursor) {
      if (++count % 100 === 0) await assertLease();
      const source = portfolioSource(order);
      if (source) {
        seen.add(source.id);
        await record(source, run, existing.get(source.id) || null);
      }
    }
  } finally { await cursor.close(); }
  await assertLease();
  for (const row of existing.values()) {
    if (row.source?.available && !seen.has(String(row._id))) {
      const { revision: ignored, ...source } = row.source;
      void ignored;
      await record({ ...source, available: false, captureAllowed: false }, run, row);
    }
  }
}
async function reconcileOrders(orderIds) {
  const uniqueIds = [...new Set((orderIds || []).map(id => String(id)).filter(id => mongoose.isValidObjectId(id)))];
  if (!uniqueIds.length) return 0;
  const run = randomUUID();
  const [orders, existingRows] = await Promise.all([
    orderModel.find({ _id: { $in: uniqueIds } }).select(ORDER_SELECT)
      .populate('userId', '_id name isGuest')
      .populate('productId', 'serviceName category isWebsiteUpdate isMonthlyRenewablePlan isMonthlyLimitedPlan updateCount')
      .lean(),
    Outbox.find({ _id: { $in: uniqueIds } }).select('_id hash revision source').lean(),
  ]);
  const existing = new Map(existingRows.map(row => [String(row._id), row]));
  const seen = new Set();
  let changed = 0;
  for (const order of orders) {
    const source = portfolioSource(order);
    if (source) {
      seen.add(source.id);
      if (await record(source, run, existing.get(source.id) || null)) changed += 1;
    }
  }
  for (const id of uniqueIds) {
    if (seen.has(id)) continue;
    const row = existing.get(id);
    if (row?.source?.available) {
      const { revision: ignored, ...source } = row.source;
      void ignored;
      if (await record({ ...source, available: false, captureAllowed: false }, run, row)) changed += 1;
    }
  }
  return changed;
}
async function deliver() {
  const rows = await Outbox.find({ pending: true, nextAttemptAt: { $lte: new Date() } }).sort({ nextAttemptAt: 1 }).limit(100).lean();
  if (!rows.length) return false;
  await assertLease();
  try {
    await website('integration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: rows.map(row => row.source) }) });
    for (const row of rows) await Outbox.updateOne({ _id: row._id, revision: row.revision }, { $set: { pending: false, lastError: '', deliveredAt: new Date() } });
    return true;
  } catch (error) {
    for (const row of rows) await Outbox.updateOne({ _id: row._id, revision: row.revision }, { $inc: { attempts: 1 }, $set: { lastError: error.message, nextAttemptAt: new Date(Date.now() + Math.min(900_000, 30_000 * 2 ** Math.min(row.attempts, 5))) } });
    throw error;
  }
}
async function captureNext() {
  const { job } = await website('integration/captures', { method: 'POST' });
  if (!job) return false;
  try {
    const { captureWebsite } = require('../helpers/portfolioCapture');
    const images = await captureWebsite(job.url);
    const form = new FormData(); form.set('id', job.id); form.set('token', job.token);
    for (const mode of ['desktop', 'mobile']) form.set(mode, new Blob([images[mode]], { type: 'image/jpeg' }), `${mode}.jpg`);
    await website('integration/captures', { method: 'PUT', body: form });
  } catch {
    await website('integration/captures', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, token: job.token, error: 'Automatic capture failed. Check the public URL, retry, or upload screenshots manually.' }) }).catch(() => undefined);
  }
  return true;
}
async function nextOutboxRetryMs() {
  const next = await Outbox.findOne({ pending: true }).sort({ nextAttemptAt: 1 }).select('nextAttemptAt').lean();
  if (!next) return null;
  if (!next.nextAttemptAt) return 1_000;
  return Math.max(1_000, next.nextAttemptAt.getTime() - Date.now());
}
async function tick({ fullReconcile = true, orderIds = null, runCapture = process.env.PORTFOLIO_CAPTURE_ENABLED === 'true' } = {}) {
  if (!(await claimLease())) return { claimed: false, delivered: false };
  try {
    return await bandwidthTracker.runWithProcess('Portfolio Worker', 'worker', async () => {
      if (fullReconcile) await reconcile();
      else if (orderIds?.length) await reconcileOrders(orderIds);
      // Drain several batches on initial import without delaying capture forever.
      let delivered = false;
      for (let batch = 0; batch < 10; batch++) {
        if (!(await deliver())) break;
        delivered = true;
      }
      if (runCapture && process.env.PORTFOLIO_CAPTURE_ENABLED === 'true') {
        while (!stopping && await captureNext()) { /* drain queued captures */ }
      }
      return { claimed: true, delivered };
    });
  } finally { await Lease.deleteOne({ _id: 'portfolio', owner }); }
}
async function main() {
  configuration();
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  await Outbox.init();
  if (process.argv.includes('--once')) {
    try { await tick(); } catch (error) { console.error('[portfolio]', error.message); process.exitCode = 1; }
    await mongoose.disconnect();
    return;
  }

  let needsFullReconcile = true;
  let lastFullReconcileAt = 0;
  let lastCaptureCheckAt = 0;
  const pendingOrderIds = new Set();

  const wake = createCollectionWake({
    connection: mongoose.connection,
    collections: [orderModel.collection.name, Outbox.collection.name],
    operations: ['insert', 'update', 'replace', 'delete'],
    maxAwaitTimeMS: 60_000,
    fallbackMs: FALLBACK_POLL_MS,
    filter: change => {
      if (change.ns?.coll === Outbox.collection.name) {
        return change.operationType !== 'update' || change.updateDescription?.updatedFields?.pending === true;
      }
      return true;
    },
    onChange: change => {
      if (change.ns?.coll === orderModel.collection.name && change.documentKey?._id) {
        if (pendingOrderIds.size >= MAX_INCREMENTAL_IDS) needsFullReconcile = true;
        else pendingOrderIds.add(String(change.documentKey._id));
      }
    },
    onReconnect: () => { needsFullReconcile = true; },
  });

  const stop = () => { stopping = true; void wake.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await wake.start();
  while (!stopping) {
    const before = wake.version();
    const now = Date.now();
    const fullDue = needsFullReconcile || !wake.isLive() || (now - lastFullReconcileAt >= FULL_RECONCILE_MS);
    const ids = fullDue ? null : [...pendingOrderIds];
    if (fullDue) { needsFullReconcile = false; pendingOrderIds.clear(); }
    else if (ids.length) { for (const id of ids) pendingOrderIds.delete(id); }

    const captureEnabled = process.env.PORTFOLIO_CAPTURE_ENABLED === 'true';
    const captureDue = captureEnabled && (now - lastCaptureCheckAt >= CAPTURE_POLL_MS);

    try {
      const result = await tick({ fullReconcile: fullDue, orderIds: ids, runCapture: captureDue });
      if (result.claimed) {
        if (fullDue) lastFullReconcileAt = Date.now();
        if (captureDue || (captureEnabled && result.delivered)) {
          if (result.delivered && !captureDue) await tick({ fullReconcile: false, runCapture: true });
          lastCaptureCheckAt = Date.now();
        }
      } else {
        if (fullDue) needsFullReconcile = true;
        else if (ids?.length) for (const id of ids) pendingOrderIds.add(id);
      }
    } catch (error) {
      if (fullDue) needsFullReconcile = true;
      else if (ids?.length) for (const id of ids) pendingOrderIds.add(id);
      console.error('[portfolio]', error.message);
    }

    if (stopping) break;
    const nextFullMs = Math.max(1_000, FULL_RECONCILE_MS - (Date.now() - lastFullReconcileAt));
    const nextCaptureMs = captureEnabled ? Math.max(1_000, CAPTURE_POLL_MS - (Date.now() - lastCaptureCheckAt)) : FULL_RECONCILE_MS;
    const retryMs = await nextOutboxRetryMs().catch(() => 60_000);
    const waitMs = Math.min(nextFullMs, nextCaptureMs, retryMs ?? FULL_RECONCILE_MS);
    await wake.wait(waitMs, before);
  }
  await wake.close();
  await mongoose.disconnect();
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { reconcile, reconcileOrders, deliver, tick };
