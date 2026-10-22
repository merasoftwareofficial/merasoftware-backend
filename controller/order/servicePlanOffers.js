const Product = require('../../models/productModel');
const { listServiceOffers } = require('../../helpers/serviceOfferPolicy');
module.exports = async (req, res) => {
  try {
    const plan = await Product.findOne({ _id: req.params.planId, category: 'service_plan', isServicePlan: true, isHidden: false, retiredAt: null, archivedAt: null }).lean();
    if (!plan) return res.status(404).json({ success: false, message: 'Service plan unavailable' });
    res.set('Cache-Control', 'no-store').json({ success: true, data: await listServiceOffers(plan) });
  } catch (error) { res.status(error.statusCode || 400).json({ success: false, message: error.message }); }
};
