const invoiceModel = require("../models/invoiceModel");
const { getDueUnpaidInvoiceFilter } = require("./projectDuePayment");
const { getOrderState, STATUS } = require("./orderStatusEngine");

// When does a PROJECT refuse an upload?
//
// A project's portal access during development is unlimited — there is no allowance to
// spend and no counter to check (see helpers/uploadType.js). What does gate it is the
// project's own state, and ProjectDetails.js already states that rule for the button:
//
//   isUploadLocked = hasUnpaidInvoice || isOrderPendingApproval
//                    || isProjectComplete || isOrderCancelled
//
// Until now that rule lived ONLY in the UI, while POST /user-request-update is reachable
// directly. deleteProduct.js makes the same point about its own guard: "This guard is
// enforced here, not only in the UI, because this route is reachable directly." So the
// server states it too.
//
// Each condition is answered by the module that already owns it, not re-derived here:
//   cancelled / complete  -> orderStatusEngine.getOrderState (the status SSOT)
//   payment due           -> projectDuePayment.getDueUnpaidInvoiceFilter (the due-invoice SSOT)
//   pending approval      -> orderVisibility, the same field the UI reads
// Restating any of them here is exactly how the server and the button would drift apart.

/**
 * May this project order accept an upload right now?
 *
 * @param {object} order a project order document
 * @returns {Promise<string|null>} the refusal message, or null when the upload may proceed
 */
const assertProjectAcceptsUpload = async (order) => {
  const state = getOrderState(order);

  if (state.code === STATUS.CANCELLED) {
    return "This project has been cancelled and cannot accept uploads";
  }

  if (state.code === STATUS.COMPLETED || Number(order.projectProgress || 0) >= 100) {
    return "This project is complete and cannot accept uploads";
  }

  if (order.orderVisibility === "pending-approval") {
    return "This project is awaiting payment approval. Uploads open once it is approved.";
  }

  const dueUnpaid = await invoiceModel
    .countDocuments(getDueUnpaidInvoiceFilter(order))
    .catch(() => 0);
  if (dueUnpaid > 0) {
    return "A payment is due on this project. Uploads open once the payment is recorded.";
  }

  return null;
};

module.exports = { assertProjectAcceptsUpload };
