const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const productModel = require("../../models/productModel");
const orderModel = require("../../models/orderProductModel");
const { requireCategoryForNewProject } = require("../../helpers/projectCategories");
const { persistAdminProject } = require('../../helpers/adminProjectCreation');
const { sellableFeatureFilter, featureLines } = require("../../helpers/featureCatalogue");
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
          .find({ _id: { $in: requestedIds }, ...sellableFeatureFilter(category) })
          .select("serviceName sellingPrice price isQuantityBased compatibleWith terms")
          .lean()
      : [];
    if (requestedIds.length !== new Set(requestedIds).size || requestedIds.length !== featureDocs.length || !Array.isArray(requestedFeatureIds) || requestedIds.length !== requestedFeatureIds.length) {
      return res.status(400).json({ success: false, error: true, message: 'An additional feature is unavailable for this category. Refresh the feature list.' });
    }

    // Only a quantity-based feature may be bought more than once — decided by the
    // catalogue flag the admin sets in the Features form, never by the feature's name.
    const clientProjectFeatures = featureLines(featureDocs, featureQuantities);
    const featuresTotal = clientProjectFeatures.reduce((sum, feature) => sum + (feature.price || 0), 0);
    let referenceTotal = basePrice + featuresTotal;
    const commercial = await resolveProjectPricing({ body: req.body, category, basePrice, features: clientProjectFeatures, referenceTotal, userId: client._id });
    if (commercial) {
      finalPrice = commercial.finalPrice;
      basePrice = commercial.basePrice;
      referenceTotal = commercial.referenceTotal;
      offer = commercial.agreement.offer;
    }

    // A monthly package is paid per billing cycle (src/docs/monthlypackage.md), never in full or in 2 / 3
    // installments; only a monthly package is. It is made as a plan (packagePlanOrder.js), as a customer's purchase is.
    const monthlyTerm = commercial?.monthly || null;
    if (Boolean(monthlyTerm) !== (paymentType === "monthly")) {
      return res.status(400).json({
        message: monthlyTerm ? "This is a monthly package: it is paid per billing cycle" : "Only a monthly package is paid per billing cycle",
        error: true,
        success: false,
      });
    }
    if (monthlyTerm) {
      const packageItem = (await require('../../helpers/salesPackages').readPackages()).find(row => row.id === req.body.packageId);
      const { buildPackagePlanOrderData, persistPackagePlanOrder, startPaidPackagePlan } = require('../../helpers/packagePlanOrder');
      const orderData = buildPackagePlanOrderData({ userId: customerId, item: packageItem, commercial });
      if (creationKey) { orderData.projectCreationKey = creationKey; orderData.projectCreationHash = creationHash; }
      // Agreed pay-later offer terms: the plan works before payment (as customerCreateServicePlanOrder.js).
      if (!shouldRecordPayment && require('../../helpers/offerPaymentPolicy').allowsDeferredPayment(commercial.paymentPolicy)) orderData.orderVisibility = 'approved';
      const { order, invoice, reused } = await persistPackagePlanOrder({
        orderData, actorId: req.userId, sourceOffer: commercial.sourceOffer, sourceReservationId: commercial.sourceReservationId,
        payment: shouldRecordPayment ? { kind: 'admin', recordPayment, preparedEvidence } : null,
      });
      const saved = reused ? order : await startPaidPackagePlan({ order, invoice });
      // Pay-later terms: the plan is working before payment, so it has started (the paid case is told by the cycle settlement).
      if (!reused && invoice.status !== 'paid' && orderData.orderVisibility === 'approved') require('../../helpers/servicePlanNotifications').notifyPlanStarted(order._id, invoice);
      return res.status(reused ? 200 : 201).json({ message: "Monthly package started as a plan", success: true, error: false, data: saved });
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
        // Terms of the project's add-ons and, unless a package agreement already holds them, of its category.
        terms: [...new Set([...(commercial ? [] : categoryEntry.terms || []), ...clientProjectFeatures.flatMap((feature) => feature.terms || [])])],
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
      sourceOffer: commercial?.sourceOffer, sourceReservationId: commercial?.sourceReservationId,
    });
    // Keep request-scoped review drafts outside the retryable financial transaction.
    if (!reused) await sendProjectCreatedEmail(client, order, invoice);
    if (order.offerReservationId) setImmediate(() => require('../../helpers/offerReservationConfirmation').drainReservationConfirmations().catch(error => console.error('[reservation confirmation]', error.message)));
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
