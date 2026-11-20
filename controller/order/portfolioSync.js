const { timingSafeEqual } = require('node:crypto');
const Outbox = require('../../models/portfolioOutboxModel');

let running = false;
let pendingSync = false;
let pendingCapture = false;

function scheduleOnDemand({ sync = false, capture = false } = {}) {
  if (sync) pendingSync = true;
  if (capture) pendingCapture = true;
  if (running) return;
  running = true;
  void (async () => {
    try {
      const { tick } = require('../../scripts/portfolioWorker');
      while (pendingSync || pendingCapture) {
        const doSync = pendingSync;
        const doCapture = pendingCapture;
        pendingSync = false;
        pendingCapture = false;
        await tick({ fullReconcile: doSync, runCapture: doCapture });
      }
    } catch (error) {
      console.error('[portfolio-sync]', error.message);
    } finally {
      running = false;
    }
  })();
}

module.exports = async function portfolioSync(req, res) {
  const secret = process.env.PORTFOLIO_INTEGRATION_SECRET || '';
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(req.headers.authorization || '');
  if (secret.length < 32 || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return res.status(401).json({ error: 'Unauthorized integration.' });
  try {
    if (req.method === 'POST') {
      if (req.query?.capture === '1') {
        scheduleOnDemand({ capture: true });
        return res.status(202).json({ queued: true, mode: 'capture' });
      }
      await Outbox.updateMany({}, { $set: { pending: true, nextAttemptAt: new Date(), lastError: '', attempts: 0 } });
      scheduleOnDemand({ sync: true });
      return res.json({ queued: true, mode: 'sync' });
    }
    const [pending, failed, latest] = await Promise.all([
      Outbox.countDocuments({ pending: true }), Outbox.countDocuments({ pending: true, attempts: { $gt: 0 } }),
      Outbox.findOne({ deliveredAt: { $ne: null } }).sort({ deliveredAt: -1 }).select('deliveredAt').lean(),
    ]);
    return res.json({ pending, failed, lastDelivery: latest?.deliveredAt || null });
  } catch { return res.status(500).json({ error: 'Could not access portfolio sync queue.' }); }
};
