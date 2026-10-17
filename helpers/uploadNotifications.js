const Request = require('../models/updateRequestModel');
const { sendUpdateRequestNotification, sendUserConfirmation } = require('./emailService');
const { createUpdateRequestNotification } = require('./notificationService');
const { measureUpload } = require('./uploadTiming');

async function notifyUpload(requestId, timing) {
  const record = await measureUpload(timing, 'notification_record_lookup', () => Request.findById(requestId)
    .populate('userId', 'name email').populate({ path: 'updatePlanId', populate: { path: 'productId', select: 'serviceName validityPeriod updateCount' } }));
  if (!record) return;
  await measureUpload(timing, 'admin_email_prepare', () => sendUpdateRequestNotification(record, ['vacomputers.com@gmail.com', 'syncvap@gmail.com']));
  await measureUpload(timing, 'client_email_prepare', () => sendUserConfirmation(record));
  await measureUpload(timing, 'in_app_notifications', () => createUpdateRequestNotification(record));
}
module.exports = { notifyUpload };
