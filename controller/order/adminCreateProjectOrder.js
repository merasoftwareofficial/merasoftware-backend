const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const productModel = require("../../models/productModel");
const orderModel = require("../../models/orderProductModel");
const { requireCategoryForNewProject } = require("../../helpers/projectCategories");
const { persistAdminProject } = require('../../helpers/adminProjectCreation');
const { featureCatalogueFilter } = require("../../helpers/featureCatalogue");
const { ADMIN_PAYMENT_METHODS, preparePaymentEvidence } = require("../../helpers/paymentEvidence");
const { sendProjectCreatedEmail } = require("../../helpers/emailService");
const { resolveProjectPricing } = require('../../helpers/projectPricing');
const { buildInstallments } = require('../../helpers/projectInstallments');
const { createHash } = require('node:crypto');

const PAYMENT_METHODS = ADMIN_PAYMENT_METHODS;

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

    // Active category from the SSOT (helpers/projectCategories.js); an archived or unknown one is refused.
    const categoryEntry = await requireCategoryForNewProject(category);
    const resolvedStartingNodeTitle = startingNodeTitle?.trim() || categoryEntry.startingNodeTitle || DEFAULT_STARTING_NODE_TITLE;

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
    let basePrice = categoryEntry.basePrice || 0;

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
        displayName: projectName?.trim() || commercial?.agreement.package?.name || offer?.title || categoryEntry.label,
        categoryLabel: categoryEntry.label,
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
        { id: `project:${category}`, name: commercial?.agreement.package?.name || offer?.title || `${categoryEntry.label} (Base)`, type: "main", quantity: 1, originalPrice: basePrice, finalPrice: basePrice },
        // originalPrice is the PER-UNIT price: downloadInvoice.js prints originalPrice x quantity,
        // so putting the already-multiplied total here would bill quantity twice over.
        // Same convention as createOrder.js's feature line items.
        ...clientProjectFeatures.map((feature) => ({ id: String(feature.featureId), name: feature.name, type: "feature", quantity: feature.quantity, originalPrice: feature.unitPrice, finalPrice: feature.price })),
      ],
    };

    if (isPartialPayment) {
      orderData.installments = buildInstallments(finalPrice, installmentCount);
    }

    const { order, invoice, reused } = await persistAdminProject({
      orderData, startingNodeTitle: resolvedStartingNodeTitle, actorId: req.userId,
      recordPayment: shouldRecordPayment ? recordPayment : null, preparedEvidence,
    });
    // Keep request-scoped review drafts outside the retryable financial transaction.
    if (!reused) await sendProjectCreatedEmail(client, order, invoice);
    return res.status(reused ? 200 : 201).json({
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
