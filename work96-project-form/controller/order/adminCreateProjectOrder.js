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
const { markProjectInvoicePaid } = require("../../helpers/paymentRecording");
const { syncProjectFinalInvoice } = require("../../helpers/projectFinalInvoice");
const { featureCatalogueFilter } = require("../../helpers/featureCatalogue");

const PAYMENT_METHODS = ["upi", "bank_transfer", "cash", "wallet"];

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

// Default progress-gate thresholds (node-system %, admin-editable per project — Layer B):
// installment #1 (advance) has no threshold (always due at creation, gates nothing);
// 2-installment split: #2 due at 90% progress; 3-installment split: #2 at 50%, #3 at 90%.
const DEFAULT_PROGRESS_THRESHOLDS = {
  2: [null, 90],
  3: [null, 50, 90],
};

const buildInstallments = (totalAmount, installmentCount) => {
  const count = Number(installmentCount) === 3 ? 3 : 2;
  const splits = count === 3 ? [30, 30, 40] : [50, 50];
  const thresholds = DEFAULT_PROGRESS_THRESHOLDS[count];

  return splits.map((percentage, index) => ({
    installmentNumber: index + 1,
    percentage,
    amount: Math.round((totalAmount * percentage) / 100),
    paid: false,
    paymentStatus: "none",
    progressThreshold: thresholds[index],
  }));
};

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

    const client = await userModel.findById(customerId).select("_id");
    if (!client) {
      return res.status(404).json({
        message: "Client not found",
        error: true,
        success: false,
      });
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
    } = req.body;

    if (!category || !sellingPrice) {
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

    const finalPrice = Number(sellingPrice);
    if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
      return res.status(400).json({
        message: "Selling price must be a positive number",
        error: true,
        success: false,
      });
    }

    const shouldRecordPayment = Boolean(recordPayment && recordPayment.paymentMethod);
    if (shouldRecordPayment && !PAYMENT_METHODS.includes(recordPayment.paymentMethod)) {
      return res.status(400).json({
        message: "Invalid payment method",
        error: true,
        success: false,
      });
    }

    // Base price and feature prices are never trusted from the request body —
    // both are re-derived server-side from their source collections.
    const basePriceEntry = await categoryBasePriceModel.findOne({ category }).lean();
    const basePrice = basePriceEntry?.basePrice || 0;

    const requestedIds = Array.isArray(requestedFeatureIds)
      ? requestedFeatureIds.filter((id) => mongoose.Types.ObjectId.isValid(id))
      : [];
    // A feature counts only if it is offered for this project's category — the shared
    // helpers/featureCatalogue.js rule, enforced here because the route is reachable
    // directly, not only through the admin form that applies the same filter client-side.
    const featureDocs = requestedIds.length
      ? await productModel
          .find({ _id: { $in: requestedIds }, ...featureCatalogueFilter(category) })
          .select("serviceName sellingPrice price isQuantityBased compatibleWith")
          .lean()
      : [];

    // Only a quantity-based feature may be bought more than once — decided by the
    // catalogue flag the admin sets in the Features form, never by the feature's name.
    const clientProjectFeatures = featureDocs.map((feature) => {
      const unitPrice = feature.sellingPrice || feature.price || 0;
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
    const featuresTotal = clientProjectFeatures.reduce((sum, feature) => sum + (feature.price || 0), 0);
    const referenceTotal = basePrice + featuresTotal;

    const isPartialPayment = paymentType === "partial";
    // A project order must never be born `approved` without a real payment recorded. When admin
    // defers payment ("Just Add Project, Let Client Pay the Bill"), the order stays
    // `pending-approval`; the same approveProjectOrder.js "record payment to approve" flow closes it out
    // later. Only when a payment IS recorded at creation time (shouldRecordPayment) is the order
    // born approved, right below where that payment actually gets settled.
    const orderData = {
      userId: customerId,
      price: finalPrice,
      totalAmount: finalPrice,
      orderVisibility: shouldRecordPayment ? "approved" : "pending-approval",
      status: shouldRecordPayment ? "in_progress" : "pending",
      isWebsiteProject: true,
      isPartialPayment,
      paidAmount: 0,
      remainingAmount: finalPrice,
      paymentComplete: false,
      projectSnapshot: {
        displayName: projectName?.trim() || CATEGORY_LABELS[category],
        category,
        startingNodeTitle: resolvedStartingNodeTitle,
        totalPages: totalPages || undefined,
        basePrice,
        referenceTotal,
        finalPrice,
        features: clientProjectFeatures,
      },
      orderItems: [
        { id: `project:${category}`, name: `${CATEGORY_LABELS[category]} (Base)`, type: "main", quantity: 1, originalPrice: basePrice, finalPrice: basePrice },
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

    const lineItems = [
      { name: `${CATEGORY_LABELS[category]} (Base)`, price: basePrice },
      ...clientProjectFeatures.map((feature) => ({ name: feature.name, price: feature.price })),
    ];

    const invoiceDate = new Date();
    const createdInvoices = [];
    if (isPartialPayment) {
      // A future installment is not an actionable debt. Create only installment
      // #1 now; settleInstallmentInvoice creates #2/#3 when they are actually due.
      const installment = order.installments[0];
      const invoiceNumber = await generateInvoiceNumber();
      const dueDate = installment.dueDate || invoiceDate;
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
      const invoice = await invoiceModel.create({
        userId: customerId,
        orderId: order._id,
        invoiceNumber,
        invoiceType: "project",
        amount: finalPrice,
        status: "unpaid",
        invoiceDate,
        dueDate: invoiceDate,
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
      await syncProjectFinalInvoice(order);
    }

    return res.status(201).json({
      message: "Project created successfully",
      success: true,
      error: false,
      data: order,
    });
  } catch (error) {
    console.error("Error creating project for client:", error);
    return res.status(500).json({
      message: error.message || "Failed to create project for client",
      error: true,
      success: false,
    });
  }
};

module.exports = adminCreateProjectOrderController;
