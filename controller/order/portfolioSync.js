const { timingSafeEqual } = require('node:crypto');
const Outbox = require('../../models/portfolioOutboxModel');
module.exports = async function portfolioSync(req, res) {
  const secret = process.env.PORTFOLIO_INTEGRATION_SECRET || '';
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(req.headers.authorization || '');
  if (secret.length < 32 || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return res.status(401).json({ error: 'Unauthorized integration.' });
  try {
    if (req.method === 'POST') {
      await Outbox.updateMany({}, { $set: { pending: true, nextAttemptAt: new Date(), lastError: '', attempts: 0 } });
      return res.json({ queued: true });
    }
    const [pending, failed, latest] = await Promise.all([
      Outbox.countDocuments({ pending: true }), Outbox.countDocuments({ pending: true, attempts: { $gt: 0 } }),
      Outbox.findOne({ deliveredAt: { $ne: null } }).sort({ deliveredAt: -1 }).select('deliveredAt').lean(),
    ]);
    return res.json({ pending, failed, lastDelivery: latest?.deliveredAt || null });
  } catch { return res.status(500).json({ error: 'Could not access portfolio sync queue.' }); }
};
