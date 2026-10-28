// SSOT for telling the client about each step of a service plan (merasoftware/src/docs/plan.md §4
// "Plan communication"): plan started, payment received, upload in progress / done / rejected.
// The client's upload itself is already mailed by submitUpdateRequest.js.
//
// Every message is system mail (emailCatalog.js SYSTEM_TRIGGERED) sent through
// emailController.sendSystemMail(): the action's On/Off policy applies, WhatsApp mirrors it, and a
// dedupe key makes each message once-only even if two paths reach the same step.
//
// Sending never blocks or fails the business action: it runs after it, and a failed send is
// logged and waits in Email Control like any other mail.
const orderModel = require('../models/orderProductModel');

async function sendPlanMail(event, dedupeKey, ...args) {
  const mail = require('./emailTemplates').buildTemplatedMail(event, ...args);
  if (!mail) return 'no-recipient';
  return require('./emailController').sendSystemMail(event, mail, dedupeKey, '/service-plans');
}

// Runs a notification after the current work, never throwing into it.
function later(label, task) {
  setImmediate(() => {
    Promise.resolve().then(task).catch((error) => console.error(`[plan mail] ${label} was not sent:`, error.message));
  });
}

const withCustomer = (orderId) => orderModel.findById(orderId).populate('userId', 'name email').lean();

// "Plan started" once per order, when the plan is first active. The claim on
// serviceStartNotifiedAt makes it once-only across purchase, approval, admin start and activation.
async function claimStart(orderId) {
  const claimed = await orderModel.updateOne({ _id: orderId, serviceStartNotifiedAt: null, servicePlanStatus: 'active' }, { $set: { serviceStartNotifiedAt: new Date() } });
  return claimed.modifiedCount === 1;
}

async function planStarted(orderId, invoice = null) {
  if (!await claimStart(orderId)) return 'already';
  const order = await withCustomer(orderId);
  return sendPlanMail('plan.started', `plan-started:${orderId}`, order, invoice);
}

// A paid invoice settled a cycle (serviceCycleSettlement.js). The first time the plan is active
// this is "plan started" (which states the payment); otherwise "payment received".
async function cyclePaid(orderId, invoice) {
  if (await claimStart(orderId)) {
    const order = await withCustomer(orderId);
    return sendPlanMail('plan.started', `plan-started:${orderId}`, order, invoice);
  }
  const order = await withCustomer(orderId);
  return sendPlanMail('plan.payment.received', `plan-payment:${invoice._id}`, order, invoice);
}

const UPLOAD_EVENTS = { in_progress: 'plan.upload.in_progress', completed: 'plan.upload.completed', rejected: 'plan.upload.rejected' };

// One message per status change; `step` is the change's position in the upload's statusHistory.
async function uploadStatus(requestId, status, note, step) {
  const event = UPLOAD_EVENTS[status];
  if (!event) return 'ignored';
  const request = await require('../models/updateRequestModel').findById(requestId).populate('userId', 'name email').lean();
  if (!request) return 'missing';
  const order = await orderModel.findById(request.updatePlanId).lean();
  if (!order?.isServicePlan) return 'not-a-plan';
  return sendPlanMail(event, `plan-upload:${requestId}:${step}`, request, order, note);
}

// One message per work update our team posts on a plan without uploads.
async function workUpdate(orderId, entryId) {
  const order = await withCustomer(orderId);
  const entry = (order?.serviceWorkUpdates || []).find((item) => String(item._id) === String(entryId));
  if (!entry) return 'missing';
  return sendPlanMail('plan.work_update', `plan-work-update:${orderId}:${entryId}`, order, entry);
}

module.exports = {
  notifyPlanStarted: (orderId, invoice) => later('plan started', () => planStarted(orderId, invoice)),
  notifyCyclePaid: (orderId, invoice) => later('plan payment', () => cyclePaid(orderId, invoice)),
  notifyUploadStatus: (requestId, status, note, step) => later(`upload ${status}`, () => uploadStatus(requestId, status, note, step)),
  notifyWorkUpdate: (orderId, entryId) => later('work update', () => workUpdate(orderId, entryId)),
  // Awaitable forms for tests.
  planStarted,
  cyclePaid,
  uploadStatus,
  workUpdate,
};
