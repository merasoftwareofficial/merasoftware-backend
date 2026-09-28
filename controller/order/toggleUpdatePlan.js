const Order = require('../../models/orderProductModel');
const Product = require('../../models/productModel');
const Category = require('../../models/categoryModel');

const toggleUpdatePlan = async (req, res) => {
    try {
      const userId = req.userId;
      const { orderId } = req.body;
  
      // Find the order and verify it's a website update plan
      const order = await Order.findOne({ _id: orderId, userId }).populate('productId');
      
      if (!order || order.productId.category !== 'website_updates') {
        return res.status(400).json({
          success: false,
          message: 'Invalid update plan'
        });
      }
  
      // If activating this plan, deactivate all other update plans first
      if (!order.isActive) {
        // productId is a ref, so the category must be resolved to product ids first.
        const updatePlanProductIds = await Product.find({ category: 'website_updates' }).distinct('_id');
        await Order.updateMany(
          {
            userId,
            _id: { $ne: orderId },
            productId: { $in: updatePlanProductIds },
            isActive: true
          },
          { isActive: false }
        );
      }
  
      // Toggle the plan status
      order.isActive = !order.isActive;
      await order.save();
  
      return res.json({
        success: true,
        message: `Update plan ${order.isActive ? 'activated' : 'deactivated'} successfully`
      });
  
    } catch (error) {
      console.error('Error in toggleUpdatePlan:', error);
      return res.status(500).json({
        success: false,
        message: 'Something went wrong'
      });
    }
  };

  module.exports = toggleUpdatePlan