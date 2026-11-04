const express = require('express');
const communicationAdmin = require('../middleware/communicationAdmin');
const service = require('../helpers/offerTargets');
const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(communicationAdmin);
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) { res.status(error.status || error.statusCode || 400).json({ success: false, message: error.message }); }
};
router.patch('/people/:id/stage', handle(req => service.setStage(req.params.id, req.body?.stage, req.userId)));
router.post('/people/:id/bought', handle(req => service.markBought(req.params.id, req.userId)));
router.patch('/leads/:id/behaviour', handle(req => require('../helpers/clientStatus').changeClientStatus(req.params.id, req.body?.behaviour, req.userId)));
router.get('/offers/:slug', handle(req => service.targets(req.params.slug)));
router.get('/offers/:slug/candidates', handle(req => service.people(req.params.slug)));
router.post('/offers/:slug/people', handle(req => service.addPeople(req.params.slug, req.body?.people, req.userId)));
module.exports = router;
