const express = require('express');
const communicationAdmin = require('../middleware/communicationAdmin');
const bandwidthTracker = require('../helpers/bandwidthTracker');

const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(communicationAdmin);

router.get('/usage', (req, res) => {
  const windowParam = req.query.window === '1h' ? '1h' : '24h';
  return res.json({ success: true, data: bandwidthTracker.getReport(windowParam) });
});

router.post('/reset', (req, res) => {
  bandwidthTracker.reset();
  return res.json({ success: true, data: bandwidthTracker.getReport('24h') });
});

module.exports = router;
