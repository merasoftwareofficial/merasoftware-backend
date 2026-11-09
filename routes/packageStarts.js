const router = require('express').Router();
const start = require('../helpers/packageStart');
const User = require('../models/userModel');
const wrap = handler => async (req, res) => {
  try { return res.json({ success: true, error: false, data: await handler(req) }); }
  catch (error) { return res.status(error.statusCode || 500).json({ success: false, error: true, message: error.message }); }
};
// State-changing calls come only from our own website/portal forms as JSON (same rule as offer reservations).
const sameSiteJson = req => {
  if (!req.is('application/json') || (req.get('origin') && !require('../config/allowedOrigins').isAllowedOrigin(req.get('origin')))) throw Object.assign(new Error('Use the form on the package page'), { statusCode: 403 });
};
const adminOnly = async req => {
  const actor = await User.findById(req.userId).lean();
  if (req.userRole !== 'admin' || !actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) throw Object.assign(new Error('Current portal admin access required'), { statusCode: 403 });
};
// "Start my project" on a package without an offer (helpers/packageStart.js).
router.get('/', wrap(req => start.listPackageStarts(req.userId)));
router.post('/', wrap(async req => {
  sameSiteJson(req);
  const result = await start.requestPackageStart({ userId: req.userId, packageId: req.body?.packageId, choice: req.body?.choice, countryCode: req.body?.countryCode, phone: req.body?.phone });
  if (result.requested) setImmediate(() => start.deliverPackageStartNotices({ requestId: result.request.id }).catch(error => console.error('[package start notices]', error.message)));
  return result;
}));
// The customer pays for the package project and it is created with that payment (helpers/packagePurchase.js).
router.get('/payment-info', wrap(req => require('../helpers/packagePurchase').paymentInfo(req.userId)));
router.post('/purchase', async (req, res) => {
  try {
    sameSiteJson(req);
    const body = req.body || {};
    const result = await require('../helpers/packagePurchase').purchasePackage({ userId: req.userId, packageId: body.packageId, choice: body.choice,
      quoteKey: body.quoteKey, dueNow: body.dueNow, creationKey: body.creationKey, countryCode: body.countryCode, phone: body.phone,
      upiTransactionId: body.upiTransactionId });
    // A member who just became a client keeps the same sign-in: the portal's /user-details renews an old
    // member session into a client one on its first load (controller/user/userDetails.js).
    return res.status(result.reused ? 200 : 201).json({ success: true, error: false, data: result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: true, message: error.message });
  }
});
router.get('/user/:userId', wrap(async req => { await adminOnly(req); return start.listPackageStarts(req.params.userId); }));
router.post('/:id/close', wrap(async req => { sameSiteJson(req); await adminOnly(req); return start.closeByTeam({ requestId: req.params.id, actorId: req.userId }); }));
module.exports = router;
