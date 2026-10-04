const orderModel = require('../../models/orderProductModel');
const userModel = require('../../models/userModel');
const mongoose = require('mongoose');
const { publicUrl } = require('../../helpers/portfolioSource');
module.exports = async function portfolioSettings(req, res) {
  try {
    const admin = await userModel.findById(req.userId).select('roles').lean();
    if (req.userRole !== 'admin' || !admin?.roles?.includes('admin')) return res.status(403).json({ success: false, message: 'Forbidden' });
    if (!mongoose.Types.ObjectId.isValid(req.params.orderId)) return res.status(400).json({ success: false, message: 'Invalid order ID' });
    const rawUrl = String(req.body.projectLink || '').trim();
    const url = publicUrl(rawUrl);
    if ((rawUrl && !url) || typeof req.body.captureAllowed !== 'boolean') return res.status(400).json({ success: false, message: 'Enter a valid http(s) website URL and capture preference.' });
    const order = await orderModel.findByIdAndUpdate(req.params.orderId, { $set: { projectLink: url, portfolioCaptureAllowed: req.body.captureAllowed } }, { new: true, runValidators: true }).select('_id projectLink portfolioCaptureAllowed').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Project not found' });
    return res.json({ success: true, data: order, message: 'Portfolio source updated. Public visibility is managed in the website admin.' });
  } catch { return res.status(500).json({ success: false, message: 'Could not update portfolio source.' }); }
};
