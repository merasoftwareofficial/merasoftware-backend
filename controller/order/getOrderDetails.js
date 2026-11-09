const orderProductModel = require("../../models/orderProductModel");
const invoiceModel = require("../../models/invoiceModel");
const transactionModel = require("../../models/transactionModel");
const { getDueUnpaidInvoiceFilter, dueInstallment } = require("../../helpers/projectDuePayment");
const { projectAllowsUploads, projectUploadLimits } = require("../../helpers/projectUploadGate");
const { getOrderState } = require("../../helpers/orderStatusEngine");
const { uploadAllowanceNow } = require("../../helpers/serviceAllowance");
const { buildLifecycleTimeline, getCurrentStateSince } = require("../../helpers/orderLifecycleLog");
const { getPaymentAccess } = require("../../helpers/offerPaymentPolicy");
const { countNewUploads } = require("../../helpers/orderUploadHistory");
const { listFor: listComplimentaryUpgrades } = require("../../helpers/complimentaryUpgrade");

const toPlainObject = (doc) => {
    if (!doc) return null;
    return typeof doc.toObject === "function" ? doc.toObject() : doc;
};

const getCustomerTimeline = (orderData) => {
    if (orderData.projectTimelineVersion !== 1 || !orderData.projectTimelineInitialized) {
        return {
            projectRuns: [],
            projectNodes: [],
            projectNodeEvents: []
        };
    }

    const visibleRuns = (orderData.projectRuns || []).filter(
        (run) => run.status === 'active' || run.showToClient === true
    );
    const visibleRunIds = new Set(visibleRuns.map((run) => run.runId));

    return {
        projectRuns: visibleRuns.map((run) => ({
            runId: run.runId,
            status: run.status,
            startedAt: run.startedAt,
            archivedAt: run.archivedAt,
            showToClient: run.showToClient
        })),
        projectNodes: (orderData.projectNodes || [])
            .filter((node) => visibleRunIds.has(node.runId) && node.visibleToClient === true)
            .map((node) => ({
                nodeId: node.nodeId,
                runId: node.runId,
                title: node.title,
                cumulativeProgress: node.cumulativeProgress,
                status: node.status,
                visibleToClient: node.visibleToClient,
                createdAt: node.createdAt,
                deletedAt: node.deletedAt,
                restoredAt: node.restoredAt,
                messageIds: node.messageIds
            })),
        projectNodeEvents: []
    };
};

const getOrderDetails = async (req, res) => {
    try {
        const { orderId } = req.params;
        const userId = req.userId;
        const isAdmin = req.userRole === 'admin';
        
        const query = isAdmin ? { _id: orderId } : { _id: orderId, userId };

        // Find the specific order for this user or admin
        const order = await orderProductModel.findOne(query);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }
        
        // The unpaid/overdue invoice actually due right now — used by ProjectDetails.js to show
        // a "Payment Pending" lock. Only invoiceModel (project invoices) is checked here, not
        // monthlyInvoiceModel (recurring plans), since this endpoint only serves project orders.
        //
        // For a partial-payment order, a future installment's invoice is created upfront
        // (adminCreateProjectOrder.js) or on-demand (settleInstallmentInvoice.js) and legitimately
        // stays 'unpaid' until its own progressThreshold is reached — that is not "payment
        // pending" for the customer right now. Bug fix: this query used to match ANY unpaid
        // invoice on the order, so paying installment #1 still left installment #2's naturally-
        // unpaid invoice matching, re-showing the "Payment Pending" lock immediately after a
        // correctly-approved payment.
        //
        // Fixed by scoping to order.currentInstallment (the one payment is actually waiting on —
        // it advances only when the previous installment is paid, see transactionApprovalController.js
        // / walletPayInstant.js / approveProjectOrder.js), AND additionally gating on
        // progressThreshold: if that installment has a configured threshold not yet reached by
        // order.projectProgress, it is not due yet either, so it is excluded too (owner-confirmed:
        // "Payment Pending" should only ever reflect a payment the customer can actually act on
        // right now). progressThreshold === null means "always due" (matches installment #1 and
        // pre-existing orders created before this field existed). One-time (non-partial) orders
        // have no installments array, so this falls through unchanged — their single invoice is
        // matched exactly as before.
        //
        // Rule lives in helpers/projectDuePayment.js (shared with getUserOrder.js's list/badge feed).
        const earliestUnpaidInvoiceRead = invoiceModel
            .findOne(getDueUnpaidInvoiceFilter(order))
            .sort({ installmentNumber: 1, invoiceDate: 1 })
            .select('amount status invoiceNumber installmentNumber')
            .lean()
            .exec();

        const serviceInvoicesRead = order.isServicePlan
            ? invoiceModel.find({ orderId: order._id }).sort({ invoiceDate: -1 }).select('invoiceNumber invoiceType amount amountPaid status invoiceDate dueDate serviceCycleNumber').lean().exec()
            : [];

        // A project is the owner of its add-on service relationship. Return its
        // linked service orders with the project detail payload so the customer
        // has one authoritative workspace instead of reconstructing the link
        // from the global Plans list on the client.
        const linkedServicesRead = !order.isServicePlan
            ? orderProductModel
                .find({
                    linkedProjectOrderId: order._id,
                    isServicePlan: true,
                    ...(isAdmin ? {} : { userId }),
                })
                .sort({ createdAt: -1 })
                .select([
                    'productId projectSnapshot orderItems orderVisibility createdAt',
                    'servicePlanSnapshot servicePlanStartDate servicePlanEndDate',
                    'serviceCurrentCycleStart serviceCurrentCycleEnd serviceBillingCycleMonths',
                    'serviceAccessUsedInCycle serviceAccessUsedTotal servicePlanStatus',
                    'linkedProjectOrderId addedDuringProjectPhase',
                    // Needed by helpers/orderStatusEngine.js to classify these rows as services
                    // rather than falling back to a category guess.
                    'isServicePlan isWebsiteProject',
                ].join(' '))
                .populate('productId', 'serviceName category servicePlan formattedDescriptions')
                .lean()
                .exec()
            : [];

        // A payment the customer has already SUBMITTED but the admin has not yet verified.
        // Without this, a submitted-but-unapproved payment is invisible to the customer: the
        // invoice legitimately stays 'unpaid' until approval (only markProjectInvoicePaid settles
        // it), so hasUnpaidInvoice alone kept showing "Payment Pending" — telling the customer to
        // pay again for money they had just sent. The pending transaction is the only record that
        // the money was submitted, so it is derived here alongside hasUnpaidInvoice (same request,
        // same pattern) instead of through a separate endpoint.
        //
        // This replaces the never-implemented `checkPendingOrderTransactions` route ProjectDetails.js
        // used to call — it was never registered in routes/index.js, so that fetch always 404'd and
        // its result was silently discarded (see DOCS/53, which confirmed it dead).
        const pendingPaymentTransactionRead = transactionModel
            .findOne({
                orderId: order._id,
                status: 'pending',
                type: 'payment',
            })
            .sort({ createdAt: -1 })
            .select('amount installmentNumber paymentMethod upiTransactionId createdAt')
            .lean()
            .exec();

        // The admin project page's Uploaded Data badge: this project's uploads and its linked
        // services', the same set its upload history lists. Populate replaces order.userId.
        const ownerId = order.userId;
        const newUploadsCountRead = isAdmin && !order.isServicePlan
            ? linkedServicesRead.then((services) => countNewUploads([order._id, ...services.map((service) => service._id)], ownerId))
            : null;

        // The project page's Complimentary upgrades line, for admin and customer alike: the ₹0
        // invoices Upgrade completed left on this project (helpers/complimentaryUpgrade.js).
        const complimentaryUpgradesRead = !order.isServicePlan ? listComplimentaryUpgrades({ orderId: order._id }) : [];

        // These reads do not depend on each other, so they run together: one round to the
        // database instead of one per read. The filters above read order fields before populate.
        const [, earliestUnpaidInvoice, serviceInvoices, linkedServices, pendingPaymentTransaction, paymentAccess, newUploadsCount, complimentaryUpgrades] = await Promise.all([
            order.populate([
                { path: 'userId', select: 'name email address' },
                { path: 'productId', select: 'serviceName category totalPages validityPeriod updateCount isWebsiteUpdate price sellingPrice isMonthlyLimitedPlan isMonthlyRenewablePlan monthlyUpdateLimit yearlyPlanDuration monthlyRenewalPrice monthlyRenewalCost isServicePlan servicePlan formattedDescriptions' },
                { path: 'assignedDeveloper', select: 'name designation avatar status' },
            ]),
            earliestUnpaidInvoiceRead,
            serviceInvoicesRead,
            linkedServicesRead,
            pendingPaymentTransactionRead,
            order.paymentPolicy ? getPaymentAccess(order) : null,
            newUploadsCountRead,
            complimentaryUpgradesRead,
        ]);

        // Payment Pending: a due, unpaid installment counts even before its invoice exists
        // (helpers/projectDuePayment.js), the same rule the upload gate applies.
        const paymentDue = Boolean(dueInstallment(order)) || Boolean(earliestUnpaidInvoice);

        // Send the complete order details
        const orderData = toPlainObject(order);

        // Linked services get the same derived state as any other order, so the badge on a
        // service inside a project reads identically to the badge on that service's own row.
        linkedServices.forEach((service) => {
            service.orderState = getOrderState(service);
            service.uploadAllowance = uploadAllowanceNow(service);
        });

        // Derived state, from the one place that owns that decision
        // (helpers/orderStatusEngine.js). This endpoint used to build its own `status` string
        // inline, which had no 0%-not-started case, no payment-due case, and never read
        // servicePlanStatus — so every approved order read "In Progress" and a paused service
        // read "Completed".
        //
        // Computed here rather than earlier because hasUnpaidInvoice is only known at this point,
        // and "Payment Pending" is derived from it.
        const orderState = getOrderState({
            ...orderData,
            hasUnpaidInvoice: paymentDue,
        });

        // Lifecycle history — when this order was approved / started / finished / cancelled, and
        // who moved it. Built rather than sent raw so the order's own creation appears as the
        // first entry (createdAt is already an immutable fact; storing a duplicate of it would be
        // one more thing that can disagree with itself) and everything arrives in time order.
        const lifecycleTimeline = buildLifecycleTimeline(orderData);

        // A monthly package project's term and what it lets the client send now (projectUploadGate.js),
        // so the portal shows the end date and remaining updates the server enforces.
        const packageTerm = order.isServicePlan ? null : await projectUploadLimits(order);
        const responseData = {
            ...orderData,
            paymentAccess,
            packageTerm,
            orderState,
            lifecycleTimeline,
            // When the order reached the state it is in now — powers the "since" on a status badge.
            stateSince: getCurrentStateSince(orderData),
            // Kept for the surfaces still reading the old flat string; orderState.label is the
            // same text and is what new code should read.
            status: orderState.label,
            orderNumber: `ORD-${order._id.toString().substr(-4)}`,
            hasUnpaidInvoice: paymentDue,
            unpaidInvoice: earliestUnpaidInvoice || null,
            // false only for a package sold without portal uploads (projectUploadGate.js).
            portalUploads: order.isServicePlan ? null : projectAllowsUploads(order),
            hasPendingPayment: Boolean(pendingPaymentTransaction),
            pendingPayment: pendingPaymentTransaction || null,
            serviceInvoices,
            linkedServices,
            complimentaryUpgrades,
            // "Allowed right now" for a plan (helpers/serviceAllowance.js); null for a project.
            uploadAllowance: order.isServicePlan ? uploadAllowanceNow(orderData) : null,
        };

        if (!isAdmin) {
            Object.assign(responseData, getCustomerTimeline(orderData));
        }

        if (newUploadsCount !== null) {
            responseData.newUploadsCount = newUploadsCount;
        }

        res.status(200).json({
            success: true,
            data: responseData
        });
    } catch (error) {
        console.error('Error fetching order details:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

module.exports = getOrderDetails;
