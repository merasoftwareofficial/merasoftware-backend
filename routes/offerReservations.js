const router = require('express').Router();
const { reserveOffer, listReservations } = require('../helpers/offerReservations');
const User = require('../models/userModel');
const wrap = handler => async (req, res) => {
  try { return res.json({ success: true, error: false, data: await handler(req) }); }
  catch (error) { return res.status(error.statusCode || 500).json({ success: false, error: true, message: error.message }); }
};
router.get('/', wrap(async req => ({ ...await listReservations(req.userId), enabled: process.env.OFFER_RESERVATIONS_ENABLED === 'true' })));
router.post('/', wrap(async req => {
  if (!req.is('application/json') || (req.get('origin') && !require('../config/allowedOrigins').isAllowedOrigin(req.get('origin')))) throw Object.assign(new Error('Use the reservation form from the website or portal'), { statusCode: 403 });
  const result = await reserveOffer({ userId: req.userId, offerSlug: req.body?.offerSlug, quoteKey: req.body?.quoteKey });
  setImmediate(() => require('../helpers/offerReservationConfirmation').drainReservationConfirmations().catch(error => console.error('[reservation confirmation]', error.message)));
  return result;
}));
router.get('/user/:userId', wrap(async req => {
  const actor = await User.findById(req.userId).lean();
  if (req.userRole !== 'admin' || !actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) throw Object.assign(new Error('Current portal admin access required'), { statusCode: 403 });
  const list = await listReservations(req.params.userId);
  const rows = await require('../models/offerReservationModel').find({ userId: req.params.userId }).lean();
  return { ...list, reservations: list.reservations.map(view => ({ ...view, offerSnapshot: rows.find(row => String(row._id) === view.id).offerSnapshot })) };
}));
module.exports = router;
