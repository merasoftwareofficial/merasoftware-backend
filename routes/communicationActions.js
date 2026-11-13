const express = require('express');
const service = require('../helpers/communicationActions');

// Mounted under /api/auto-reply/actions, after the admin-only check in routes/autoReply.js.
const router = express.Router();
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};

router.get('/', handle(() => service.list()));
router.put('/:id', handle(req => service.update(req.params.id, req.body || {}, req.userId)));

module.exports = router;
