const Request = require('../models/updateRequestModel');
const { sendUpdateRequestNotification, sendUploadDeliveryStuck, sendUserConfirmation } = require('./emailService');
const { createUpdateRequestNotification } = require('./notificationService');
const { measureUpload } = require('./uploadTiming');
// The admins' saved settings decide the real recipients (helpers/teamContacts.js); this is the fallback the builder needs.
const { TEAM_FALLBACK_EMAILS: ADMIN_EMAILS } = require('./teamContacts');
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
