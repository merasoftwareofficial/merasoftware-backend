const productModel = require("../../models/productModel");
const orderModel = require("../../models/orderProductModel");
const userModel = require("../../models/userModel");
// SSOT: every paid order gets an invoice through the same shared helper used by
// the project paths — a service plan is money owed exactly like a project is.
const { createProjectInvoice, markProjectInvoicePaid } = require("../../helpers/paymentRecording");
const { settleServiceCycle } = require("../../helpers/serviceCycleSettlement");
// Shared transaction-creation SSOT. Wallet is the customer's own money so it is
// debited instantly; any UPI remainder is a pending transaction admin approves.
const {
  createPaymentTransaction,
  deductWalletInstant,
} = require("../../helpers/transactionService");
// Shared SSOT for what a purchased service plan looks like — also used by the
// bulk (wallet-only) path, so the two can never drift on price, duration,
// cycle dates or snapshot shape.
// SSOT for the admin's own `dependency` setting: whether this service may be
// bought attached to a project or only on its own.
const { SURFACE, evaluateServiceSurface } = require("../../helpers/serviceDependencyRules");
const {
  SERVICE_PLAN_CATEGORY,
  buildServicePlanOrderData,
  resolveServicePlanPrice,
  resolveValidityInDays,
  runsIndefinitely,
  resolvePurchase,
} = require("../../helpers/servicePlanPurchase");

// Customer-side purchase path for Service Plan products (category "service_plan").
// It follows the shared payment/approval chain and invoice SSOT, but a service plan has no project timeline, no
// installments and no features. Instead it starts a validity window and its first
// service cycle at purchase time.
//
// A service plan can be bought two ways, and this one controller serves both:
//   standalone            -> linkedProjectOrderId omitted
//   add-on to a project   -> linkedProjectOrderId + addedDuringProjectPhase sent
// The linkage is stored as reference/reporting data; it does not branch any logic.
//
// This path accepts wallet, UPI or a combination, and is the ONLY way a service is
// bought — both the standalone page and the in-project Add-a-Service modal call it.
// One payment settles one order, so a service is always bought one at a time.

const PROJECT_PHASES = ["in_progress", "after_completion"];

const customerCreateServicePlanOrder = async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({
        message: "Authentication required",
        error: true,
        success: false,
      });
    }
    // Only a client buys (plan.md 4.2). A staff + client account signed in under its staff role is
    // told to switch, as the customer catalogue does (servicePlanQuote.js customerCatalogue).
    // The admin's "start plan for client" is a different controller (servicePlanAdmin.js).
    if (req.userRole !== 'customer') {
      return res.status(403).json({ success: false, error: true, message: 'Switch to your customer role to buy a plan.' });
    }

    const {
      planId,
      linkedProjectOrderId,
      addedDuringProjectPhase,
      paymentDetails,
    } = req.body;

    if (!planId) {
      return res.status(400).json({
        message: "A plan is required",
        error: true,
        success: false,
      });
    }

    // The plan template is re-read from the DB — price and config are never
    // trusted from the client (same rule as every other order path here).
    const plan = await productModel.findById(planId);

    if (!plan || plan.category !== SERVICE_PLAN_CATEGORY || !plan.isServicePlan) {
      return res.status(400).json({
        message: "This plan is not available",
        error: true,
        success: false,
      });
    }

    if (plan.isHidden || plan.retiredAt || plan.archivedAt) {
      return res.status(400).json({
        message: "This plan is not available for purchase",
        error: true,
        success: false,
      });
    }

    const servicePlan = plan.servicePlan || {};

    // Price, term and choices from the one purchase rule (servicePlanPurchase.js resolvePurchase →
    // servicePlanPricing.js). null only for an old recurring plan without billing options, which
    // keeps its catalogue price and validity window.
    const purchase = resolvePurchase(plan, req.body);
    const billingSelection = purchase?.billingSelection || null;
    const finalPrice = purchase ? purchase.quote.firstPayment : resolveServicePlanPrice(plan);

    if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
      return res.status(400).json({
        message: "Could not determine a price for this plan. Please contact support.",
        error: true,
        success: false,
      });
    }

    // ----- The admin's dependency rule, enforced (not just displayed). The
    // purchase surface is derived from the request itself — a linked project id
    // means this is being bought from inside a project — so the client cannot
    // claim one surface while acting on the other. The listing filters mirror
    // this same rule, but the decision is made here. -----
    const surface = linkedProjectOrderId ? SURFACE.PROJECT : SURFACE.STANDALONE;
    const surfaceCheck = evaluateServiceSurface(servicePlan, surface);
    if (!surfaceCheck.allowed) {
      return res.status(400).json({
        message: surfaceCheck.reason,
        error: true,
        success: false,
        data: { dependency: surfaceCheck.dependency, surface },
      });
    }

    // ----- Add-on linkage (optional). Verified, never trusted: the linked project
    // must exist AND belong to this same customer, so one customer can never
    // attach a service to another customer's project. -----
    let linkedOrder = null;
    if (linkedProjectOrderId) {
      linkedOrder = await orderModel.findOne({ _id: linkedProjectOrderId, userId });
      if (!linkedOrder) {
        return res.status(400).json({
          message: "The project this service is being added to was not found",
          error: true,
          success: false,
        });
      }
      // A cancelled project is finished — its money has already been settled and refunded,
      // so no new service may attach to it and create a fresh payment against a dead project.
      if (linkedOrder.orderVisibility === "cancelled") {
        return res.status(400).json({
          message: "This project has been cancelled — services cannot be added to it",
          error: true,
          success: false,
        });
      }
      if (addedDuringProjectPhase && !PROJECT_PHASES.includes(addedDuringProjectPhase)) {
        return res.status(400).json({
          message: "Invalid project phase",
          error: true,
          success: false,
        });
      }
    }

    // The phase is re-derived server-side from the project's real progress rather
    // than trusting the client's value — the client's is only a hint from the UI.
    const resolvedPhase = linkedOrder
      ? (linkedOrder.projectProgress >= 100 || linkedOrder.currentPhase === "completed"
          ? "after_completion"
          : "in_progress")
      : null;

    // ----- Validity + first cycle window -----
    const validityInDays = resolveValidityInDays(servicePlan);

    if (!billingSelection && !purchase?.oneTimeValidityDays && !runsIndefinitely(servicePlan) && (!Number.isFinite(validityInDays) || validityInDays <= 0)) {
      return res.status(400).json({
        message: "This plan has no valid duration configured. Please contact support.",
        error: true,
        success: false,
      });
    }

    const startDate = new Date();
    const paymentPolicy = await require('../../helpers/serviceOfferPolicy').resolveServiceOffer(plan, req.body);
    const deferred = require('../../helpers/offerPaymentPolicy').allowsDeferredPayment(paymentPolicy);
    if (req.body.deferPayment && !deferred) throw new Error('The selected offer does not allow deferred payment');
    // One purchase attempt = one order and one charge (plan.md 4.2). The key is required for a
    // deferred offer and optional otherwise, so older callers keep working; both portal callers send it.
    // A repeat with the same key and choice answers with the earlier order and takes no money.
    let purchaseKey, purchaseHash;
    if (req.body.deferPayment || req.body.purchaseKey != null) {
      if (typeof req.body.purchaseKey !== 'string' || !/^[a-f\d-]{36}$/i.test(req.body.purchaseKey)) throw new Error('A purchase identifier is required. Refresh and retry.');
      purchaseKey = `${userId}:${req.body.purchaseKey}`;
      purchaseHash = require('node:crypto').createHash('sha256').update(JSON.stringify({ planId: String(plan._id), offer: req.body.offerQuoteKey, linkedProjectOrderId: linkedOrder ? String(linkedOrder._id) : null, billingSelection, choice: purchase ? { files: purchase.quote.files, updates: purchase.quote.updates, releaseMode: purchase.quote.releaseMode, purchase: purchase.quote.purchase } : null })).digest('hex');
      const previous = await orderModel.findOne({ serviceOfferPurchaseKey: purchaseKey });
      if (previous) {
        if (previous.serviceOfferPurchaseHash !== purchaseHash) throw new Error('This purchase identifier belongs to different selections');
        const bill = await require('../../models/invoiceModel').findOne({ orderId: previous._id, serviceCycleNumber: 1, invoiceType: 'project' });
        // A paid attempt left a payment record (wallet debit or UPI waiting for approval). One that
        // stopped before any money moved is not repeated blindly: a person checks it.
        const settled = bill && (req.body.deferPayment || await require('../../models/transactionModel').exists({ orderId: previous._id }));
        if (!settled) throw new Error('Previous purchase needs review; no duplicate purchase was created');
        return res.status(200).json({ success: true, data: { orderId: previous._id, invoiceId: bill._id, finalPrice: previous.totalAmount, paymentPending: bill.status !== 'paid', repeated: true } });
      }
    }
    // Validate payment evidence before any order/invoice write, including no-offer purchases.
    if (!req.body.deferPayment && (!paymentDetails?.transactionId)) throw new Error('Payment details are required');

    // Order shape (snapshot, validity window, first cycle) comes from the shared
    // helper so this path and the bulk path stay identical on everything except
    // how the money is collected.
    const orderData = buildServicePlanOrderData({
      userId,
      plan,
      price: finalPrice,
      validityInDays,
      linkedProjectOrderId: linkedOrder ? linkedOrder._id : null,
      addedDuringProjectPhase: resolvedPhase,
      startDate,
      billingSelection,
      quote: purchase?.quote || null,
      oneTimeValidityDays: purchase?.oneTimeValidityDays || null,
    });

    const endDate = orderData.servicePlanEndDate;

    const order = new orderModel(orderData);
    order.paymentPolicy = paymentPolicy;
    if (purchaseKey) { order.serviceOfferPurchaseKey = purchaseKey; order.serviceOfferPurchaseHash = purchaseHash; }
    if (deferred) order.orderVisibility = 'approved'; // Work permission, never payment verification.
    if (!req.body.deferPayment) {
      const buyer = await userModel.findById(userId).select('walletBalance');
      if (Math.max(0, finalPrice - Number(buyer?.walletBalance || 0)) > 0 && !paymentDetails.upiTransactionId) throw new Error('UPI transaction ID is required for the amount not covered by wallet');
    }
    if (!req.body.deferPayment) await order.save();

    // SSOT invoice — created unpaid, then settled by whatever the customer pays below.
    const invoiceData = {
      customerId: userId,
      orderId: order._id,
      amount: finalPrice,
      lineItems: [{ name: plan.serviceName, price: finalPrice }],
      invoiceDate: new Date(),
      dueDate: paymentPolicy ? require('../../helpers/offerPaymentPolicy').paymentDueDate(paymentPolicy, startDate) : undefined,
      serviceCycleNumber: 1,
    };
    let invoice;
    if (req.body.deferPayment) {
      await require('mongoose').connection.transaction(async session => {
        await order.save({ session });
        invoice = await createProjectInvoice({ ...invoiceData, session });
      });
    } else invoice = await createProjectInvoice(invoiceData);
    if (req.body.deferPayment) {
      await require('../../helpers/serviceBillingStatement').syncServiceBillingStatement(order);
      // Agreed pay-later terms: the plan is working before payment, so it has started.
      require('../../helpers/servicePlanNotifications').notifyPlanStarted(order._id, invoice);
      return res.status(201).json({ success: true, message: 'Service created with the agreed payment terms', data: { orderId: order._id, invoiceId: invoice._id, finalPrice, walletPaid: 0, upiPending: 0, paymentPending: true, dueDate: invoice.dueDate } });
    }

    // ----- Payment. The wallet/UPI split is decided HERE, server-side, from the
    // customer's real balance — the client never tells us how much came from
    // wallet. Wallet is instant (own money); any UPI remainder waits for admin. -----
    let walletPaid = 0;
    let upiPending = 0;
    const linkedTransactionIds = [];

    if (!paymentDetails || !paymentDetails.transactionId) {
      return res.status(400).json({
        message: "Payment details are required",
        error: true,
        success: false,
      });
    }

    const parentTxnId = paymentDetails.transactionId;

    const customer = await userModel.findById(userId).select("walletBalance");
    const walletBalance = Number(customer?.walletBalance || 0);
    const walletPart = Math.min(walletBalance, finalPrice);
    const upiPart = finalPrice - walletPart;

    if (upiPart > 0 && !paymentDetails.upiTransactionId) {
      return res.status(400).json({
        message: "UPI transaction ID is required for the amount not covered by wallet",
        error: true,
        success: false,
      });
    }

    // Wallet portion — instant, no approval, debited atomically by the server.
    if (walletPart > 0) {
      const walletTxn = await deductWalletInstant({
        userId,
        transactionId: `${parentTxnId}-W`,
        amount: walletPart,
        orderId: order._id,
        description: `Payment (wallet) for service plan order ${order._id}`,
        parentTransactionId: upiPart > 0 ? parentTxnId : null,
      });
      walletPaid = walletPart;
      linkedTransactionIds.push(walletTxn.transactionId);

      // Settle the invoice by exactly the wallet amount, reusing the SAME wallet
      // transaction — a payment never writes two transactions.
      if (invoice) {
        const settled = await markProjectInvoicePaid({
          invoice,
          customerId: userId,
          paymentMethod: "wallet",
          amount: walletPart,
          existingTransaction: walletTxn.transaction,
        });
        invoice.status = settled.invoice.status;
        invoice.amountPaid = settled.invoice.amountPaid;
        invoice.paidDate = settled.invoice.paidDate;
      }
    }

    // UPI portion — pending admin approval, linked to the invoice so approving it
    // later settles that SAME invoice instead of leaving it partially paid forever.
    if (upiPart > 0) {
      const upiTransaction = await createPaymentTransaction({
        userId,
        transactionId: parentTxnId,
        amount: upiPart,
        upiTransactionId: paymentDetails.upiTransactionId,
        paymentMethod: "upi",
        orderId: order._id,
        invoiceId: invoice?._id || null,
        description: `Payment (UPI) for service plan order ${order._id}`,
      });
      upiPending = upiPart;
      linkedTransactionIds.push(upiTransaction.transactionId);
    }

    order.paidAmount = walletPaid;
    order.remainingAmount = Math.max(0, finalPrice - walletPaid);

    // Fully covered by wallet => approve now. Any UPI remainder keeps the order
    // pending until admin approves that transaction.
    if (upiPart === 0) {
      order.paymentComplete = true;
      order.orderVisibility = "approved";
      if (order.status === "pending") order.status = "in_progress";
    }

    await order.save();
    if (upiPart === 0 && invoice.status === "paid") {
      await settleServiceCycle({ orderId: order._id, invoice });
    }
    // Client "payment submitted" (UPI part) and the admin's copy; Off until turned On (plan.md 4.1).
    await require('../../helpers/servicePlanNotifications').preparePurchaseMails(order._id, {
      walletPaid, upiPending, upiReference: upiPart > 0 ? paymentDetails.upiTransactionId : '',
    });

    return res.status(201).json({
      message: "Service plan purchased successfully",
      success: true,
      error: false,
      data: {
        orderId: order._id,
        finalPrice,
        walletPaid,
        upiPending,
        linkedTransactionIds,
        invoiceId: invoice?._id || null,
        servicePlanStartDate: startDate,
        servicePlanEndDate: endDate,
        linkedProjectOrderId: order.linkedProjectOrderId,
      },
    });
  } catch (error) {
    // Two requests with one purchase key at the same moment: the unique index lets only one order
    // be saved, before any money moves. The other is told to check, never charged twice.
    if (error.code === 11000 && error.keyPattern?.serviceOfferPurchaseKey) {
      return res.status(409).json({ message: "This purchase is already being processed. Check your plans before trying again.", error: true, success: false });
    }
    return res.status(error.statusCode || 400).json({
      message: error.message || "Failed to purchase service plan",
      error: true,
      success: false,
    });
  }
};

module.exports = customerCreateServicePlanOrder;
