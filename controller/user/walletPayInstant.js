const mongoose = require("mongoose");
const orderModel = require("../../models/orderProductModel");
const invoiceModel = require("../../models/invoiceModel"); // project invoices (invoiceType:'project')
const monthlyInvoiceModel = require("../../models/monthlyInvoiceModel"); // recurring-plan invoices
const { deductWalletInstant } = require("../../helpers/transactionService");
const { markOrderApproved, isOrderCancelled } = require("../../helpers/orderLifecycle");
const { ACTOR_TYPE } = require("../../helpers/orderLifecycleLog");
const { markInvoicePaidAndResumePlan } = require("../../helpers/invoiceLifecycle");
const {
  markProjectInvoicePaid,
} = require("../../helpers/paymentRecording");
const { settleInstallmentInvoice } = require("../../helpers/installmentSettlement");
// Payment SSOT — an order's paidAmount/remainingAmount are DERIVED from its completed
// transactions, never accumulated by hand here.
const { setOrderPaidAmount } = require("../../helpers/orderPaymentTotals");
const { syncProjectFinalInvoice } = require("../../helpers/projectFinalInvoice");
const { payProjectWallet } = require('../../helpers/projectPaymentSettlement');

// Instant wallet payment for an EXISTING order/installment — no admin approval.
//
// The wallet is the customer's own (already-approved) money, so spending it is instant. This
// is the shared, SSOT-safe replacement for the dead `/wallet/deduct` route that several pages
// called (InstallmentPayment.js, InvoiceDetailPage.js, and the customize flow). It:
//   1. atomically debits the wallet via deductWalletInstant() (guarded, records a completed txn)
//   2. applies that payment to the order exactly like transactionApprovalController does when it
//      approves a payment — marking the installment paid / advancing money + approving the order.
// If the wallet can't cover the amount it throws (caller then falls back to UPI for the rest).
//
// Two payment shapes are supported:
//   - Full settlement (amount covers the whole installment / due): wallet debit settles it, the
//     installment is marked paid and the order is approved immediately.
//   - Partial wallet + UPI remainder (a combined payment): the caller sends only the wallet part
//     here plus a `parentTransactionId`; this debits that part and advances `paidAmount` WITHOUT
//     marking the installment paid or approving the order. The UPI remainder is a separate pending
//     transaction (same parentTransactionId) that the admin approves later — that approval marks
//     the installment paid and flips the order to approved (transactionApprovalController). Both
//     routes SET paidAmount from the order's completed transactions via setOrderPaidAmount(), so
//     the UPI leg simply joins the sum once it completes and nothing has to be added by hand. If
//     the UPI part is later rejected, the paired wallet part is auto-refunded (same controller).

const walletPayInstant = async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({
        message: "Authentication required",
        error: true,
        success: false,
      });
    }

    const { orderId, amount, installmentNumber, parentTransactionId, invoiceId } = req.body;

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        message: "Valid orderId is required",
        error: true,
        success: false,
      });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        message: "A positive amount is required",
        error: true,
        success: false,
      });
    }

    // The order must belong to the caller — a customer can only spend their own wallet on
    // their own order.
    const order = await orderModel.findOne({ _id: orderId, userId });
    if (!order) {
      return res.status(404).json({
        message: "Order not found",
        error: true,
        success: false,
      });
    }

    // A cancelled order has already been settled and refunded — refuse the payment at the door
    // rather than taking money and then declining to approve it further down.
    if (isOrderCancelled(order)) {
      return res.status(400).json({
        message: "This project has been cancelled — no further payment can be made against it",
        error: true,
        success: false,
      });
    }

    if (order.isWebsiteProject && !order.isServicePlan) {
      // A reservation past its deadline is repriced before money settles the bill.
      await require('../../helpers/reservationRepricing').ensureReservationPriceCurrent(order._id);
      const result = await payProjectWallet(userId, req.body);
      return res.status(200).json({ message: 'Wallet payment successful', success: true, error: false, data: {
        transactionId: result.transaction.transactionId, amount: result.transaction.amount,
        walletBalance: result.walletBalance, remainingAmount: result.order.remainingAmount,
        paymentComplete: result.order.paymentComplete, invoiceStatus: result.invoice?.status,
        approved: result.invoice?.status === 'paid',
      } });
    }

    // ---- Invoice mode ----
    // When paying a specific plan invoice (InvoiceDetailPage), settling the order alone is not
    // enough — the invoice document carries its own status and must be marked paid too. This mirrors
    // transactionApprovalController's invoice branch exactly: debit the wallet, then hand off to the
    // shared markInvoicePaidAndResumePlan helper (which marks the invoice paid, ensures a completed
    // transaction, and resumes the order/plan). Order-payment math below is skipped for this mode.
    // Two invoice models exist (doc 52 §2a): the NEW generic invoiceModel (invoiceType:'project',
    // used by every project order) and the legacy monthlyInvoiceModel (recurring plans only). We
    // look up the project invoice first — that is what every InvoiceDetailPage/project payment is
    // — and fall back to the legacy model only if not found there, so recurring-plan invoice
    // payment (if ever routed through this endpoint) keeps working unchanged.
    if (invoiceId) {
      if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
        return res.status(400).json({
          message: "Valid invoiceId is required",
          error: true,
          success: false,
        });
      }

      const projectInvoice = await invoiceModel.findOne({ _id: invoiceId, userId });

      if (projectInvoice) {
        const outstanding = Math.max(0, Number(projectInvoice.amount || 0) - Number(projectInvoice.amountPaid || 0));
        if (numericAmount <= 0 || numericAmount > outstanding) {
          return res.status(400).json({ message: "Payment amount must not exceed the invoice balance", error: true, success: false });
        }
        const invoiceTxnId = `WPAY${Date.now()}${Math.floor(Math.random() * 10000)}`;
        const { transaction, newBalance } = await deductWalletInstant({
          userId,
          transactionId: invoiceTxnId,
          amount: numericAmount,
          orderId: order._id,
          sourceType: "invoice",
          description: `Payment (wallet) for invoice ${projectInvoice.invoiceNumber || projectInvoice._id}`,
        });

        // Settle by exactly the amount paid now, reusing the SAME wallet transaction (no second
        // transaction — doc 52 Q1). Fully covers it -> 'paid'; a smaller amount -> 'partially_paid'.
        const { invoice: settledInvoice } = await markProjectInvoicePaid({
          invoice: projectInvoice,
          customerId: userId,
          paymentMethod: "wallet",
          amount: numericAmount,
          existingTransaction: transaction,
        });

        // A project invoice is only a payment record; its matching order is the
        // financial aggregate. Keep both sources in lockstep for direct invoice
        // payments as well as the normal installment route below.
        // Payment SSOT: derived from the order's completed transactions, not accumulated.
        // deductWalletInstant() above already wrote this debit as a completed transaction, so it
        // is part of the sum by the time this runs. Was `paidAmount += numericAmount`, which
        // double-counted the same money if this route ran twice for one payment.
        await setOrderPaidAmount(order);
        if (projectInvoice.installmentNumber && Array.isArray(order.installments)) {
          const installment = order.installments.find(
            (item) => Number(item.installmentNumber) === Number(projectInvoice.installmentNumber)
          );
          if (installment && settledInvoice.status === "paid") {
            installment.paid = true;
            installment.paidDate = new Date();
            installment.paymentStatus = "none";
            installment.transactionId = transaction.transactionId;
          }
        }
        if (settledInvoice.status === "paid") {
          const nextInstallment = Array.isArray(order.installments)
            ? order.installments.find((item) => !item.paid)
            : null;
          if (nextInstallment) order.currentInstallment = nextInstallment.installmentNumber;
          // A cancelled order stays cancelled — settling money against it must never
          // resurrect it (see helpers/orderLifecycle.js).
          // The customer paid this from their own wallet, so they are the actor.
          markOrderApproved(order, { actorId: userId, actorType: ACTOR_TYPE.CUSTOMER });
        }
        if (order.remainingAmount <= 0) order.paymentComplete = true;
        await order.save();
        await syncProjectFinalInvoice(order);

        return res.status(200).json({
          message: "Wallet payment successful",
          success: true,
          error: false,
          data: {
            transactionId: transaction.transactionId,
            amount: numericAmount,
            walletBalance: newBalance,
            invoiceStatus: settledInvoice.status,
            approved: settledInvoice.status === "paid",
          },
        });
      }

      const monthlyInvoice = await monthlyInvoiceModel.findOne({ _id: invoiceId, userId });
      if (!monthlyInvoice) {
        return res.status(404).json({
          message: "Invoice not found",
          error: true,
          success: false,
        });
      }

      const invoiceTxnId = `WPAY${Date.now()}${Math.floor(Math.random() * 10000)}`;
      const { transaction, newBalance } = await deductWalletInstant({
        userId,
        transactionId: invoiceTxnId,
        amount: numericAmount,
        orderId: order._id,
        sourceType: "invoice",
        description: `Payment (wallet) for invoice ${monthlyInvoice.invoiceNumber || monthlyInvoice._id}`,
      });

      const paidResult = await markInvoicePaidAndResumePlan({
        invoiceId: monthlyInvoice._id,
        paymentMethod: "wallet",
        transactionReference: transaction.transactionId,
        markedPaidBy: userId,
        transaction,
      });

      return res.status(200).json({
        message: "Wallet payment successful",
        success: true,
        error: false,
        data: {
          transactionId: transaction.transactionId,
          amount: numericAmount,
          walletBalance: newBalance,
          invoiceStatus: paidResult.invoice?.status || "paid",
          approved: true,
        },
      });
    }

    const isInstallment =
      installmentNumber != null &&
      Array.isArray(order.installments) &&
      order.installments.length > 0;

    const targetInstallment = isInstallment
      ? order.installments.find(
          (item) => Number(item.installmentNumber) === Number(installmentNumber)
        )
      : null;

    // A partial wallet payment (only part of a combined wallet+UPI payment) settles nothing on its
    // own: the wallet part is debited and `paidAmount` advances, but the installment stays unpaid
    // and the order stays pending until the UPI remainder is approved. We recognise it two ways:
    // the caller sent a parentTransactionId (the UPI remainder's id), OR — for an installment — the
    // wallet amount doesn't cover the whole installment.
    const isCombinedPayment = Boolean(parentTransactionId);
    const coversInstallment = isInstallment
      ? !!targetInstallment && numericAmount >= Number(targetInstallment.amount || 0)
      : numericAmount >= Number(order.remainingAmount || order.totalAmount || order.price || 0);
    const isFullSettlement = !isCombinedPayment && coversInstallment;

    // Debit the wallet atomically (throws if it can't cover the amount) + record a completed txn.
    // For a combined payment the wallet part uses the `${parent}-W` id + links the parent, so a
    // later rejection of the UPI part can find and auto-refund this wallet part
    // (transactionApprovalController's reject path matches parentTransactionId + type 'payment').
    const transactionId = isCombinedPayment
      ? `${parentTransactionId}-W`
      : `WPAY${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const { transaction, newBalance } = await deductWalletInstant({
      userId,
      transactionId,
      amount: numericAmount,
      orderId: order._id,
      installmentNumber: isInstallment ? installmentNumber : null,
      isInstallmentPayment: isInstallment,
      description: `${
        isInstallment ? `Installment ${installmentNumber}` : "Payment"
      } (wallet) for order ${order._id}`,
      parentTransactionId: isCombinedPayment ? parentTransactionId : null,
    });

    // Apply the payment to the order — same rule as transactionApprovalController's approval.
    // Only a FULL settlement marks the installment paid; a partial wallet part leaves the
    // installment for the UPI approval to finish, while the money it brought still counts.
    if (isInstallment && targetInstallment && !targetInstallment.paid && isFullSettlement) {
      targetInstallment.paid = true;
      targetInstallment.paidDate = new Date();
      targetInstallment.paymentStatus = "none";
      targetInstallment.transactionId = transaction.transactionId;
    }

    // Payment SSOT: derived from the order's completed transactions, not accumulated. The debit
    // above is already one of them. Both branches previously did the same `+= numericAmount`
    // followed by a clamp — arithmetic that counted a retried payment twice and had to be kept
    // in step by hand with the identical copy in transactionApprovalController.js.
    //
    // For a combined wallet+UPI payment this is exactly right: only the wallet leg is completed
    // now, so only it is summed; the UPI leg adds itself when it is approved.
    await setOrderPaidAmount(order);

    order.paymentComplete = Number(order.remainingAmount) <= 0;

    const nextInstallment = Array.isArray(order.installments)
      ? order.installments.find((item) => !item.paid)
      : null;
    if (nextInstallment) {
      order.currentInstallment = nextInstallment.installmentNumber;
    }

    // Approve the order only when this wallet payment fully settles the amount due. For a combined
    // payment the order stays as-is (pending-approval) until the admin approves the UPI remainder.
    if (isFullSettlement && markOrderApproved(order, { actorId: userId, actorType: ACTOR_TYPE.CUSTOMER })) {
      order.rejectionReason = null;
    }

    await order.save();

    // Due-based installment invoicing (doc 52 Phase 3): installment #1's invoice already exists
    // from order creation, but #2/#3 only get theirs when they actually become due — i.e. right
    // now, when this installment is being paid. Shared with the UPI-approval route
    // (transactionApprovalController.js) via settleInstallmentInvoice — same find-or-create +
    // markProjectInvoicePaid logic, one settle path regardless of payment method.
    let invoiceStatus = null;
    if (isInstallment) {
      const settledInvoice = await settleInstallmentInvoice({
        order,
        installmentNumber,
        amount: numericAmount,
        paymentMethod: "wallet",
        transaction,
        customerId: userId,
      });
      invoiceStatus = settledInvoice?.status || null;
    }
    await syncProjectFinalInvoice(order);

    return res.status(200).json({
      message: "Wallet payment successful",
      success: true,
      error: false,
      data: {
        transactionId: transaction.transactionId,
        amount: numericAmount,
        walletBalance: newBalance,
        remainingAmount: order.remainingAmount,
        paymentComplete: order.paymentComplete,
        invoiceStatus,
        // true => the wallet fully settled this payment and the order is approved now; false =>
        // this was the wallet part of a combined payment and a UPI remainder still needs approval.
        approved: isFullSettlement,
      },
    });
  } catch (error) {
    console.error("Error in wallet instant payment:", error);
    const message = error.message || "Wallet payment failed";
    // Insufficient balance is a client error, not a server fault.
    const status = error.statusCode || (message.includes("Insufficient") ? 400 : 500);
    return res.status(status).json({
      message,
      error: true,
      success: false,
    });
  }
};

module.exports = walletPayInstant;
