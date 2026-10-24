const router = require('express').Router();
const { reserveOffer, listReservations, extendReservation } = require('../helpers/offerReservations');
const User = require('../models/userModel');
const wrap = handler => async (req, res) => {
  try { return res.json({ success: true, error: false, data: await handler(req) }); }
  catch (error) { return res.status(error.statusCode || 500).json({ success: false, error: true, message: error.message }); }
};
// State-changing calls come only from our own website/portal forms as JSON.
const sameSiteJson = req => {
  if (!req.is('application/json') || (req.get('origin') && !require('../config/allowedOrigins').isAllowedOrigin(req.get('origin')))) throw Object.assign(new Error('Use the reservation form from the website or portal'), { statusCode: 403 });
};
const adminOnly = async req => {
  const actor = await User.findById(req.userId).lean();
  if (req.userRole !== 'admin' || !actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) throw Object.assign(new Error('Current portal admin access required'), { statusCode: 403 });
};
router.get('/', wrap(async req => ({ ...await listReservations(req.userId), enabled: process.env.OFFER_RESERVATIONS_ENABLED === 'true' })));
router.post('/', wrap(async req => {
  sameSiteJson(req);
  const result = await reserveOffer({ userId: req.userId, offerSlug: req.body?.offerSlug, quoteKey: req.body?.quoteKey,
    countryCode: req.body?.countryCode, phone: req.body?.phone });
  setImmediate(() => require('../helpers/offerReservationConfirmation').drainReservationConfirmations().catch(error => console.error('[reservation confirmation]', error.message)));
  return result;
}));
router.get('/user/:userId', wrap(async req => {
  await adminOnly(req);
  const list = await listReservations(req.params.userId);
  const rows = await require('../models/offerReservationModel').find({ userId: req.params.userId }).lean();
  // Admins also see the saved snapshot, extension audit and what happened after the deadline.
  return { ...list, reservations: list.reservations.map(view => {
    const row = rows.find(item => String(item._id) === view.id);
    return { ...view, offerSnapshot: row.offerSnapshot, extensions: row.extensions || [], resolutionNote: row.resolution?.note || '' };
  }) };
}));
router.post('/:id/extend', wrap(async req => {
  sameSiteJson(req); await adminOnly(req);
  return extendReservation({ reservationId: req.params.id, actorId: req.userId, until: req.body?.until, reason: req.body?.reason });
}));
router.post('/:id/force-apply/preview', wrap(async req => {
  sameSiteJson(req); await adminOnly(req);
  return require('../helpers/reservationRepricing').forceApplyPreview({ reservationId: req.params.id, orderId: req.body?.orderId, actorId: req.userId });
}));
router.post('/:id/force-apply', wrap(async req => {
  sameSiteJson(req); await adminOnly(req);
  return require('../helpers/reservationRepricing').forceApplyReservation({ reservationId: req.params.id, orderId: req.body?.orderId, actorId: req.userId,
    reason: req.body?.reason, confirmSlug: req.body?.confirmSlug, expectedRevision: req.body?.expectedRevision });
}));
module.exports = router;
