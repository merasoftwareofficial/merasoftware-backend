require('dotenv').config();
const mongoose = require('mongoose');
const { randomUUID, createHash } = require('node:crypto');
const orderModel = require('../models/orderProductModel');
require('../models/userModel');
require('../models/productModel');
const Outbox = require('../models/portfolioOutboxModel');
const { portfolioSource } = require('../helpers/portfolioSource');
const leaseSchema = new mongoose.Schema({ _id: String, owner: String, expires: Date });
const Lease = mongoose.models.PortfolioWorkerLease || mongoose.model('PortfolioWorkerLease', leaseSchema);
const owner = randomUUID();
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
  const response = await fetch(`${target}/api/portfolio/${path}`, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(150_000),
    headers: { Authorization: `Bearer ${secret}`, ...options.headers },
  });
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
async function record(source, run) {
  const id = source.id;
  const hash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const before = await Outbox.findById(id).lean();
  if (!before || before.hash !== hash) {
    const revision = Math.max(Date.now(), (before?.revision || 0) + 1);
    await Outbox.updateOne({ _id: id }, { $set: { hash, source: { ...source, revision }, revision, lastSeen: run, pending: true, attempts: 0, nextAttemptAt: new Date(), lastError: '' } }, { upsert: true });
  } else await Outbox.updateOne({ _id: id }, { $set: { lastSeen: run } });
}
async function reconcile() {
  const run = randomUUID();
  // A cursor bounds memory; tombstones are emitted only after a successful full scan.
  const cursor = orderModel.find({}).select('userId productId projectSnapshot servicePlanSnapshot orderItems isWebsiteProject isServicePlan projectProgress orderVisibility servicePlanStatus planStatus isActive updatesUsed totalYearlyDaysRemaining linkedProjectOrderId projectLink portfolioCaptureAllowed')
    .populate('userId', '_id name isGuest')
    .populate('productId', 'serviceName category isWebsiteUpdate isMonthlyRenewablePlan isMonthlyLimitedPlan updateCount')
    .lean().cursor();
  let count = 0;
  try {
    for await (const order of cursor) {
      if (++count % 100 === 0) await assertLease();
      const source = portfolioSource(order);
      if (source) await record(source, run);
    }
  } finally { await cursor.close(); }
  await assertLease();
  for await (const row of Outbox.find({ lastSeen: { $ne: run }, 'source.available': true }).lean().cursor()) {
    const { revision: ignored, ...source } = row.source;
    void ignored;
    await record({ ...source, available: false, captureAllowed: false }, run);
  }
}
async function deliver() {
  const rows = await Outbox.find({ pending: true, nextAttemptAt: { $lte: new Date() } }).sort({ nextAttemptAt: 1 }).limit(100).lean();
  if (!rows.length) return;
  await assertLease();
  try {
    await website('integration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: rows.map(row => row.source) }) });
    for (const row of rows) await Outbox.updateOne({ _id: row._id, revision: row.revision }, { $set: { pending: false, lastError: '', deliveredAt: new Date() } });
  } catch (error) {
    for (const row of rows) await Outbox.updateOne({ _id: row._id, revision: row.revision }, { $inc: { attempts: 1 }, $set: { lastError: error.message, nextAttemptAt: new Date(Date.now() + Math.min(900_000, 30_000 * 2 ** Math.min(row.attempts, 5))) } });
    throw error;
  }
}
async function captureNext() {
  const { job } = await website('integration/captures', { method: 'POST' });
  if (!job) return;
  try {
    const { captureWebsite } = require('../helpers/portfolioCapture');
    const images = await captureWebsite(job.url);
    const form = new FormData(); form.set('id', job.id); form.set('token', job.token);
    for (const mode of ['desktop', 'mobile']) form.set(mode, new Blob([images[mode]], { type: 'image/jpeg' }), `${mode}.jpg`);
    await website('integration/captures', { method: 'PUT', body: form });
  } catch {
    await website('integration/captures', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, token: job.token, error: 'Automatic capture failed. Check the public URL, retry, or upload screenshots manually.' }) }).catch(() => undefined);
  }
}
async function tick() {
  if (!(await claimLease())) return;
  try {
    await reconcile();
    // Drain several batches on initial import without delaying capture forever.
    for (let batch = 0; batch < 10; batch++) await deliver();
    if (process.env.PORTFOLIO_CAPTURE_ENABLED === 'true') await captureNext();
  } finally { await Lease.deleteOne({ _id: 'portfolio', owner }); }
}
async function main() {
  configuration();
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  await Outbox.init();
  process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
  do {
    try { await tick(); } catch (error) { console.error('[portfolio]', error.message); }
    if (process.argv.includes('--once') || stopping) break;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timeout); process.removeListener('SIGTERM', finish); process.removeListener('SIGINT', finish); resolve(); };
      const timeout = setTimeout(finish, 30_000);
      process.once('SIGTERM', finish); process.once('SIGINT', finish);
    });
  } while (!stopping);
  await mongoose.disconnect();
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { reconcile, deliver, tick };
