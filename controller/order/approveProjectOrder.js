const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const orderModel = require("../../models/orderProductModel");
const transactionModel = require("../../models/transactionModel");
const { recordAdminProjectPayment, rejectAdminProject } = require('../../helpers/projectPaymentSettlement');
const { ADMIN_PAYMENT_METHODS, preparePaymentEvidence } = require("../../helpers/paymentEvidence");

// Admin approval for a customer-initiated project order that is waiting on approval.
//
// This is ONLY for the gap the customer "Pay Later" (decide_later) flow leaves open:
// such an order is created `pending-approval` with NO transaction and NO invoice, so the
// existing transaction-based approval (transactionApprovalController) has nothing to act on.
//
// Customer-paid orders (full / installment) still flow through the existing
// approve-transaction / reject-transaction engine, untouched — they already have a pending
// transaction the admin accepts in the Payment & Invoices tab.
//
// SSOT: this controller writes to the same orderProductModel / invoiceModel / transactionModel
// as every other path. It never invents a parallel record.
//
// A project order must NEVER become `orderVisibility: 'approved'` without a real payment
// recorded (transaction + invoice settlement) — there is no "approve without payment" mode. The
// only outcomes here are: record a payment and approve, or reject.

const PAYMENT_METHODS = ADMIN_PAYMENT_METHODS;
const APPROVAL_MODES = ["approve_with_payment", "reject"];

const requireAdmin = async (req, res) => {
  const adminUser = await userModel.findById(req.userId).select("roles");
  if (req.userRole !== "admin" || !adminUser?.roles?.includes("admin")) {
    res.status(403).json({ message: "Forbidden", error: true, success: false });
    return false;
  }
  return true;
};

const approveProjectOrder = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const { orderId } = req.params;
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        message: "Valid orderId is required",
        error: true,
        success: false,
      });
    }

    const { mode, paymentMethod, transactionReference, paymentDetails, notes, rejectionReason } = req.body;
    if (!APPROVAL_MODES.includes(mode)) {
      return res.status(400).json({
        message: "Invalid approval mode",
        error: true,
        success: false,
      });
    }

    const order = await orderModel.findById(orderId).populate("productId", "serviceName");
    if (!order) {
      return res.status(404).json({
        message: "Order not found",
        error: true,
        success: false,
      });
    }

    // Idempotency guard: only a still-pending order can be approved/rejected here.
    // Prevents double-approval on retry and stops this from touching an already-live order.
    if (order.orderVisibility !== "pending-approval") {
      return res.status(400).json({
        message: `Order is already ${order.orderVisibility}`,
        error: true,
        success: false,
      });
    }

    // ---------- REJECT ----------
    if (mode === "reject") {
      const reason = (rejectionReason || "").trim();
      if (!reason) {
        return res.status(400).json({
          message: "Rejection reason is required",
          error: true,
          success: false,
        });
      }
      const rejectedOrder = await rejectAdminProject({ orderId: order._id, actorId: req.userId, reason });
      return res.status(200).json({
        message: "Project rejected",
        success: true,
        error: false,
        data: rejectedOrder,
      });
    }

    // "approve_no_payment" was REMOVED — a project order must never be flipped to `approved`
    // without a real payment recorded (transaction + invoice settlement). Every approval now
    // goes through APPROVE WITH PAYMENT RECORD below, which requires a paymentMethod.

    // ---------- APPROVE WITH PAYMENT RECORD ----------
    // No-duplicate guard: if the order already has ANY completed transaction, do not
    // record a second one — this order already has its payment on the SSOT.
    const existingCompleted = await transactionModel.findOne({
      orderId: order._id,
      status: "completed",
    });
    if (existingCompleted) {
      return res.status(400).json({
        message: "This order already has a recorded payment. Use the payment ledger.",
        error: true,
        success: false,
      });
    }

    if (!paymentMethod || !PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        message: "Valid payment method is required to record payment",
        error: true,
        success: false,
      });
    }

    // Validate the method-specific reference before anything is written — a refused reference
    // must not leave a half-made invoice behind.
    const preparedEvidence = await preparePaymentEvidence({
      paymentMethod,
      reference: transactionReference,
      details: paymentDetails || {},
      capturedVia: "admin",
    });

    await require('../../helpers/reservationRepricing').ensureReservationPriceCurrent(order._id);
    const result = await recordAdminProjectPayment({
      orderId: order._id, actorId: req.userId,
      payment: { paymentMethod, transactionReference, paymentDetails: paymentDetails || {}, notes },
      preparedEvidence,
    });
    return res.status(200).json({
      message: "Payment recorded and project approved",
      success: true,
      error: false,
      data: result.order,
    });
  } catch (error) {
    console.error("Error approving project order:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to approve project order",
      error: true,
      success: false,
    });
  }
};

module.exports = approveProjectOrder;
