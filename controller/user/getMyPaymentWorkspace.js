const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const orderModel = require("../../models/orderProductModel");
const readCustomerInvoices = require("../../helpers/customerInvoices");
const transactionModel = require("../../models/transactionModel");
const { applyOrderSummary } = require("../../helpers/orderSummary");

const getMyPaymentWorkspace = async (req, res) => {
  try {
    const customerObjectId = new mongoose.Types.ObjectId(req.userId);

    const customer = await userModel
      .findById(customerObjectId)
      .select("name email phone status walletBalance createdAt updatedAt")
      .lean();
    if (!customer) {
      return res.status(404).json({
        message: "Customer not found",
        error: true,
        success: false,
      });
    }

    const [orders, transactions, invoices] = await Promise.all([
      applyOrderSummary(orderModel.find({ userId: customerObjectId }).sort({ createdAt: -1 })),
      transactionModel
        .find({ userId: customerObjectId })
        .select("transactionId upiTransactionId amount status type sourceType paymentMethod invoiceId orderId date createdAt rejectionReason")
        .populate({ path: "orderId", select: "productId projectSnapshot servicePlanSnapshot orderItems", populate: { path: "productId", select: "serviceName" } })
        .sort({ createdAt: -1 }),
      readCustomerInvoices({ userId: customerObjectId }),
    ]);

    return res.status(200).json({
      message: "Payment workspace data fetched successfully",
      success: true,
      error: false,
      data: {
        orders,
        transactions,
        invoices,
        summary: {
          totalOrders: orders.length,
          walletBalance: customer.walletBalance || 0,
          invoiceCount: invoices.length,
          transactionCount: transactions.length,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching customer payment workspace:", error);
    return res.status(500).json({
      message: error.message || "Failed to fetch payment workspace",
      success: false,
      error: true,
    });
  }
};

module.exports = getMyPaymentWorkspace;
