const Request = require('../models/updateRequestModel');
const { sendUpdateRequestNotification, sendUploadDeliveryStuck, sendUserConfirmation } = require('./emailService');
const { createUpdateRequestNotification } = require('./notificationService');
const { measureUpload } = require('./uploadTiming');
const ADMIN_EMAILS = ['vacomputers.com@gmail.com', 'syncvap@gmail.com'];
const findRecord = requestId => Request.findById(requestId)
  .populate('userId', 'name email').populate({ path: 'updatePlanId', populate: { path: 'productId', select: 'serviceName validityPeriod updateCount' } });

async function notifyUpload(requestId, timing) {
  const record = await measureUpload(timing, 'notification_record_lookup', () => findRecord(requestId));
  if (!record) return;
  await measureUpload(timing, 'admin_email_prepare', () => sendUpdateRequestNotification(record, ADMIN_EMAILS));
  await measureUpload(timing, 'client_email_prepare', () => sendUserConfirmation(record));
  await measureUpload(timing, 'in_app_notifications', () => createUpdateRequestNotification(record));
}

// The worker has no one else to tell: without this a stuck upload waits unseen.
async function notifyDeliveryStuck(requestId) {
  const record = await findRecord(requestId);
  if (record) await sendUploadDeliveryStuck(record, ADMIN_EMAILS);
}
module.exports = { notifyUpload, notifyDeliveryStuck };
