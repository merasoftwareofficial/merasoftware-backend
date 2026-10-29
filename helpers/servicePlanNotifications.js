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

// --- Plan payment mails (plan.md 4.1). Unlike the steps above, these are customer-started mail:
// prepared inside the request that caused them (purchase or the admin's rejection) and sent when that
// request succeeds, only while the action is On. They must be awaited before the response, and a
// failure is logged, never thrown: the money has already moved.
async function prepareInRequest(event, ...args) {
  try { return await require('./emailService').prepareTemplatedMail(event, ...args); }
  catch (error) { console.error(`[plan mail] ${event} was not prepared:`, error.message); return null; }
}

// After a purchase: the admin always hears of it; the client is told a UPI part is being checked
// (a wallet-only purchase is already told "plan started" by serviceCycleSettlement.js).
async function preparePurchaseMails(orderId, payment) {
  const order = await withCustomer(orderId);
  if (!order) return;
  if (payment.upiPending > 0) await prepareInRequest('plan.payment.submitted', order, payment);
  await prepareInRequest('plan.purchase.admin', order, payment);
}

async function preparePaymentRejected(orderId, transaction, reason) {
  const order = await withCustomer(orderId);
  if (order?.isServicePlan) await prepareInRequest('plan.payment.rejected', order, transaction, reason);
}

module.exports = {
  preparePurchaseMails,
  preparePaymentRejected,
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
