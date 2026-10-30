const authToken = require('./authToken');
const User = require('../models/userModel');
// WhatsApp connection, queue and Broadcast use the same current-account access policy.
module.exports = [authToken, async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).select('roles isGuest isActive').lean();
    if (!user || user.isGuest || user.isActive === false || !user.roles?.includes('admin')) {
      return res.status(403).json({ success: false, message: 'Admin access required for WhatsApp communication.' });
    }
    next();
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
}];
