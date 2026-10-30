const express = require('express');
const communicationAdmin = require('../middleware/communicationAdmin');
const { GROUPS, audience } = require('../helpers/broadcastAudience');
const { FIELDS, content, render } = require('../helpers/broadcastContent');
const service = require('../helpers/broadcastService');
const { stoppedReason } = require('../helpers/whatsappReadiness');
const { State, STATE_ID } = require('../whatsapp/src/models.js');
const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(communicationAdmin);
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};
router.get('/audiences', handle(async () => ({ groups: await Promise.all(GROUPS.map(async group => {
  const { count, total, excluded } = await audience(group.id); return { ...group, count, total, excluded };
})), fields: FIELDS, jobsEnabled: process.env.BROADCAST_JOBS_ENABLED === 'true', stopped: stoppedReason(await State.findById(STATE_ID).lean()) })));
router.get('/templates', handle(() => service.listTemplates()));
router.post('/templates', handle(req => service.saveTemplate(req.body, req.userId)));
router.put('/templates/:id', handle(req => service.saveTemplate(req.body, req.userId, req.params.id)));
router.delete('/templates/:id', handle(async req => { await service.deleteTemplate(req.params.id); return { deleted: true }; }));
router.post('/preview', handle(req => {
  const doc = content(req.body.doc), values = { name: FIELDS[0].sample };
  return { text: render(doc, values), html: render(doc, values, { html: true }) };
}));
router.post('/send', handle(req => service.submit(req.body, req.userId)));
router.get('/history', handle(() => service.history()));
router.get('/history/:id/recipients', handle(req => service.recipients(req.params.id, req.query.page)));
module.exports = router;
