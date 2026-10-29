const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const orderModel = require("../../models/orderProductModel");
const { buildRefundBreakdown, buildRefundSuggestion, refundOrderToSource } = require("../../helpers/orderRefundService");
const { createNotification } = require("../../helpers/notificationService");
const { sendProjectCancellationEmail } = require("../../helpers/emailService");
const { getOrderDisplayName } = require("../../helpers/orderPresentation");
const { logCancelled, ACTOR_TYPE } = require("../../helpers/orderLifecycleLog");

// Admin-only project cancellation.
//
// Cancelling is the step that was missing between "project is running" and "project is deleted".
// Deleting used to be the only way to stop a project, which meant the money was never settled —
// there was no point in the flow where a refund could happen. Now the money is settled here,
// while the order and its payment records still exist, and delete becomes cleanup only.
//
// SSOT: the refund itself lives in helpers/orderRefundService.js — this controller never moves
// money on its own. It validates, calls the engine, then records the cancellation and tells the
// customer what happened.

const requireAdmin = async (req, res) => {
  const adminUser = await userModel.findById(req.userId).select("roles");
  if (req.userRole !== "admin" || !adminUser?.roles?.includes("admin")) {
    res.status(403).json({ message: "Forbidden", error: true, success: false });
    return false;
  }
  return true;
};

const loadCancellableOrder = async (orderId, res) => {
  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    res.status(400).json({ message: "Valid orderId is required", error: true, success: false });
    return null;
  }

  const order = await orderModel.findById(orderId).populate("productId", "serviceName category");
  if (!order) {
    res.status(404).json({ message: "Order not found", error: true, success: false });
    return null;
  }

  return order;
};

// Services bought as add-ons to this project. A service is only ever linked one way —
// orderProductModel.linkedProjectOrderId — so this is the whole relationship.
//
// They matter here because a cancelled project used to leave its services running: the project
// was dead and refunded, but the renewal cron (which selects on servicePlanStatus: 'active')
// kept billing the customer for add-ons to a project that no longer existed.
const findLinkedServices = async (projectOrderId) =>
  orderModel
    .find({
      linkedProjectOrderId: projectOrderId,
      isServicePlan: true,
      orderVisibility: { $ne: "cancelled" },
    })
    .populate("productId", "serviceName")
    .sort({ createdAt: -1 });

// Preview — what would be refunded, and which methods need a reference id from the admin.
// Read-only: nothing is written, so the admin can open the cancel dialog safely.
const getProjectCancellationPreview = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const order = await loadCancellableOrder(req.params.orderId, res);
    if (!order) return;

    const breakdown = await buildRefundBreakdown(order._id);
    // The suggested figure and the numbers behind it — an unexplained amount just gets
    // overridden, so the admin is shown the working, not only the total.
    const suggestion = buildRefundSuggestion(order, breakdown.refundable);

    // Each linked service gets its own breakdown and suggestion — a service is billed by time,
    // so its refund is a pro-rata figure of its own, not a share of the project's.
    const linkedServices = order.isServicePlan ? [] : await findLinkedServices(order._id);
    const services = [];
    for (const service of linkedServices) {
      const serviceBreakdown = await buildRefundBreakdown(service._id);
      services.push({
        orderId: String(service._id),
        name: getOrderDisplayName(service),
        servicePlanStatus: service.servicePlanStatus || null,
        ...serviceBreakdown,
        suggestion: buildRefundSuggestion(service, serviceBreakdown.refundable),
      });
    }

    return res.status(200).json({
      message: "Cancellation preview",
      success: true,
      error: false,
      data: {
        orderId: String(order._id),
        projectName: getOrderDisplayName(order),
        alreadyCancelled: order.orderVisibility === "cancelled",
        cancelledAt: order.cancelledAt || null,
        isServicePlan: Boolean(order.isServicePlan),
        ...breakdown,
        suggestion,
        services,
      },
    });
  } catch (error) {
    console.error("Error building cancellation preview:", error);
    return res.status(500).json({
      message: error.message || "Failed to build cancellation preview",
      error: true,
      success: false,
    });
  }
};

// Cancel one order and settle its money. Used for the project itself and for each linked
// service the admin chose to cancel with it, so both close the same way.
//
// servicePlanStatus matters as much as orderVisibility here: the renewal cron selects on
// servicePlanStatus: 'active' (cron/servicePlanRenewalCron.js), so a service left 'active'
// keeps generating invoices no matter what its visibility says.
const cancelOneOrder = async ({ order, actorId, reason, refundOptions = {} }) => {
  const { refunds, refundTotal } = await refundOrderToSource({
    order,
    actorId,
    ...refundOptions,
  });

  // Re-read: the refund path saves the order, so the copy above is stale by now.
  const cancelled = await orderModel.findById(order._id);
  const fromVisibility = cancelled.orderVisibility;
  cancelled.orderVisibility = "cancelled";
  cancelled.cancelledAt = new Date();
  cancelled.cancelledBy = actorId;
  cancelled.cancellationReason = reason?.trim() || null;
  // cancelledAt/cancelledBy/cancellationReason stay exactly where they are — they are read
  // directly by the detail views. This adds the same fact to the lifecycle timeline so
  // cancellation appears alongside approval and completion instead of being the one transition
  // with its own private storage.
  logCancelled(cancelled, {
    actorId,
    actorType: ACTOR_TYPE.ADMIN,
    reason: reason?.trim() || null,
    fromVisibility,
  });
  if (cancelled.isServicePlan) {
    cancelled.servicePlanStatus = "cancelled";
    // Nothing is due on a cancelled service — leaving a date here would keep it in the
    // cron's sights even after the status filter is corrected.
    cancelled.serviceNextBillingDate = null;
  }
  await mongoose.connection.transaction(async session => {
    await cancelled.save({ session });
    await require('../../helpers/reservationRelease').releaseProjectReservation({ projectId: cancelled._id, actorId, session });
  });

  return { order: cancelled, refunds, refundTotal };
};

const cancelProjectOrder = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const order = await loadCancellableOrder(req.params.orderId, res);
    if (!order) return;

    if (order.orderVisibility === "cancelled") {
      return res.status(400).json({
        message: "This project is already cancelled",
        error: true,
        success: false,
      });
    }

    // refundAmount omitted => the calculated suggestion is used as-is.
    const {
      reason,
      referenceIds = {},
      refundAmount = null,
      refundMode = "source",
      manualLegs = null,
      refundReason = null,
      // Which linked services to cancel too, and each one's own refund settings.
      serviceIds = [],
      serviceRefundOptions = {},
    } = req.body || {};

    // Services the admin chose to cancel along with the project. Validated BEFORE anything is
    // written: a service that is not actually attached to this project must never be cancelled
    // because an id was passed.
    const chosenServiceIds = Array.isArray(serviceIds) ? serviceIds.map(String) : [];
    let chosenServices = [];
    if (chosenServiceIds.length > 0) {
      const attached = await findLinkedServices(order._id);
      const attachedById = new Map(attached.map((svc) => [String(svc._id), svc]));
      for (const id of chosenServiceIds) {
        const svc = attachedById.get(id);
        if (!svc) {
          return res.status(400).json({
            message: "One of the selected services is not attached to this project",
            error: true,
            success: false,
          });
        }
        chosenServices.push(svc);
      }
    }

    // The project's refund runs first. If it refuses (a missing reference id for an external
    // leg), the order is left completely untouched — a project must never end up cancelled with
    // its money half-settled.
    const { order: cancelledOrder, refunds, refundTotal } = await cancelOneOrder({
      order,
      actorId: req.userId,
      reason,
      refundOptions: { referenceIds, refundAmount, refundMode, manualLegs, refundReason },
    });

    // Then each chosen service, with its own refund figure. The project is already cancelled by
    // now, so a service failing here leaves the project correctly closed rather than rolling
    // back a completed refund — the failure is reported so the admin can retry that service.
    const cancelledServices = [];
    const failedServices = [];
    for (const service of chosenServices) {
      try {
        const options = serviceRefundOptions?.[String(service._id)] || {};
        const result = await cancelOneOrder({
          order: service,
          actorId: req.userId,
          reason,
          refundOptions: {
            referenceIds: options.referenceIds || {},
            refundAmount: options.refundAmount ?? null,
            refundMode: options.refundMode || "source",
            manualLegs: options.manualLegs || null,
            refundReason: options.refundReason || null,
          },
        });
        cancelledServices.push({
          orderId: String(service._id),
          name: getOrderDisplayName(service),
          refundTotal: result.refundTotal,
          refunds: result.refunds,
        });
      } catch (serviceError) {
        failedServices.push({
          orderId: String(service._id),
          name: getOrderDisplayName(service),
          message: serviceError.message,
        });
      }
    }

    // Telling the customer is best-effort — a failed email must never undo a completed refund.
    const customer = await userModel.findById(order.userId).select("name email");
    const projectName = getOrderDisplayName(order);

    // What the customer actually lost and got back, project plus services together.
    const serviceRefundTotal = cancelledServices.reduce((sum, svc) => sum + Number(svc.refundTotal || 0), 0);
    const combinedRefundTotal = refundTotal + serviceRefundTotal;

    if (customer) {
      const refundLine = combinedRefundTotal > 0
        ? ` A refund of ₹${combinedRefundTotal.toLocaleString()} has been processed.`
        : "";
      const serviceLine = cancelledServices.length > 0
        ? ` ${cancelledServices.length} linked service${cancelledServices.length === 1 ? "" : "s"} ${cancelledServices.length === 1 ? "was" : "were"} cancelled with it.`
        : "";
      try {
        await createNotification({
          userId: order.userId,
          type: "project_cancelled",
          title: "Project Cancelled",
          message: `Your project "${projectName}" has been cancelled.${serviceLine}${refundLine}`,
          relatedId: order._id,
          onModel: "OrderProduct",
        });
      } catch (notifyError) {
        console.error("Cancellation notification failed:", notifyError);
      }

      try {
        // One email covering everything that closed, so the customer sees every reference id in
        // one place rather than one mail per service.
        const allRefunds = [
          ...refunds,
          ...cancelledServices.flatMap((svc) => svc.refunds || []),
        ];
        await sendProjectCancellationEmail(customer, order, allRefunds, cancelledOrder.cancellationReason || "");
      } catch (emailError) {
        console.error("Cancellation email failed:", emailError);
      }
    }

    return res.status(200).json({
      message: "Project cancelled successfully",
      success: true,
      error: false,
      data: {
        orderId: String(order._id),
        projectName,
        cancelledAt: cancelledOrder.cancelledAt,
        refunds,
        refundTotal,
        cancelledServices,
        // A service that could not be settled is reported rather than hidden — the project is
        // correctly cancelled, and the admin can retry that service on its own.
        failedServices,
        combinedRefundTotal,
      },
    });
  } catch (error) {
    console.error("Error cancelling project:", error);
    return res.status(500).json({
      message: error.message || "Failed to cancel project",
      error: true,
      success: false,
    });
  }
};

module.exports = { cancelProjectOrder, getProjectCancellationPreview };
