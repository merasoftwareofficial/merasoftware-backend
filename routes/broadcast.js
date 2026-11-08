const express = require('express');
const communicationAdmin = require('../middleware/communicationAdmin');
const { CATALOG, audience } = require('../helpers/broadcastAudience');
const { FIELDS, content, render, composition, compositionParts, compositionHtml } = require('../helpers/broadcastContent');
const service = require('../helpers/broadcastService');
const { stoppedReason } = require('../helpers/whatsappReadiness');
const { State, STATE_ID } = require('../whatsapp/src/models.js');
const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};
// Library deletion is server-to-server and uses the existing website assertion verification.
router.post('/media/retire', handle(async req => {
  const claims = require('../helpers/websiteEmailAccess').verifyWebsiteAccess(req);
  if (claims?.access !== 'admin') throw Object.assign(new Error('Website admin assertion required.'), { status: 403 });
  return require('../helpers/broadcastMedia').retireMedia(req.body.id);
}));
router.use(communicationAdmin);
router.use((req, res, next) => {
  try {
    if (req.body) delete req.body.mediaLocked;
    if (req.body?.media) {
      const verified = require('../helpers/broadcastMedia').verifyMedia(req.body.mediaToken);
      if (verified.id !== req.body.media.id) throw new Error('Media identity changed.');
      req.body.media = verified;
      delete req.body.mediaToken;
    }
    next();
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});
router.get('/audiences', handle(async req => {
  const channel = req.query.channel || 'whatsapp';
  require('../helpers/reviewDelivery').channelsFor(channel);
  const blocks = await require('../helpers/leadContactBlock').contactBlocks();
  return { channel, groups: await Promise.all(CATALOG.map(async group => {
  const counts = await audience(group.id, { channel, blocks });
  return { ...group, count: counts.count, total: counts.total, excluded: counts.excluded,
    whatsappCount: counts.recipients.filter(row => row.channel !== 'email').length, emailCount: counts.recipients.filter(row => row.channel === 'email').length };
})), defaultChannel: await require('../helpers/reviewDelivery').actionChannel('broadcast.manual'), fields: FIELDS,
  jobsEnabled: process.env.BROADCAST_JOBS_ENABLED === 'true', stopped: stoppedReason(await State.findById(STATE_ID).lean()) }; }));
router.get('/templates', handle(() => service.listTemplates()));
router.post('/templates', handle(req => service.saveTemplate(req.body, req.userId)));
router.put('/templates/:id', handle(req => service.saveTemplate(req.body, req.userId, req.params.id)));
router.delete('/templates/:id', handle(async req => { await service.deleteTemplate(req.params.id); return { deleted: true }; }));
router.post('/preview', handle(req => {
  if (req.body.version === 2) {
    const value = composition(req.body), values = { name: FIELDS[0].sample };
    return { html: compositionHtml(value, values), parts: compositionParts(value, values).map(part => ({ ...part, html: render(part.media ? value.caption : value.doc, values, { html: true }) })), subject: value.subject };
  }
  const doc = content(req.body.doc), values = { name: FIELDS[0].sample };
  return { text: render(doc, values), html: render(doc, values, { html: true }) };
}));
router.post('/send', handle(req => service.submit(req.body, req.userId)));
router.get('/history', handle(() => service.history()));
router.post('/history/:id/retry-email', handle(req => service.retryEmail(req.params.id)));
router.get('/history/:id/recipients', handle(req => service.recipients(req.params.id, req.query.page)));
module.exports = router;
