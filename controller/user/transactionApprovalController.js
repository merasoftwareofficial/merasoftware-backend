const transactionModel = require("../../models/transactionModel");
const userModel = require("../../models/userModel");
const orderProductModel = require("../../models/orderProductModel");
const invoiceModel = require("../../models/invoiceModel"); // project invoices (invoiceType:'project')
const { markInvoicePaidAndResumePlan } = require("../../helpers/invoiceLifecycle"); // monthlyInvoiceModel only
const { markProjectInvoicePaid, reverseProjectInvoicePayment } = require("../../helpers/paymentRecording");
const { settleInstallmentInvoice } = require("../../helpers/installmentSettlement");
const { syncProjectFinalInvoice } = require("../../helpers/projectFinalInvoice");
const { settleServiceCycle } = require('../../helpers/serviceCycleSettlement');
const { syncServiceBillingStatement } = require('../../helpers/serviceBillingStatement');
// Refund helper — when a combined payment's UPI portion is rejected, its already-debited
// wallet portion must be returned to the customer.
const { refundWalletInstant } = require("../../helpers/transactionService");
const { markOrderApproved } = require("../../helpers/orderLifecycle");
// Payment SSOT — an order's paidAmount/remainingAmount are DERIVED from its completed
// transactions, never accumulated by hand here.
const { setOrderPaidAmount } = require("../../helpers/orderPaymentTotals");
const { logRejected, ACTOR_TYPE } = require("../../helpers/orderLifecycleLog");
const { projectForTransaction, approveProjectPayment, rejectProjectPayment } = require('../../helpers/projectPaymentSettlement');

const requireAdmin = (req, res) => {
  if (req.userRole !== "admin") {
    res.status(403).json({
      message: "Forbidden",
      error: true,
      success: false,
    });
    return false;
  }

  return true;
};

const getTransactionIdFromRequest = (req) =>
  req.params.transactionId || req.body?.transactionId || req.query?.transactionId;

const getOrderTotal = (order) => Number(order?.totalAmount || order?.totalPrice || order?.price || 0);

const isInvoiceTransaction = (transaction) =>
  transaction?.sourceType === "invoice" || Boolean(transaction?.invoiceId);

const isOrderPaymentTransaction = (transaction) =>
  ["order", "installment", "renewal", null, undefined].includes(transaction?.sourceType) &&
  Boolean(transaction?.orderId) &&
  transaction?.sourceType !== "invoice";

// Applies an approved payment's money to an order — marks the installment paid (or advances
// paidAmount for a non-installment order), advances paidAmount/remainingAmount, and approves the
// order. Shared by the plain order-payment path AND the project-invoice path below (doc 52 Phase 5)
// so both settle an order's money through the exact same logic — no duplicated math.
//
// Partial-payment SSOT correction: a plain UPI installment transaction (sourceType:'installment',
// no invoiceId) used to settle the order's own fields here but never touched invoiceModel — only
// the wallet-instant route (walletPayInstant.js) settled the invoice. That left a UPI-paid
// installment's invoice `unpaid` forever, the same class of bug doc 52 fixed for the full-wallet
// case. This now calls the SAME settleInstallmentInvoice helper walletPayInstant.js uses, so every
// route settles an installment's invoice through identical logic — one settle path, not three.
//
// settleInvoice=false is passed by the invoice-mode caller (applyApprovedOrderPayment's
// isInvoiceTransaction branch), which already settled this exact invoice via markProjectInvoicePaid
// BEFORE calling this function (transaction.invoiceId case) — settling again here would be a
// second, redundant write against the same invoice for the same transaction.
const applyOrderMoneyForTransaction = async (order, transaction, { settleInvoice = true } = {}) => {
  const amount = Number(transaction.amount || 0);

  if (transaction.type === "renewal") {
    order.isActive = true;
    order.autoRenewalStatus = "active";
    await order.save();
    return order;
  }

  let dueSettled = false;

  if (transaction.installmentNumber && Array.isArray(order.installments) && order.installments.length > 0) {
    const installment = order.installments.find(
      (item) => Number(item.installmentNumber) === Number(transaction.installmentNumber)
    );

    if (installment && !installment.paid) {
      // Settle the bill first. Approval of one payment is not proof that the
      // entire installment was received (wallet + UPI and partial payments).
      const settledInvoice = settleInvoice
        ? await settleInstallmentInvoice({
          order, installmentNumber: installment.installmentNumber, amount,
          paymentMethod: transaction.paymentMethod, transaction,
          customerId: transaction.userId,
          transactionReference: transaction.upiTransactionId || transaction.transactionId,
          actorId: transaction.verifiedBy,
        })
        : await invoiceModel.findById(transaction.invoiceId);
      dueSettled = settledInvoice?.status === 'paid';
      installment.paid = dueSettled;
      installment.paidDate = dueSettled ? settledInvoice.paidDate || new Date() : null;
      installment.paymentStatus = "none";
      installment.transactionId = transaction.transactionId;
    }
  }

  // Payment SSOT: SET the order's money from its completed transactions rather than adding this
  // payment's amount onto whatever was stored. The caller marks `transaction.status = "completed"`
  // and saves it BEFORE reaching here, so this payment is already part of what is summed.
  //
  // Was: `paidAmount += amount` in both branches, then a clamp. That trusted the stored figure to
  // be right and this call to happen exactly once — if approval ran twice, or ran after a partial
  // failure, the same money was counted twice. Deriving makes a repeat produce the same answer,
  // and makes the order agree with its transactions by construction rather than by arithmetic.
  //
  // Returns null for a service order, whose paidAmount means "what the current billing cycle was
  // paid" and belongs to helpers/serviceCycleSettlement.js; leave those exactly as they were.
  await setOrderPaidAmount(order);

  order.paymentComplete = Number(order.remainingAmount) <= 0;
  if (!order.isPartialPayment) dueSettled = order.paymentComplete;

  const nextInstallment = Array.isArray(order.installments)
    ? order.installments.find((installment) => !installment.paid)
    : null;
  if (nextInstallment) {
    order.currentInstallment = nextInstallment.installmentNumber;
  }

  // A cancelled order stays cancelled — approving a still-pending payment against it must
  // never resurrect it (see helpers/orderLifecycle.js).
  // verifiedBy is the admin who approved this transaction — set by approveTransaction() before
  // this runs — so the lifecycle entry records who actually approved the order.
  if (dueSettled && markOrderApproved(order, { actorId: transaction.verifiedBy, actorType: ACTOR_TYPE.ADMIN })) {
    order.rejectionReason = null;
  }

  await order.save();

  await syncProjectFinalInvoice(order);

  return order;
};

const applyApprovedOrderPayment = async (transaction) => {
  if (isInvoiceTransaction(transaction)) {
    if (!transaction.invoiceId) {
      return { order: null, invoice: null };
    }

    // Two invoice models exist (doc 52 §2a) — look up the project invoice first (every project
    // order's invoice lives here); fall back to the legacy monthlyInvoiceModel (recurring plans).
    const projectInvoice = await invoiceModel.findById(transaction.invoiceId);

    if (projectInvoice) {
      const outstanding = Math.max(0, Number(projectInvoice.amount || 0) - Number(projectInvoice.amountPaid || 0));
      if (Number(transaction.amount || 0) <= 0 || Number(transaction.amount || 0) > outstanding) {
        throw new Error("Transaction amount exceeds the invoice balance");
      }
      const { invoice: settledInvoice } = await markProjectInvoicePaid({
        invoice: projectInvoice,
        customerId: transaction.userId,
        paymentMethod: transaction.paymentMethod,
        transactionReference: transaction.upiTransactionId || transaction.transactionId,
        actorId: transaction.verifiedBy,
        amount: Number(transaction.amount || 0),
        existingTransaction: transaction,
      });

      const serviceOrder = await orderProductModel.findOne({
        _id: transaction.orderId || projectInvoice.orderId,
        isServicePlan: true,
      });
      // Both an initial service payment and a renewal payment settle a service
      // cycle. They must not go through project/installment accounting.
      if (serviceOrder) {
        const order = await settleServiceCycle({ orderId: serviceOrder._id, invoice: settledInvoice });
        return { order, invoice: settledInvoice, transaction };
      }

      // A project invoice also has an order behind it — settle the order's money too (installment
      // paid / paidAmount / approval), through the SAME logic the plain order-payment path uses.
      let order = null;
      if (transaction.orderId) {
        order = await orderProductModel.findById(transaction.orderId).populate("productId");
        if (order) {
          // This transaction's invoice (settledInvoice, above) is already settled — don't let
          // applyOrderMoneyForTransaction settle it again just because the transaction also
          // carries an installmentNumber.
          order = await applyOrderMoneyForTransaction(order, transaction, { settleInvoice: false });
        }
      }

      return { order, invoice: settledInvoice, transaction };
    }

    const paidResult = await markInvoicePaidAndResumePlan({
      invoiceId: transaction.invoiceId,
      paymentMethod: transaction.paymentMethod,
      transactionReference: transaction.upiTransactionId || transaction.transactionId,
      markedPaidBy: transaction.verifiedBy,
      transaction,
    });

    return {
      order: paidResult.order,
      invoice: paidResult.invoice,
      transaction: paidResult.transaction,
    };
  }

  if (!isOrderPaymentTransaction(transaction)) {
    return { order: null, invoice: null };
  }

  if (!transaction?.orderId) {
    return { order: null, invoice: null };
  }

  const order = await orderProductModel.findById(transaction.orderId).populate("productId");
  if (!order) {
    return { order: null, invoice: null };
  }

  const updatedOrder = await applyOrderMoneyForTransaction(order, transaction);
  return { order: updatedOrder, invoice: null };
};

// ---------------------------------------------------------------------------
const rejectLinkedOrderPayment = async (transaction, rejectionReason) => {
  // A plain order-payment transaction rejects its order/installment directly below. A project
  // invoice transaction (invoiceId points at invoiceModel) also has an order behind it and needs
  // the same rejection (doc 52 Phase 5). A recurring-plan invoice transaction (invoiceId points at
  // monthlyInvoiceModel, or type 'renewal') has its OWN handling elsewhere — even though it also
  // carries an orderId, it must NOT fall through this order-payment logic (that would wrongly
  // touch installments a recurring plan doesn't have in the same shape).
  if (transaction?.type === "renewal") return null;
  if (!transaction?.orderId) return null;

  if (isInvoiceTransaction(transaction)) {
    const projectInvoice = await invoiceModel.exists({ _id: transaction.invoiceId });
    if (!projectInvoice) return null; // recurring-plan invoice — not handled here
  }

  const order = await orderProductModel.findById(transaction.orderId);
  if (!order) return null;

  if (transaction.installmentNumber && Array.isArray(order.installments)) {
    const installment = order.installments.find(
      (item) => Number(item.installmentNumber) === Number(transaction.installmentNumber)
    );
    if (installment && !installment.paid) {
      installment.paymentStatus = "rejected";
      installment.transactionId = transaction.transactionId;
    }
  }

  const hasPaidInstallment =
    Array.isArray(order.installments) && order.installments.some((installment) => installment.paid);

  if (!hasPaidInstallment && Number(order.paidAmount || 0) <= 0) {
    const fromVisibility = order.orderVisibility;
    order.orderVisibility = "payment-rejected";
    // Recorded only when the order actually moves to rejected. An order that already has paid
    // money keeps its visibility (only this transaction was refused), so it gets no lifecycle
    // entry — the rejection belongs to the transaction, not to the order's own state.
    logRejected(order, {
      actorId: transaction?.verifiedBy || null,
      actorType: ACTOR_TYPE.ADMIN,
      reason: rejectionReason || "Payment rejected by admin",
      fromVisibility,
    });
  }

  order.rejectionReason = rejectionReason || "Payment rejected by admin";
  await order.save();

  return order;
};

// Rolls back the financial state previously advanced by an instant wallet portion. The paired UPI
// transaction was rejected, so that wallet money never became a valid payment for its invoice/order.
const reverseWalletPortionSettlement = async (walletPortion) => {
  const amount = Number(walletPortion?.amount || 0);
  if (!walletPortion?.orderId || !(amount > 0)) return null;

  if (walletPortion.invoiceId) {
    const invoice = await invoiceModel.findById(walletPortion.invoiceId);
    if (invoice) await reverseProjectInvoicePayment({ invoice, amount });
  }

  const order = await orderProductModel.findById(walletPortion.orderId);
  if (!order) return null;

  // NOT moved onto setOrderPaidAmount(), deliberately. Its caller reverses the settlement HERE
  // and only afterwards calls refundWalletInstant(), which writes the `type:'refund'` transaction
  // the SSOT sum subtracts. Deriving at this point would therefore read the money as still
  // received and undo nothing. The subtraction stays explicit until the refund transaction is
  // written before the reversal rather than after it.
  const orderTotal = getOrderTotal(order);
  order.paidAmount = Math.max(0, Number(order.paidAmount || 0) - amount);
  order.remainingAmount = Math.max(0, orderTotal - Number(order.paidAmount || 0));
  order.paymentComplete = order.remainingAmount <= 0;
  await order.save();

  if (order.isServicePlan) {
    await syncServiceBillingStatement(order);
  } else {
    await syncProjectFinalInvoice(order);
  }

  return order;
};

// Refund every wallet debit that hangs off a parent id. A combined payment has one; a batch
// has one per service. The financial rollback happens before its wallet credit, so the customer
// can never have refunded money while the invoice/order still shows it as paid.
const refundWalletPortionsFor = async (parentRef, rejectedRef) => {
  if (!parentRef) return;

  const walletPortions = await transactionModel.find({
    parentTransactionId: parentRef,
    paymentMethod: "wallet",
    type: "payment",
    status: "completed",
  });

  for (const walletPortion of walletPortions) {
    await reverseWalletPortionSettlement(walletPortion);
    await refundWalletInstant({
      userId: walletPortion.userId,
      transactionId: `${walletPortion.transactionId}-REFUND`,
      amount: walletPortion.amount,
      description: `Refund for rejected payment ${rejectedRef}`,
      parentTransactionId: parentRef,
      orderId: walletPortion.orderId || null,
    });
  }
};

const approveTransaction = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const transactionId = getTransactionIdFromRequest(req);
    if (!transactionId) {
      return res.status(400).json({
        message: "transactionId is required",
        success: false,
        error: true,
      });
    }

    const transaction = await transactionModel.findOne({ transactionId });
    if (!transaction) {
      return res.status(404).json({
        message: "Transaction not found",
        success: false,
        error: true,
      });
    }

    if (transaction.status !== "pending") {
      return res.status(400).json({
        message: `Transaction is already ${transaction.status}`,
        success: false,
        error: true,
      });
    }

    const projectOrder = await projectForTransaction(transaction);
    if (projectOrder) {
      // A payment submitted in time is held under review; a later one meets the current price.
      await require('../../helpers/reservationRepricing').ensureReservationPriceCurrent(projectOrder._id);
      const result = await approveProjectPayment(transactionId, req.userId);
      const updated = await transactionModel.findById(result.transaction._id)
        .populate('userId', 'name email walletBalance').populate('productId', 'serviceName').populate('verifiedBy', 'name email');
      return res.status(200).json({ message: 'Transaction approved successfully', success: true, error: false,
        data: { ...result, transaction: updated } });
    }

    const amount = Number(transaction.amount || 0);
    const user = await userModel.findById(transaction.userId);
    if (!user) {
      return res.status(404).json({
        message: "Transaction user not found",
        success: false,
        error: true,
      });
    }

    if (transaction.paymentMethod === "wallet" && ["payment", "renewal"].includes(transaction.type)) {
      if (Number(user.walletBalance || 0) < amount) {
        return res.status(400).json({
          message: "Customer wallet balance is lower than the pending payment amount",
          success: false,
          error: true,
        });
      }
      user.walletBalance = Number(user.walletBalance || 0) - amount;
      await user.save();
    }

    if (transaction.type === "deposit") {
      user.walletBalance = Number(user.walletBalance || 0) + amount;
      await user.save();
    }

    transaction.verifiedBy = req.userId;
    transaction.verificationDate = new Date();
    transaction.rejectionReason = null;
    transaction.rejectedAt = null;
    transaction.rejectedBy = null;

    // An approval settles three things — the invoice, the order, and this transaction's own
    // status. They must move together or not at all. Was: applyApprovedOrderPayment() ran first
    // and the transaction was only marked 'completed' afterwards, so anything that threw in
    // between (a real case: settleServiceCycle -> getCycleDates on a plan with no billing-cycle
    // length) left the invoice already marked PAID while the transaction stayed 'pending'. The
    // order was then unapprovable forever: retrying hit the invoice-balance guard, because the
    // invoice had no outstanding amount left to settle. Marking the transaction BEFORE applying
    // the money keeps every write inside one try — if applying throws, the catch below restores
    // the transaction to exactly the state it was read in, so a failed approval leaves nothing
    // half-written and can simply be retried once the underlying cause is fixed.
    // walletDelta records the balance change already applied above, so a failed apply can put
    // the customer's money back too — otherwise a throw would leave them debited for a payment
    // that never completed.
    const previousState = {
      status: transaction.status,
      paymentStatus: transaction.paymentStatus,
      walletDelta:
        transaction.paymentMethod === "wallet" && ["payment", "renewal"].includes(transaction.type)
          ? amount
          : transaction.type === "deposit"
          ? -amount
          : 0,
    };

    transaction.status = "completed";
    transaction.paymentStatus = "approved";
    await transaction.save();

    let linkedResult;
    try {
      linkedResult = await applyApprovedOrderPayment(transaction);
    } catch (applyError) {
      transaction.status = previousState.status;
      transaction.paymentStatus = previousState.paymentStatus;
      transaction.verifiedBy = null;
      transaction.verificationDate = null;
      await transaction.save();
      if (previousState.walletDelta) {
        await userModel.updateOne(
          { _id: transaction.userId },
          { $inc: { walletBalance: previousState.walletDelta } }
        );
      }
      throw applyError;
    }

    const updatedTransaction = await transactionModel
      .findById(transaction._id)
      .populate("userId", "name email walletBalance")
      .populate("productId", "serviceName")
      .populate("verifiedBy", "name email");

    return res.status(200).json({
      message: "Transaction approved successfully",
      success: true,
      error: false,
      data: {
        transaction: updatedTransaction,
        order: linkedResult.order,
        invoice: linkedResult.invoice,
        walletBalance: user.walletBalance,
      },
    });
  } catch (error) {
    console.error("Error approving transaction:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to approve transaction",
      success: false,
      error: true,
    });
  }
};

const rejectTransaction = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const transactionId = getTransactionIdFromRequest(req);
    const rejectionReason = (req.body?.rejectionReason || "").trim();

    if (!transactionId) {
      return res.status(400).json({
        message: "transactionId is required",
        success: false,
        error: true,
      });
    }

    if (!rejectionReason) {
      return res.status(400).json({
        message: "Rejection reason is required",
        success: false,
        error: true,
      });
    }

    const transaction = await transactionModel.findOne({ transactionId });
    if (!transaction) {
      return res.status(404).json({
        message: "Transaction not found",
        success: false,
        error: true,
      });
    }

    if (transaction.status !== "pending") {
      return res.status(400).json({
        message: `Transaction is already ${transaction.status}`,
        success: false,
        error: true,
      });
    }

    if (await projectForTransaction(transaction)) {
      const result = await rejectProjectPayment(transactionId, req.userId, rejectionReason);
      const updated = await transactionModel.findById(result.transaction._id)
        .populate('userId', 'name email walletBalance').populate('productId', 'serviceName')
        .populate('verifiedBy', 'name email').populate('rejectedBy', 'name email');
      return res.status(200).json({ message: 'Transaction rejected successfully', success: true, error: false,
        data: { order: result.order, transaction: updated } });
    }

    // Combined payment: refund the paired wallet portion that was already debited at purchase.
    // In every creation path (customerCreateServicePlanOrder.js,
    // customerCreateCustomProjectOrder.js, walletPayInstant.js) the UPI leg IS the parent — its
    // own transactionId is the shared id and its parentTransactionId is null — while the wallet
    // debit carries that id in parentTransactionId. Checking this transaction's own id as well
    // as its parent covers the link from either end; without the first, a rejected combined
    // payment silently kept the customer's wallet money.
    await refundWalletPortionsFor(transaction.transactionId, transaction.transactionId);
    await refundWalletPortionsFor(transaction.parentTransactionId, transaction.transactionId);

    transaction.status = "rejected";
    transaction.paymentStatus = "rejected";
    transaction.rejectionReason = rejectionReason;
    transaction.rejectedAt = new Date();
    transaction.rejectedBy = req.userId;
    transaction.verifiedBy = req.userId;
    transaction.verificationDate = new Date();
    await transaction.save();

    const order = await rejectLinkedOrderPayment(transaction, rejectionReason);
    // A plan's UPI payment was rejected: the client is told why (plan.md 4.1; Off until turned On).
    if (order?.isServicePlan) await require('../../helpers/servicePlanNotifications').preparePaymentRejected(order._id, transaction, rejectionReason);

    const updatedTransaction = await transactionModel
      .findById(transaction._id)
      .populate("userId", "name email walletBalance")
      .populate("productId", "serviceName")
      .populate("verifiedBy", "name email")
      .populate("rejectedBy", "name email");

    return res.status(200).json({
      message: "Transaction rejected successfully",
      success: true,
      error: false,
      data: {
        transaction: updatedTransaction,
        order,
      },
    });
  } catch (error) {
    console.error("Error rejecting transaction:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to reject transaction",
      success: false,
      error: true,
    });
  }
};

module.exports = {
  approveTransaction,
  rejectTransaction,
};
