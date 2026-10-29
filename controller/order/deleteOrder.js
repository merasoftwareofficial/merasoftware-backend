const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const orderModel = require("../../models/orderProductModel");
const updateRequestModel = require("../../models/updateRequestModel");
const monthlyInvoiceModel = require("../../models/monthlyInvoiceModel");
const invoiceModel = require("../../models/invoiceModel");
const transactionModel = require("../../models/transactionModel");
const { getOrderAmountReceived } = require("../../helpers/orderPaymentTotals");
const partnerCommissionModel = require("../../models/partnerCommissionModel");
const GoogleDriveService = require("../../helpers/googleDriveService");
const buildOrderDeletePlan = require("../../helpers/orderDeletePlan");

let KEY_FILE_PATH;
if (process.env.NODE_ENV === "production" && process.env.GOOGLE_DRIVE_CREDENTIALS_PATH) {
  KEY_FILE_PATH = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH;
} else {
  KEY_FILE_PATH = require("path").join(__dirname, "../../config/google-drive-credentials.json");
}

const FOLDER_NAME = "ClientUpdateFiles";

const toSelectionSet = (selectedSections) =>
  new Set((Array.isArray(selectedSections) ? selectedSections : []).map((section) => String(section)));

const validateSelection = (plan, selectedSections) => {
  const requestedSelection = toSelectionSet(selectedSections);
  const requiredSelection = new Set(plan.requiredSectionKeys);

  if (requestedSelection.size !== requiredSelection.size) {
    return {
      valid: false,
      missing: plan.requiredSectionKeys.filter((key) => !requestedSelection.has(key)),
      extra: [...requestedSelection].filter((key) => !requiredSelection.has(key)),
    };
  }

  const missing = plan.requiredSectionKeys.filter((key) => !requestedSelection.has(key));
  const extra = [...requestedSelection].filter((key) => !requiredSelection.has(key));

  return {
    valid: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
};

const deleteOrderController = async (req, res) => {
  const session = await mongoose.startSession();
  let transactionStarted = false;

  try {
    const user = await userModel.findById(req.userId).select("roles");
    if (req.userRole !== "admin" || !user?.roles?.includes("admin")) {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { orderId } = req.params;
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        message: "Valid orderId is required",
        error: true,
        success: false,
      });
    }

    const plan = await buildOrderDeletePlan(orderId);
    if (!plan.hasAnyDeleteableRecord) {
      return res.status(404).json({
        message: "Delete target not found",
        error: true,
        success: false,
      });
    }

    // Cancel before delete. Cancelling is what settles and refunds the money while the payment
    // records still exist; deleting is only cleanup afterwards. Allowing a straight delete is how
    // a customer's money used to disappear with no refund and no record of the payment.
    // An order nothing was ever paid on has no money to settle, so it can be deleted directly.
    if (plan.orderPresent && !plan.isCancelled) {
      const received = await getOrderAmountReceived(orderId);
      if (received > 0) {
        return res.status(400).json({
          message: "Cancel this project first — its payments must be settled before it can be deleted",
          error: true,
          success: false,
          data: { requiresCancellation: true, amountReceived: received },
        });
      }
    }

    const { selectedSections } = req.body || {};
    const selectionCheck = validateSelection(plan, selectedSections);
    if (!selectionCheck.valid) {
      return res.status(400).json({
        message: "All available delete sections must be selected before deletion",
        error: true,
        success: false,
        data: {
          missingSections: selectionCheck.missing,
          extraSections: selectionCheck.extra,
          requiredSectionKeys: plan.requiredSectionKeys,
        },
      });
    }

    const orderObjectId = new mongoose.Types.ObjectId(orderId);
    const driveService = plan.driveFileIds.length > 0
      ? new GoogleDriveService(KEY_FILE_PATH, FOLDER_NAME)
      : null;

    session.startTransaction();
    transactionStarted = true;

    try {
      for (const fileId of plan.driveFileIds) {
        await driveService.deleteFile(fileId);
      }

      await invoiceModel.updateMany(
        { orderId: orderObjectId },
        {
          deletedProjectName: plan.serviceName,
          deletedProjectType: plan.orderType,
          deletedProjectStartDate: plan.startDate,
          deletedProjectDeletedAt: new Date(),
          deletedProjectPaymentMethod: plan.paymentMethod,
        }
      ).session(session);
      // Transactions survive the delete, so they need the same name/type snapshot the invoices
      // get — once the order is gone their orderId resolves to nothing.
      await transactionModel.updateMany(
        { orderId: orderObjectId },
        {
          deletedProjectName: plan.serviceName,
          deletedProjectType: plan.orderType,
        }
      ).session(session);
      await updateRequestModel.deleteMany({ updatePlanId: orderObjectId }).session(session);
      await monthlyInvoiceModel.deleteMany({ orderId: orderObjectId }).session(session);
      await partnerCommissionModel.deleteMany({ orderId: orderObjectId }).session(session);
      await require('../../helpers/reservationRelease').releaseProjectReservation({ projectId: orderObjectId, actorId: req.userId, deleting: true, session });
      await orderModel.deleteOne({ _id: orderObjectId }).session(session);

      await session.commitTransaction();

      return res.status(200).json({
        message: "Project and all linked data deleted successfully",
        success: true,
        error: false,
        data: {
          orderId,
          serviceName: plan.serviceName,
          orderType: plan.orderType,
          deletedCounts: plan.counts,
        },
      });
    } catch (error) {
      if (transactionStarted && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw error;
    }
  } catch (error) {
    console.error("Error deleting project:", error);
    return res.status(500).json({
      message: error.message || "Failed to delete project",
      error: true,
      success: false,
    });
  } finally {
    await session.endSession();
  }
};

module.exports = deleteOrderController;
