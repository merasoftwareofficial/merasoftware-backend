const orderModel = require("../../models/orderProductModel");
const { getOrderUploadHistory } = require("../../helpers/orderUploadHistory");
const { assertCanReadUpload } = require("../../helpers/uploadAccess");

// Upload history for one order — the customer's own view and the admin's view of a
// client's order, both served from getOrderUploadHistory() so the two can never differ.
//
// Access follows the rule already used for invoice documents
// (invoiceDocumentController.js): an admin may read any order, anyone else only their own.
const getOrderUploads = async (req, res) => {
  try {
    const { orderId } = req.params;
    const isAdmin = req.userRole === "admin";

    const order = await orderModel.findById(orderId).select("_id userId isServicePlan").lean();
    if (!order) {
      return res.status(404).json({
        message: "Order not found",
        error: true,
        success: false,
      });
    }

    const refusal = assertCanReadUpload(req, order.userId);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    // An admin reads the order owner's uploads, not their own.
    const history = await getOrderUploadHistory(orderId, {
      userId: isAdmin ? order.userId : req.userId,
      order,
      forTeam: isAdmin,
    });

    return res.status(200).json({
      message: "Upload history retrieved successfully",
      error: false,
      success: true,
      data: history,
    });
  } catch (error) {
    console.error("Error fetching order upload history:", error);
    return res.status(500).json({
      message: error.message || "Failed to fetch upload history",
      error: true,
      success: false,
    });
  }
};

module.exports = getOrderUploads;
