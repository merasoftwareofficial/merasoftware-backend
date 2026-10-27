// SSOT for the status of one client upload (merasoftware/src/docs/plan.md §4 "Plan communication"):
//   pending -> in_progress -> completed
//   pending | in_progress -> rejected  (the reason is required; a plan upload gives its update back)
// Done and rejected are final. Every change is kept in statusHistory with the note the client sees,
// and the client is told (helpers/servicePlanNotifications.js).
//
// In progress is also set automatically the first time our team downloads the upload
// (downloadUploadRequestZip.js), because that is when work starts.
const mongoose = require('mongoose');
const UpdateRequest = require('../models/updateRequestModel');
const Order = require('../models/orderProductModel');

const FROM = { in_progress: ['pending'], completed: ['pending', 'in_progress'], rejected: ['pending', 'in_progress'] };
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

async function setUploadStatus({ requestId, status, note = '', actorId = null, auto = false }) {
  if (!FROM[status]) fail('Choose In progress, Done or Rejected');
  if (typeof note !== 'string' || note.trim().length > 2000) fail('The note can be at most 2000 characters');
  const cleanNote = note.trim();
  if (status === 'rejected' && !cleanNote) fail('Write the reason, so the client knows what to send again');

  let result;
  await mongoose.connection.transaction(async (session) => {
    const request = await UpdateRequest.findById(requestId).session(session);
    if (!request) fail('Upload not found', 404);
    // Plan uploads only (owner, 28 Oct 2026); project uploads keep no status.
    const order = await Order.findById(request.updatePlanId).select('isServicePlan serviceCurrentCycleStart serviceAccessUsedInCycle').session(session);
    if (!order?.isServicePlan) fail('Status is kept for plan uploads only', 422);
    if (!FROM[status].includes(request.status || 'pending')) {
      fail(auto ? 'already-moved' : `This upload is already ${String(request.status).replace('_', ' ')}`, 409);
    }
    const now = new Date();
    request.status = status;
    if (status === 'completed') request.completedAt = now;
    request.statusHistory.push({ status, note: cleanNote, by: actorId, auto, at: now });

    // A rejected plan upload did not do its job, so it gives its update back — only for the
    // cycle it was counted in (a later cycle's counter was already reset), and only once.
    let allowanceReturned = false;
    if (status === 'rejected' && !request.allowanceReturnedAt) {
      const sameCycle = !order.serviceCurrentCycleStart || request.createdAt >= order.serviceCurrentCycleStart;
      if (sameCycle && Number(order.serviceAccessUsedInCycle || 0) > 0) {
        await Order.updateOne(
          { _id: order._id, serviceAccessUsedInCycle: { $gt: 0 } },
          { $inc: { serviceAccessUsedInCycle: -1, serviceAccessUsedTotal: -1 } },
          { session },
        );
        request.allowanceReturnedAt = now;
        allowanceReturned = true;
      }
    }
    await request.save({ session });
    result = { requestId: String(request._id), status, note: cleanNote, step: request.statusHistory.length, allowanceReturned };
  });
  require('./servicePlanNotifications').notifyUploadStatus(result.requestId, status, result.note, result.step);
  return result;
}

// Our team downloaded the upload: work has started. Quiet when it already moved on or is not a
// plan upload.
async function markInProgressOnDownload(requestId, actorId) {
  try {
    return await setUploadStatus({ requestId, status: 'in_progress', actorId, auto: true });
  } catch (error) {
    if (error.statusCode === 409 || error.statusCode === 422) return null;
    throw error;
  }
}

module.exports = { setUploadStatus, markInProgressOnDownload };
