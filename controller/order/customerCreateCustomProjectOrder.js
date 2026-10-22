const { buildInstallments } = require("../../helpers/projectInstallments");
const mongoose = require("mongoose");
const productModel = require("../../models/productModel");
const orderModel = require("../../models/orderProductModel");
const { requireCategoryForNewProject } = require("../../helpers/projectCategories");
const { initializeProjectTimeline } = require("../../helpers/projectNodeService");
// SSOT: every project order gets an unpaid invoice at creation, via the same shared
// helper used by adminCreateProjectOrder.js and approveProjectOrder.js — so "invoice
// pending" and "project pending" always exist together, never fragmented.
const { createProjectInvoice, markProjectInvoicePaid } = require("../../helpers/paymentRecording");
// Shared transaction-creation SSOT — the order and its payment are created together in one
// request (never a payment-less order). Wallet is the customer's own money so it is debited
// instantly (deductWalletInstant); any UPI remainder is a pending transaction the admin approves.
const {
  createPaymentTransaction,
  deductWalletInstant,
} = require("../../helpers/transactionService");
const userModel = require("../../models/userModel");
const { syncProjectFinalInvoice } = require("../../helpers/projectFinalInvoice");
const { featureCatalogueFilter } = require("../../helpers/featureCatalogue");

// Customer describes a private project instead of buying a catalogue product.
// Its order owns the complete frozen scope in projectSnapshot.

const PAYMENT_TYPES = ["full", "partial", "decide_later"];

const DEFAULT_STARTING_NODE_TITLE = "Project Started";

// Same split conventions as adminCreateProjectOrder.js: 2 => 50/50, 3 => 30/30/40.
// Default progress-gate thresholds (node-system %, admin-editable per project — Layer B):
// installment #1 (advance) has no threshold (always due at creation, gates nothing);
// 2-installment split: #2 due at 90% progress; 3-installment split: #2 at 50%, #3 at 90%.
const DEFAULT_PROGRESS_THRESHOLDS = {
  2: [null, 90],
  3: [null, 50, 90],
};


const customerCreateCustomProjectOrder = async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({
        message: "Authentication required",
        error: true,
        success: false,
      });
    }

    const {
      category,
      featureIds: requestedFeatureIds = [],
      // Per-feature counts for quantity-based features, keyed by feature id — the same
      // payload shape adminCreateProjectOrder.js accepts.
      featureQuantities = {},
      budget,
      ownership,
      paymentType = "full",
      installmentCount,
      couponCode,
      // Payment details for full/partial: the customer pays first (wallet/UPI), then this
      // one request creates the order + invoice + the pending payment transaction together.
      paymentDetails,
    } = req.body;

    // Same customer rule as getCustomerCategoryBasePrice.js: active, opened to customers and priced.
    let categoryEntry;
    try {
      categoryEntry = await requireCategoryForNewProject(category, { customer: true });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        message: error.statusCode ? error.message : "Failed to check the project category",
        error: true,
        success: false,
      });
    }
    const categoryLabel = categoryEntry.label;

    if (!PAYMENT_TYPES.includes(paymentType)) {
      return res.status(400).json({
        message: "Invalid payment type",
        error: true,
        success: false,
      });
    }

    // A full/partial order must never be created without an accompanying payment — that was
    // the old bug where an unpaid order reached the admin. decide_later is the only path
    // that intentionally creates an order with no payment (admin handles payment later).
    const requiresPayment = paymentType !== "decide_later";
    if (requiresPayment && !paymentDetails?.transactionId) {
      return res.status(400).json({
        message: "Payment details are required to create this project order",
        error: true,
        success: false,
      });
    }

    // ----- Price is re-derived server-side; nothing money-related is trusted from the body -----
    const basePrice = categoryEntry.basePrice;

    const requestedIds = Array.isArray(requestedFeatureIds)
      ? requestedFeatureIds.filter((id) => mongoose.Types.ObjectId.isValid(id))
      : [];

    // Only real, non-hidden features offered for this category count — the shared
    // helpers/featureCatalogue.js rule, so this mirrors exactly what
    // StartNewWebsiteCustomize.js offers the customer on the client.
    const featureDocs = requestedIds.length
      ? await productModel
          .find({
            _id: { $in: requestedIds },
            isHidden: { $ne: true },
            ...featureCatalogueFilter(category),
          })
          .select("serviceName sellingPrice price isQuantityBased compatibleWith")
          .lean()
      : [];

    // Only a quantity-based feature may be bought more than once — decided by the
    // catalogue flag the admin sets in the Features form, never by the feature's name.
    // Identical to the mapping in adminCreateProjectOrder.js.
    const clientProjectFeatures = featureDocs.map((feature) => {
      const unitPrice = feature.sellingPrice ?? feature.price ?? 0;
      const requestedQuantity = Number(featureQuantities[String(feature._id)]) || 1;
      const quantity = feature.isQuantityBased ? Math.max(1, requestedQuantity) : 1;
      return {
        featureId: feature._id,
        name: feature.serviceName,
        unitPrice,
        price: unitPrice * quantity,
        quantity,
      };
    });
    const featuresTotal = clientProjectFeatures.reduce(
      (sum, feature) => sum + (feature.price || 0),
      0
    );

    const finalPrice = basePrice + featuresTotal;
    if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
      return res.status(400).json({
        message:
          "Could not determine a price for this project. Please contact support.",
        error: true,
        success: false,
      });
    }

    const startingNodeTitle =
      categoryEntry.startingNodeTitle || DEFAULT_STARTING_NODE_TITLE;

    const isPartialPayment = paymentType === "partial";

    const orderData = {
      userId,
      quantity: 1,
      price: finalPrice,
      originalPrice: finalPrice,
      totalAmount: finalPrice,
      // Customer-initiated => needs admin approval before it goes live.
      orderVisibility: "pending-approval",
      isWebsiteProject: true,
      isPartialPayment,
      paidAmount: 0,
      remainingAmount: finalPrice,
      paymentComplete: false,
      projectProgress: 0,
      messages: [],
      projectSnapshot: {
        displayName: categoryLabel,
        categoryLabel,
        category,
        startingNodeTitle,
        basePrice,
        referenceTotal: finalPrice,
        finalPrice,
        features: clientProjectFeatures,
      },
      orderItems: [
        {
          id: `project:${category}`,
          name: `${categoryLabel} (Base)`,
          type: "main",
          quantity: 1,
          originalPrice: basePrice,
          finalPrice: basePrice,
        },
        // originalPrice is the PER-UNIT price: downloadInvoice.js prints originalPrice x
        // quantity, so putting the already-multiplied total here would bill quantity twice
        // over. Same convention as createOrder.js and adminCreateProjectOrder.js.
        ...clientProjectFeatures.map((feature) => ({
          id: feature.featureId.toString(),
          name: feature.name,
          type: "feature",
          quantity: feature.quantity,
          originalPrice: feature.unitPrice,
          finalPrice: feature.price,
        })),
      ],
    };

    if (couponCode) {
      orderData.couponApplied = couponCode;
    }

    if (isPartialPayment) {
      orderData.installments = buildInstallments(finalPrice, installmentCount);
      orderData.currentInstallment = 1;
    }

    const order = new orderModel(orderData);

    // Every website-project order starts its dynamic timeline at 0% (same as both
    // existing creation paths).
    initializeProjectTimeline({ order, startingNodeTitle, actorId: userId });

    await order.save();

    // SSOT invoice creation — an invoice is only created for money that is DUE NOW (doc 52 §3
    // rule 1): a single invoice for full/decide-later, or ONLY installment #1's invoice for
    // partial. Installments #2, #3, ... get their own invoice later, when they actually become
    // due (doc 52 Phase 3 — created at pay-time by whichever surface collects that installment's
    // payment, e.g. InstallmentPayment.js's backend). All unpaid at creation; whichever part of
    // the payment settles instantly (wallet) marks it paid/partially_paid right below, and any UPI
    // remainder settles it further when admin approves (transactionApprovalController).
    const lineItems = [
      { name: `${categoryLabel} (Base)`, price: basePrice },
      ...clientProjectFeatures.map((feature) => ({ name: feature.name, price: feature.price })),
    ];
    const invoiceDate = new Date();
    // The invoice covering the amount due NOW (installment #1 for partial, the only invoice for
    // full) — this is the one instant wallet money settles below.
    const dueInvoice = isPartialPayment
      ? await createProjectInvoice({
          customerId: userId,
          orderId: order._id,
          amount: order.installments[0].amount,
          lineItems,
          installmentNumber: order.installments[0].installmentNumber,
          invoiceDate,
          dueDate: order.installments[0].dueDate || invoiceDate,
        })
      : await createProjectInvoice({
          customerId: userId,
          orderId: order._id,
          amount: finalPrice,
          lineItems,
          invoiceDate,
        });

    // First installment amount the client should pay now (partial only).
    const firstInstallmentAmount = isPartialPayment
      ? order.installments[0].amount
      : finalPrice;

    // ----- Payment (full/partial only) — the wallet/UPI split is decided HERE, server-side,
    // from the customer's real balance. The client never tells us how much came from wallet;
    // trusting a client-sent split was the old loophole. Wallet is instant (own money); any
    // UPI remainder is a pending transaction the admin approves. -----
    let walletPaid = 0;
    let upiPending = 0;
    let upiTransaction = null;
    const linkedTransactionIds = [];

    if (requiresPayment) {
      const amountDueNow = firstInstallmentAmount;
      const parentTxnId = paymentDetails.transactionId;

      const customer = await userModel.findById(userId).select("walletBalance");
      const walletBalance = Number(customer?.walletBalance || 0);
      const walletPart = Math.min(walletBalance, amountDueNow);
      const upiPart = amountDueNow - walletPart;

      // A UPI remainder requires a UPI reference from the client.
      if (upiPart > 0 && !paymentDetails.upiTransactionId) {
        return res.status(400).json({
          message: "UPI transaction ID is required for the amount not covered by wallet",
          error: true,
          success: false,
        });
      }

      const paymentLabel = isPartialPayment ? "First installment" : "Payment";

      // Wallet portion — instant, no approval. Debited atomically by the server.
      if (walletPart > 0) {
        const walletTxn = await deductWalletInstant({
          userId,
          transactionId: `${parentTxnId}-W`,
          amount: walletPart,
          orderId: order._id,
          installmentNumber: isPartialPayment ? 1 : null,
          isInstallmentPayment: isPartialPayment,
          description: `${paymentLabel} (wallet) for custom project order ${order._id}`,
          // A combined payment links both parts; a wallet-only payment has no parent.
          parentTransactionId: upiPart > 0 ? parentTxnId : null,
        });
        walletPaid = walletPart;
        linkedTransactionIds.push(walletTxn.transactionId);

        // Settle the due invoice by exactly the wallet amount, reusing the SAME wallet
        // transaction (no second transaction — doc 52 Q1). Fully covers it -> 'paid' instantly;
        // a combined payment's wallet part -> 'partially_paid' until the UPI part is approved.
        if (dueInvoice) {
          await markProjectInvoicePaid({
            invoice: dueInvoice,
            customerId: userId,
            paymentMethod: "wallet",
            amount: walletPart,
            existingTransaction: walletTxn.transaction,
          });
        }
      }

      // UPI portion — pending admin approval. Linked to the due invoice (invoiceId) so approving
      // it later settles that SAME invoice for the remaining amount (transactionApprovalController,
      // doc 52 Phase 5) instead of leaving it stuck at 'partially_paid' forever.
      if (upiPart > 0) {
        upiTransaction = await createPaymentTransaction({
          userId,
          transactionId: parentTxnId,
          amount: upiPart,
          upiTransactionId: paymentDetails.upiTransactionId,
          paymentMethod: "upi",
          orderId: order._id,
          invoiceId: dueInvoice?._id || null,
          installmentNumber: isPartialPayment ? 1 : null,
          isInstallmentPayment: isPartialPayment,
          description: `${paymentLabel} (UPI) for custom project order ${order._id}`,
        });
        upiPending = upiPart;
        linkedTransactionIds.push(upiTransaction.transactionId);
      }

      // Order money + approval state:
      //  - fully covered by wallet (no UPI): auto-approve now, first installment is paid.
      //  - any UPI remainder: stays 'pending-approval'; approving the UPI transaction later
      //    (transactionApprovalController) records the rest and flips the order to 'approved'.
      order.paidAmount = walletPaid;
      order.remainingAmount = Math.max(0, finalPrice - walletPaid);

      if (upiPart === 0) {
        if (isPartialPayment) {
          order.installments[0].paid = true;
          order.installments[0].paymentStatus = "none";
          order.installments[0].paidDate = new Date();
          order.currentInstallment = order.installments[1]?.installmentNumber || 1;
        } else {
          order.paymentComplete = true;
        }
        order.orderVisibility = "approved";
        if (order.status === "pending") order.status = "in_progress";
      }

      await order.save();
      if (walletPaid > 0) await syncProjectFinalInvoice(order);
    }

    return res.status(201).json({
      message: "Project request created successfully",
      success: true,
      error: false,
      data: {
        orderId: order._id,
        finalPrice,
        paymentType,
        installments: isPartialPayment ? order.installments : [],
        firstInstallmentAmount,
        walletPaid,
        upiPending,
        approved: requiresPayment ? upiPending === 0 : false,
        transactionIds: linkedTransactionIds,
      },
    });
  } catch (error) {
    console.error("Error creating custom project order:", error);
    return res.status(500).json({
      message: error.message || "Failed to create custom project order",
      error: true,
      success: false,
    });
  }
};

module.exports = customerCreateCustomProjectOrder;
