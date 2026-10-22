const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const productModel = require("../../models/productModel");
const orderModel = require("../../models/orderProductModel");
const categoryBasePriceModel = require("../../models/categoryBasePriceModel");
const invoiceModel = require("../../models/invoiceModel");
const generateInvoiceNumber = require("../../helpers/generateInvoiceNumber");
const { initializeProjectTimeline } = require("../../helpers/projectNodeService");
// Shared SSOT payment-recording helper (extracted from this file) — reused by the
// project-approval flow so both paths write one transaction + one invoice, never two.
const { markProjectInvoicePaid, buildLineItemsFromOrder } = require("../../helpers/paymentRecording");
const { syncProjectFinalInvoice } = require("../../helpers/projectFinalInvoice");
const { featureCatalogueFilter } = require("../../helpers/featureCatalogue");
const { ADMIN_PAYMENT_METHODS, preparePaymentEvidence } = require("../../helpers/paymentEvidence");
const { sendProjectCreatedEmail } = require("../../helpers/emailService");
const { resolveProjectPricing } = require('../../helpers/projectPricing');
const { buildInstallments } = require('../../helpers/projectInstallments');
const { createHash } = require('node:crypto');

const PAYMENT_METHODS = ADMIN_PAYMENT_METHODS;

const PROJECT_CATEGORIES = [
  "standard_websites",
  "dynamic_websites",
  "cloud_software_development",
  "app_development",
];

const CATEGORY_LABELS = {
  standard_websites: "Standard Website",
  dynamic_websites: "Dynamic Website",
  cloud_software_development: "Cloud Software",
  app_development: "App Development",
};

const DEFAULT_STARTING_NODE_TITLE = "Project Started";

const adminCreateProjectOrderController = async (req, res) => {
  try {
    const adminUser = await userModel.findById(req.userId).select("roles");
    if (req.userRole !== "admin" || !adminUser?.roles?.includes("admin")) {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { customerId } = req.params;
    if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({
        message: "Valid customerId is required",
        error: true,
        success: false,
      });
    }

    const client = await userModel.findById(customerId).select("_id name email");
    if (!client) {
      return res.status(404).json({
        message: "Client not found",
        error: true,
        success: false,
      });
    }

    let creationKey, creationHash;
    if (req.body.creationKey) {
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(req.body.creationKey)) return res.status(400).json({ success: false, message: 'Invalid project request key' });
      creationKey = `${req.userId}:${req.body.creationKey}`;
      creationHash = createHash('sha256').update(JSON.stringify({ customerId, body: req.body })).digest('hex');
      const existing = await orderModel.findOne({ projectCreationKey: creationKey });
      if (existing) {
        if (existing.projectCreationHash !== creationHash || !existing.projectCreationComplete) return res.status(409).json({ success: false, message: 'This creation request already exists. Refresh the client projects before trying again.' });
        return res.status(200).json({ success: true, error: false, message: 'Project was already created', data: existing });
      }
    }

    const {
      projectName,
      startingNodeTitle,
      category,
      totalPages,
      sellingPrice,
      featureIds: requestedFeatureIds = [],
      featureQuantities = {},
      paymentType,
      installmentCount,
      recordPayment,
      offerSlug,
    } = req.body;

    // 0 is a real price (a FREE project / 100% discount), so only a missing value is refused.
    if (!category || sellingPrice === undefined || sellingPrice === null || sellingPrice === "") {
      return res.status(400).json({
        message: "Category and selling price are required",
        error: true,
        success: false,
      });
    }

    const resolvedStartingNodeTitle = startingNodeTitle?.trim() || DEFAULT_STARTING_NODE_TITLE;

    if (!PROJECT_CATEGORIES.includes(category)) {
      return res.status(400).json({
        message: "Invalid project category",
        error: true,
        success: false,
      });
    }

    let finalPrice = Number(sellingPrice);
    if (!Number.isFinite(finalPrice) || finalPrice < 0 || Math.round(finalPrice * 100) / 100 !== finalPrice) {
      return res.status(400).json({
        message: "Selling price must be zero or more, with at most two decimal places",
        error: true,
        success: false,
      });
    }

    // A FREE project has nothing to collect: no installments and no payment to record.
    const isFree = finalPrice === 0;
    if (isFree && paymentType === "partial") {
      return res.status(400).json({
        message: "A free project cannot be split into installments",
        error: true,
        success: false,
      });
    }

    const shouldRecordPayment = !isFree && Boolean(recordPayment && recordPayment.paymentMethod);
    if (shouldRecordPayment && !PAYMENT_METHODS.includes(recordPayment.paymentMethod)) {
      return res.status(400).json({
        message: "Invalid payment method",
        error: true,
        success: false,
      });
    }

    // Everything that can be refused is checked before anything is written, so a bad payment
    // reference or a stale offer never leaves a half-created project behind.
    const preparedEvidence = shouldRecordPayment
      ? await preparePaymentEvidence({
          paymentMethod: recordPayment.paymentMethod,
          reference: recordPayment.transactionReference,
          details: recordPayment.paymentDetails || {},
          capturedVia: "admin",
        })
      : null;

    let offer = null;

    // Base price and feature prices are never trusted from the request body —
    // both are re-derived server-side from their source collections.
    const basePriceEntry = await categoryBasePriceModel.findOne({ category }).lean();
    let basePrice = basePriceEntry?.basePrice || 0;

    const requestedIds = Array.isArray(requestedFeatureIds)
      ? requestedFeatureIds.filter((id) => mongoose.Types.ObjectId.isValid(id))
      : [];
    // A feature counts only if it is offered for this project's category — the shared
    // helpers/featureCatalogue.js rule, enforced here because the route is reachable
    // directly, not only through the admin form that applies the same filter client-side.
    const featureDocs = requestedIds.length
      ? await productModel
          .find({ _id: { $in: requestedIds }, isHidden: { $ne: true }, retiredAt: null, archivedAt: null, ...featureCatalogueFilter(category) })
          .select("serviceName sellingPrice price isQuantityBased compatibleWith")
          .lean()
      : [];
    if (requestedIds.length !== new Set(requestedIds).size || requestedIds.length !== featureDocs.length || !Array.isArray(requestedFeatureIds) || requestedIds.length !== requestedFeatureIds.length) {
      return res.status(400).json({ success: false, error: true, message: 'An additional feature is unavailable for this category. Refresh the feature list.' });
    }

    // Only a quantity-based feature may be bought more than once — decided by the
    // catalogue flag the admin sets in the Features form, never by the feature's name.
    const clientProjectFeatures = featureDocs.map((feature) => {
      const unitPrice = feature.sellingPrice ?? feature.price ?? 0;
      const rawQuantity = featureQuantities[String(feature._id)];
      const requestedQuantity = rawQuantity === undefined ? 1 : Number(rawQuantity);
      if (feature.isQuantityBased && (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 1000)) throw Object.assign(new Error('Feature quantity must be a whole number between 1 and 1000'), { statusCode: 400 });
      const quantity = feature.isQuantityBased ? Math.max(1, requestedQuantity) : 1;
      return {
        featureId: feature._id,
        name: feature.serviceName,
        unitPrice,
        price: Math.round(unitPrice * quantity * 100) / 100,
        quantity,
      };
    });
    const featuresTotal = clientProjectFeatures.reduce((sum, feature) => sum + (feature.price || 0), 0);
    let referenceTotal = basePrice + featuresTotal;
    const commercial = await resolveProjectPricing({ body: req.body, category, basePrice, features: clientProjectFeatures, referenceTotal });
    if (commercial) {
      finalPrice = commercial.finalPrice;
      basePrice = commercial.basePrice;
      referenceTotal = commercial.referenceTotal;
      offer = commercial.agreement.offer;
    }

    const isPartialPayment = !isFree && paymentType === "partial";
    // A project order must never be born `approved` without a real payment recorded. When admin
    // defers payment ("Just Add Project, Let Client Pay the Bill"), the order stays
    // `pending-approval`; the same approveProjectOrder.js "record payment to approve" flow closes it out
    // later. Only when a payment IS recorded at creation time (shouldRecordPayment) is the order
    // born approved, right below where that payment actually gets settled. The one exception is a
    // FREE project: there is nothing to pay, so it is fully settled and approved from birth.
    const startsApproved = shouldRecordPayment || isFree || require('../../helpers/offerPaymentPolicy').allowsDeferredPayment(commercial?.paymentPolicy);
    const orderData = {
      paymentPolicy: commercial?.paymentPolicy || null,
      ...(creationKey ? { projectCreationKey: creationKey, projectCreationHash: creationHash } : {}),
      userId: customerId,
      price: finalPrice,
      totalAmount: finalPrice,
      orderVisibility: startsApproved ? "approved" : "pending-approval",
      status: startsApproved ? "in_progress" : "pending",
      isWebsiteProject: true,
      isPartialPayment,
      paidAmount: 0,
      remainingAmount: finalPrice,
      paymentComplete: isFree,
      projectSnapshot: {
        displayName: projectName?.trim() || commercial?.agreement.package?.name || offer?.title || CATEGORY_LABELS[category],
        category,
        startingNodeTitle: resolvedStartingNodeTitle,
        totalPages: totalPages || undefined,
        basePrice,
        referenceTotal,
        finalPrice,
        features: clientProjectFeatures,
        ...(commercial ? { salesAgreement: commercial.agreement } : {}),
        ...(offer ? { offer: { slug: offer.slug, title: offer.title } } : {}),
      },
      orderItems: [
        { id: `project:${category}`, name: commercial?.agreement.package?.name || offer?.title || `${CATEGORY_LABELS[category]} (Base)`, type: "main", quantity: 1, originalPrice: basePrice, finalPrice: basePrice },
        // originalPrice is the PER-UNIT price: downloadInvoice.js prints originalPrice x quantity,
        // so putting the already-multiplied total here would bill quantity twice over.
        // Same convention as createOrder.js's feature line items.
        ...clientProjectFeatures.map((feature) => ({ id: String(feature.featureId), name: feature.name, type: "feature", quantity: feature.quantity, originalPrice: feature.unitPrice, finalPrice: feature.price })),
      ],
    };

    if (isPartialPayment) {
      orderData.installments = buildInstallments(finalPrice, installmentCount);
    }

    const order = new orderModel(orderData);

    initializeProjectTimeline({
      order,
      startingNodeTitle: resolvedStartingNodeTitle,
      actorId: req.userId,
    });

    await order.save();

    // Shared builder: the base + feature rows, plus a "Discount" row whenever the agreed price
    // is below them — the same lines approval, installment and final invoices use.
    const lineItems = buildLineItemsFromOrder(order);

    const invoiceDate = new Date();
    const createdInvoices = [];
    if (isPartialPayment) {
      // A future installment is not an actionable debt. Create only installment
      // #1 now; settleInstallmentInvoice creates #2/#3 when they are actually due.
      const installment = order.installments[0];
      const invoiceNumber = await generateInvoiceNumber();
      const dueDate = commercial?.paymentPolicy ? require('../../helpers/offerPaymentPolicy').paymentDueDate(commercial.paymentPolicy, invoiceDate) : installment.dueDate || invoiceDate;
      if (commercial?.paymentPolicy) order.installments[0].dueDate = dueDate;
      const invoice = await invoiceModel.create({
        userId: customerId,
        orderId: order._id,
        invoiceNumber,
        invoiceType: "project",
        amount: installment.amount,
        status: "unpaid",
        invoiceDate,
        dueDate,
        installmentNumber: installment.installmentNumber,
        lineItems,
      });
      createdInvoices.push(invoice);
    } else {
      const invoiceNumber = await generateInvoiceNumber();
      // A FREE project's ₹0 invoice is settled from birth — there is no payment to wait for.
      // Status is set here directly because deriveInvoiceStatus() treats a 0 total as unpaid.
      const invoice = await invoiceModel.create({
        userId: customerId,
        orderId: order._id,
        invoiceNumber,
        invoiceType: "project",
        amount: finalPrice,
        amountPaid: 0,
        status: isFree ? "paid" : "unpaid",
        invoiceDate,
        dueDate: commercial?.paymentPolicy ? require('../../helpers/offerPaymentPolicy').paymentDueDate(commercial.paymentPolicy, invoiceDate) : invoiceDate,
        ...(isFree ? { paidDate: invoiceDate } : {}),
        lineItems,
      });
      createdInvoices.push(invoice);
    }

    // Only the first invoice (full amount for one-time, or installment #1 for partial)
    // can be recorded paid at creation time — matches the "Payment Settings" step, which
    // only ever asks for the first-due amount, never later installments in advance.
    if (shouldRecordPayment && createdInvoices.length > 0) {
      await markProjectInvoicePaid({
        invoice: createdInvoices[0],
        customerId,
        paymentMethod: recordPayment.paymentMethod,
        transactionReference: recordPayment.transactionReference,
        paymentDetails: recordPayment.paymentDetails || {},
        preparedEvidence,
        notes: recordPayment.notes,
        actorId: req.userId,
      });

      if (!isPartialPayment) {
        order.paidAmount = finalPrice;
        order.remainingAmount = 0;
        order.paymentComplete = true;
        await order.save();
      } else {
        order.installments[0].paid = true;
        order.installments[0].paymentStatus = "none";
        order.installments[0].paidDate = new Date();
        order.paidAmount = order.installments[0].amount;
        order.remainingAmount = finalPrice - order.installments[0].amount;
        order.currentInstallment = 2;
        await order.save();
      }
    }
    // The statement is a summary, not a second payable bill. Make it available even before payment.
    if (commercial?.paymentPolicy && isPartialPayment) await order.save();
    await syncProjectFinalInvoice(order);

    // Queues the "project started" mail; the response then carries its draft id and the admin
    // panel shows the same Send / Don't Send review popup project cancellation already shows.
    // Best-effort: the builder never throws, so a mail problem never undoes a created project.
    await sendProjectCreatedEmail(client, order, createdInvoices[0]);
    if (creationKey) {
      order.projectCreationComplete = true;
      await order.save();
    }

    return res.status(201).json({
      message: "Project created successfully",
      success: true,
      error: false,
      data: order,
    });
  } catch (error) {
    console.error("Error creating project for client:", error);
    return res.status(error.code === 11000 ? 409 : error.statusCode || 500).json({
      message: error.code === 11000 ? 'This request already exists. Refresh client projects before retrying.' : error.message || "Failed to create project for client",
      error: true,
      success: false,
    });
  }
};

module.exports = adminCreateProjectOrderController;
