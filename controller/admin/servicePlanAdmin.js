const mongoose = require('mongoose');
const User = require('../../models/userModel');
const Product = require('../../models/productModel');
const Order = require('../../models/orderProductModel');
const { isAdmin } = require('./planCategories');
const { resolvePurchase, buildServicePlanOrderData, resolveValidityInDays, runsIndefinitely } = require('../../helpers/servicePlanPurchase');
const { SURFACE, evaluateServiceSurface } = require('../../helpers/serviceDependencyRules');
const { ADMIN_PAYMENT_METHODS, preparePaymentEvidence } = require('../../helpers/paymentEvidence');
const { createProjectInvoice, markProjectInvoicePaid } = require('../../helpers/paymentRecording');
const { deductWalletInstant } = require('../../helpers/transactionService');
const { settleServiceCycle } = require('../../helpers/serviceCycleSettlement');
const { setUploadStatus } = require('../../helpers/uploadStatus');

// Admin actions on service plans (merasoftware/src/docs/plan.md §4, P5 backend):
//   start a plan for a client, change how its updates are released, set an upload's status.
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const handle = (label, fn) => async (req, res) => {
  try {
    if (!await isAdmin(req)) return res.status(403).json({ message: 'Forbidden', error: true, success: false });
    await fn(req, res);
  } catch (error) {
    if (!error.statusCode) console.error(`${label}:`, error);
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : label, error: true, success: false });
  }
};

// POST /api/admin/clients/:customerId/service-plans
// Body: planId, the customer's choices (purchase, tenureMonths, files, updates, releaseMode,
// quoteKey — same as the customer purchase), optional linkedProjectOrderId, and
// payment: { mode: 'record', paymentMethod, transactionReference, paymentDetails } (money already
// received, with evidence) or { mode: 'wallet' } (debited from the client's wallet now).
// Price is the quote's, never typed. The plan starts paid; the client is told (cycle settlement).
const startPlanForClient = handle('Failed to start the plan', async (req, res) => {
  const customer = await User.findById(req.params.customerId).select('_id isGuest walletBalance').lean().catch(() => null);
  if (!customer || customer.isGuest) fail('Customer not found', 404);
  const plan = await Product.findOne({ _id: req.body.planId, category: 'service_plan', isServicePlan: true, retiredAt: null, archivedAt: null }).catch(() => null);
  if (!plan) fail('This plan is not available', 404);

  const purchase = resolvePurchase(plan, req.body);
  const servicePlan = plan.servicePlan || {};
  const finalPrice = purchase ? purchase.quote.firstPayment : Number(plan.sellingPrice ?? plan.price);
  if (!(finalPrice > 0)) fail('This plan has no price');

  let linkedOrder = null;
  if (req.body.linkedProjectOrderId) {
    linkedOrder = await Order.findOne({ _id: req.body.linkedProjectOrderId, userId: customer._id, isWebsiteProject: true }).catch(() => null);
    if (!linkedOrder) fail('The project to add this plan to was not found for this client');
    if (linkedOrder.orderVisibility === 'cancelled') fail('This project has been cancelled — plans cannot be added to it');
  }
  const surfaceCheck = evaluateServiceSurface(servicePlan, linkedOrder ? SURFACE.PROJECT : SURFACE.STANDALONE);
  if (!surfaceCheck.allowed) fail(surfaceCheck.reason);
  const phase = linkedOrder ? (linkedOrder.projectProgress >= 100 || linkedOrder.currentPhase === 'completed' ? 'after_completion' : 'in_progress') : null;

  const validityInDays = resolveValidityInDays(servicePlan);
  if (!purchase?.billingSelection && !purchase?.oneTimeValidityDays && !runsIndefinitely(servicePlan) && !(validityInDays > 0)) fail('This plan has no valid duration configured');

  const payment = req.body.payment || {};
  if (!['record', 'wallet'].includes(payment.mode)) fail('Choose how the client paid: record a payment, or take it from the wallet');
  let preparedEvidence = null;
  if (payment.mode === 'record') {
    if (!ADMIN_PAYMENT_METHODS.includes(payment.paymentMethod) || payment.paymentMethod === 'wallet') fail('Choose UPI, bank transfer, cheque or cash');
    preparedEvidence = await preparePaymentEvidence({
      paymentMethod: payment.paymentMethod, reference: payment.transactionReference, details: payment.paymentDetails || {}, capturedVia: 'admin',
    });
  } else if (Number(customer.walletBalance || 0) < finalPrice) {
    fail('The client’s wallet does not have enough balance');
  }

  const orderData = buildServicePlanOrderData({
    userId: customer._id, plan, price: finalPrice, validityInDays,
    linkedProjectOrderId: linkedOrder?._id || null, addedDuringProjectPhase: phase, startDate: new Date(),
    billingSelection: purchase?.billingSelection || null, quote: purchase?.quote || null, oneTimeValidityDays: purchase?.oneTimeValidityDays || null,
  });

  // Order, invoice and payment are one unit: all saved, or none.
  let order;
  let invoice;
  await mongoose.connection.transaction(async (session) => {
    [order] = await Order.create([orderData], { session });
    const created = await createProjectInvoice({
      customerId: customer._id, orderId: order._id, amount: finalPrice,
      lineItems: [{ name: plan.serviceName, price: finalPrice }], serviceCycleNumber: 1, session,
    });
    let existingTransaction = null;
    if (payment.mode === 'wallet') {
      ({ transaction: existingTransaction } = await deductWalletInstant({
        userId: customer._id, transactionId: `PLANSTART${order._id}`, amount: finalPrice, orderId: order._id,
        sourceType: 'invoice', description: `Plan started by admin: ${plan.serviceName}`, session,
      }));
    }
    ({ invoice } = await markProjectInvoicePaid({
      invoice: created, customerId: customer._id, actorId: req.userId, amount: finalPrice, session,
      paymentMethod: payment.mode === 'wallet' ? 'wallet' : payment.paymentMethod,
      transactionReference: payment.transactionReference, paymentDetails: payment.paymentDetails || {},
      preparedEvidence, existingTransaction,
    }));
  });
  // Paid first cycle: approves the order, starts the cycle and tells the client.
  const settled = await settleServiceCycle({ orderId: order._id, invoice });
  res.status(201).json({ message: 'Plan started for the client', success: true, error: false, data: { orderId: settled._id, invoiceId: invoice._id, finalPrice } });
});

// PATCH /api/admin/service-plans/:orderId/release-mode  { releaseMode: 'all_at_once' | 'monthly' }
// Monthly release needs a plan bought per month for longer than one month.
const setReleaseMode = handle('Failed to change the release mode', async (req, res) => {
  const { releaseMode } = req.body || {};
  if (!['all_at_once', 'monthly'].includes(releaseMode)) fail('Choose all at once or monthly');
  const order = await Order.findOne({ _id: req.params.orderId, isServicePlan: true }).catch(() => null);
  if (!order) fail('Plan order not found', 404);
  const snapshot = order.servicePlanSnapshot || {};
  if (releaseMode === 'monthly' && !(Number(snapshot.updatesPerMonth) > 0 && Number(order.serviceBillingCycleMonths) > 1)) {
    fail('Monthly release needs a plan with updates per month and a billing period longer than one month');
  }
  order.set('servicePlanSnapshot.releaseMode', releaseMode);
  await order.save();
  res.json({ message: 'Release mode saved', success: true, error: false, data: { orderId: order._id, releaseMode, allowance: require('../../helpers/serviceAllowance').uploadAllowanceNow(order) } });
});

// POST /api/admin/uploads/:requestId/status  { status: 'in_progress' | 'completed' | 'rejected', note }
const setUploadStatusController = handle('Failed to change the upload status', async (req, res) => {
  const data = await setUploadStatus({ requestId: req.params.requestId, status: req.body?.status, note: req.body?.note || '', actorId: req.userId });
  res.json({ message: 'Upload status saved', success: true, error: false, data });
});

module.exports = { startPlanForClient, setReleaseMode, setUploadStatusController };
