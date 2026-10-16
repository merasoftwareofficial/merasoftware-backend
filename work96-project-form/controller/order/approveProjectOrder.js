const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const orderModel = require("../../models/orderProductModel");
const invoiceModel = require("../../models/invoiceModel");
const transactionModel = require("../../models/transactionModel");
const {
  markProjectInvoicePaid,
  createProjectInvoice,
  buildLineItemsFromOrder,
} = require("../../helpers/paymentRecording");
const { syncProjectFinalInvoice } = require("../../helpers/projectFinalInvoice");
const { logApproved, logRejected, ACTOR_TYPE } = require("../../helpers/orderLifecycleLog");

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

const PAYMENT_METHODS = ["upi", "bank_transfer", "cash", "wallet"];
const APPROVAL_MODES = ["approve_with_payment", "reject"];

const requireAdmin = async (req, res) => {
  const adminUser = await userModel.findById(req.userId).select("roles");
  if (req.userRole !== "admin" || !adminUser?.roles?.includes("admin")) {
    res.status(403).json({ message: "Forbidden", error: true, success: false });
    return false;
  }
  return true;
};

const getOrderTotal = (order) =>
  Number(order?.totalAmount || order?.totalPrice || order?.price || 0);

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

    const { mode, paymentMethod, transactionReference, notes, rejectionReason } = req.body;
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
      const fromVisibility = order.orderVisibility;
      order.orderVisibility = "payment-rejected";
      order.rejectionReason = reason;
      logRejected(order, { actorId: req.userId, actorType: ACTOR_TYPE.ADMIN, reason, fromVisibility });
      await order.save();
      return res.status(200).json({
        message: "Project rejected",
        success: true,
        error: false,
        data: order,
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
        message: "This order already has a recorded payment. Approve without payment or use the payment ledger.",
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

    const isPartialPayment = Boolean(order.isPartialPayment) &&
      Array.isArray(order.installments) && order.installments.length > 0;

    // Amount being recorded now: first installment for partial, full total otherwise.
    const amountDueNow = isPartialPayment
      ? Number(order.installments[0]?.amount || 0)
      : getOrderTotal(order);

    const lineItems = buildLineItemsFromOrder(order);

    // Every new admin-created project order gets an unpaid invoice at creation time,
    // so this findOne normally
    // succeeds. The create-if-missing branch below is a legacy safety net for orders
    // made before that change (until the Phase 3 backfill migration runs).
    let invoice = await invoiceModel
      .findOne({ orderId: order._id, status: { $in: ["unpaid", "overdue"] } })
      .sort({ installmentNumber: 1, invoiceDate: 1 });

    if (!invoice) {
      invoice = await createProjectInvoice({
        customerId: order.userId,
        orderId: order._id,
        amount: amountDueNow,
        lineItems,
        installmentNumber: isPartialPayment ? 1 : undefined,
      });
    }

    await markProjectInvoicePaid({
      invoice,
      customerId: order.userId,
      paymentMethod,
      transactionReference,
      notes,
      actorId: req.userId,
    });

    // Update order money + installment state, then approve — same math as the create path.
    if (isPartialPayment) {
      order.installments[0].paid = true;
      order.installments[0].paymentStatus = "none";
      order.installments[0].paidDate = new Date();
      order.paidAmount = Number(order.installments[0].amount || 0);
      order.remainingAmount = Math.max(0, getOrderTotal(order) - order.paidAmount);
      order.currentInstallment = 2;
    } else {
      order.paidAmount = getOrderTotal(order);
      order.remainingAmount = 0;
      order.paymentComplete = true;
    }

    const fromVisibility = order.orderVisibility;
    order.orderVisibility = "approved";
    if (order.status === "pending") order.status = "in_progress";
    order.rejectionReason = null;
    // This path sets visibility directly rather than through markOrderApproved(), so it records
    // its own entry. Guarded on the order not already being approved, matching that helper.
    if (fromVisibility !== "approved") {
      logApproved(order, { actorId: req.userId, actorType: ACTOR_TYPE.ADMIN, fromVisibility });
    }
    await order.save();
    await syncProjectFinalInvoice(order);

    return res.status(200).json({
      message: "Payment recorded and project approved",
      success: true,
      error: false,
      data: order,
    });
  } catch (error) {
    console.error("Error approving project order:", error);
    return res.status(500).json({
      message: error.message || "Failed to approve project order",
      error: true,
      success: false,
    });
  }
};

module.exports = approveProjectOrder;
