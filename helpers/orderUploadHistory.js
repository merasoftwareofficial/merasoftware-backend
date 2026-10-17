const mongoose = require("mongoose");
const updateRequestModel = require("../models/updateRequestModel");
const orderModel = require("../models/orderProductModel");

// Shared source of truth for "what has the customer uploaded against this order".
//
// Read-only. Used by both the customer-facing endpoint and the admin one, so neither
// side can ever show a different history or a different set of files — the same
// arrangement clientDocumentsTimeline.js provides for admin-sent documents.
//
// Why the order alone is not enough to find the records:
// An upload is always recorded against whichever order supplied the allowance
// (submitUpdateRequest.js stores it as updatePlanId). Verified against live data, that
// lands in three different shapes:
//   1. a service linked to a project   (updatePlanId = the service, linkedProjectOrderId = the project)
//   2. a standalone service            (updatePlanId = the service, no project)
//   3. the project/plan order itself   (updatePlanId = that order)
// So a project has to be asked for its own records AND those of every service linked to
// it, or its uploads stay invisible — which is exactly what the project page showed
// before this helper existed. A service order is asked for its own records only; its
// parent project is where the combined view lives, and repeating them in both places
// would show the same upload twice.

const toObjectId = (value) => {
  try {
    return new mongoose.Types.ObjectId(String(value));
  } catch (error) {
    return null;
  }
};

// Direct-download URL for a stored file.
// downloadLink was historically dropped by the schema, so every pre-existing file has
// only driveFileId. Derive from that and fall back to the stored link when present,
// so old and new records behave identically.
const buildDownloadLink = (file) => {
  if (file?.downloadLink) return file.downloadLink;
  if (file?.driveFileId) return `https://drive.google.com/uc?export=download&id=${file.driveFileId}`;
  return file?.driveLink || "";
};

/**
 * Has this file passed its expiry?
 * fileCleanupScheduler.js removes expired files from Drive, so an expired row can be
 * listed but never fetched.
 */
const isFileExpired = (file, now = new Date()) =>
  Boolean(file?.expirationDate) && new Date(file.expirationDate) < now;

/**
 * The files of one upload that can actually be fetched from Drive right now.
 *
 * The single answer to "which files are downloadable" — the listing uses it to decide
 * whether to offer a download, and the zip route uses it to decide what to put in the
 * archive. Keeping the test here means the two can never disagree and offer a download
 * that then produces an empty zip.
 */
const getDownloadableFiles = (files, now = new Date()) =>
  (files || []).filter((file) => file?.driveFileId && !isFileExpired(file, now));

/**
 * Which order ids carry this order's uploads.
 * A project also owns the records of the services linked to it; a service owns only its own.
 */
const resolveUploadOwnerIds = async (orderId) => {
  const orderObjectId = toObjectId(orderId);
  if (!orderObjectId) return [];

  const order = await orderModel
    .findById(orderObjectId)
    .select("_id isServicePlan")
    .lean();
  if (!order) return [];

  const ids = [order._id];

  if (!order.isServicePlan) {
    const linkedServices = await orderModel
      .find({ linkedProjectOrderId: order._id, isServicePlan: true })
      .select("_id")
      .lean();
    linkedServices.forEach((service) => ids.push(service._id));
  }

  return ids;
};

/**
 * The upload history for one order, newest first.
 *
 * @param {string} orderId
 * @param {object} [options]
 * @param {string} [options.userId] restrict to this customer's records; omit for admin reads.
 * @returns {Promise<Array>} one entry per upload attempt
 */
const getOrderUploadHistory = async (orderId, { userId } = {}) => {
  const ownerIds = await resolveUploadOwnerIds(orderId);
  if (ownerIds.length === 0) return [];

  const query = { updatePlanId: { $in: ownerIds } };
  // A customer read is scoped to their own records; an admin read is not, so that an
  // admin looking at a client's order sees that client's uploads rather than their own.
  if (userId) {
    const userObjectId = toObjectId(userId);
    if (!userObjectId) return [];
    query.userId = userObjectId;
  }

  const requests = await updateRequestModel
    .find(query)
    .select("_id userId updatePlanId status deliveryStatus createdAt instructions files")
    .sort({ createdAt: -1 })
    .lean();

  const now = new Date();

  return requests.map((request) => {
    const files = (request.files || []).map((file) => {
      const isExpired = isFileExpired(file, now);
      return {
        id: String(file._id || ""),
        name: file.originalName || file.filename || "",
        type: file.type || "",
        size: file.size || 0,
        driveFileId: file.driveFileId || "",
        viewLink: file.driveLink || file.embedLink || "",
        downloadLink: isExpired ? "" : buildDownloadLink(file),
        expiresAt: file.expirationDate || null,
        isExpired,
      };
    });

    return {
      id: String(request._id),
      orderId: String(request.updatePlanId || ""),
      status: request.status,
      deliveryStatus: request.deliveryStatus || 'ready',
      createdAt: request.createdAt,
      notes: (request.instructions || []).map((note) => ({
        text: note?.text || "",
        timestamp: note?.timestamp || null,
      })),
      files,
      // Same test the zip route runs, so a listing never offers a download that would
      // produce an empty archive.
      hasDownloadableFiles: getDownloadableFiles(request.files, now).length > 0,
    };
  });
};

module.exports = {
  getOrderUploadHistory,
  resolveUploadOwnerIds,
  buildDownloadLink,
  getDownloadableFiles,
  isFileExpired,
};
