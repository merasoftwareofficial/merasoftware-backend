const mongoose = require('mongoose');
const Order = require('../models/orderProductModel');
const User = require('../models/userModel');
const { monthlyPlanShape } = require('./salesPackages');
const { buildServicePlanOrderData } = require('./servicePlanPurchase');
const { createProjectInvoice, markProjectInvoicePaid } = require('./paymentRecording');
const { createPaymentTransaction, deductWalletInstant } = require('./transactionService');
const { paymentDueDate } = require('./offerPaymentPolicy');

// A monthly package runs as a plan (src/docs/monthlypackage.md, owner decisions 11 Nov 2026): the order is a
// service-plan order built by the plan engine (servicePlanPurchase.js buildServicePlanOrderData), so the
// portal plan page, the upload allowance and its monthly reset, the renewal invoice every cycle, stop
// renewal and the admin Plans tab all work as they do for a plan. Nothing here prices anything: the
// price is the package quote (salesPackages.js quoteChoice → servicePlanPricing.js), frozen in
// `commercial` by projectPricing.js. Every renewal bills the frozen cycle price, so an offer bought with
// the package stays for the whole length bought; buying again later takes the price of that day.
//
// One unit, all saved or none: the order, its first-cycle invoice and the payment received now.
// After the commit the caller runs settleServiceCycle (servicePlanAdmin.js does the same) when the first
// bill is paid; a UPI part is settled when the admin approves it (transactionApprovalController.js).

const cents = value => Math.round(Number(value) * 100);
const packageIdOf = order => order?.projectSnapshot?.salesAgreement?.package?.id || order?.salesPackage?.package?.id || null;

// The order document, not saved. `commercial` is resolveProjectPricing's answer for a monthly package.
function buildPackagePlanOrderData({ userId, item, commercial, startDate = new Date() }) {
  const term = commercial.monthly;
  if (!term?.planQuote) throw Object.assign(new Error('Choose a billing cycle and length for this monthly package'), { statusCode: 400 });
  const plan = { ...monthlyPlanShape(item, term.unitPrice), orderItemId: `package:${item.id}` };
  const quote = term.planQuote;
  const billingSelection = { billingCycle: quote.purchase, cycleMonths: quote.cycleMonths, tenureMonths: quote.tenureMonths,
    totalCycles: quote.totalCycles, autoRenew: false, firstPayment: quote.cyclePrice };
  const data = buildServicePlanOrderData({ userId, plan, price: quote.cyclePrice, validityInDays: null, startDate, billingSelection, quote });
  // The agreement as projects keep it (projectPricing.js), without the engine's working copy of the quote.
  const { planQuote, ...frozenTerm } = term;
  const agreement = JSON.parse(JSON.stringify(commercial.agreement));
  if (agreement.package) agreement.package.monthly = { ...frozenTerm, startsAt: startDate, endsAt: data.servicePlanEndDate };
  data.salesPackage = agreement;
  data.paymentPolicy = commercial.paymentPolicy || null;
  data.servicePlanSnapshot.categoryKey = item.category;
  return data;
}

// `payment`: { kind: 'customer', upiReference, transactionId, preparedEvidence }   (wallet first, the rest by UPI)
//          | { kind: 'admin', recordPayment, preparedEvidence }   (money already received, with evidence)
//          | null                                                (the client pays the bill later)
// `beforeCreate({ client, session })` runs inside the transaction before anything is written.
async function persistPackagePlanOrder({ orderData, actorId, clientPurchase = false, sourceOffer = null, sourceReservationId = null, payment = null, beforeCreate = null }) {
  const orderId = new mongoose.Types.ObjectId();
  return mongoose.connection.transaction(async session => {
    const actor = await User.findById(actorId).session(session);
    if (clientPurchase) {
      if (!actor || String(actor._id) !== String(orderData.userId) || actor.isActive === false || actor.deletedAt) throw Object.assign(new Error('Current account access required'), { statusCode: 403 });
    } else if (!actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) throw Object.assign(new Error('Current portal admin access required'), { statusCode: 403 });
    const client = await User.findById(orderData.userId).session(session);
    if (!client || client.isActive === false || client.deletedAt || client.isGuest) throw Object.assign(new Error('Client is unavailable'), { statusCode: 400 });
    // The same request sent again (a retry after a slow answer) gets its order back, never a second one.
    if (orderData.projectCreationKey) {
      const existing = await Order.findOne({ projectCreationKey: orderData.projectCreationKey }).session(session);
      if (existing) {
        if (existing.projectCreationHash !== orderData.projectCreationHash || !existing.projectCreationComplete) throw Object.assign(new Error('Request changed or is incomplete'), { statusCode: 409 });
        return { order: existing, reused: true };
      }
    }
    if (beforeCreate) await beforeCreate({ client, session });
    const order = new Order({ ...orderData, _id: orderId, projectCreationComplete: true });
    await require('./offerReservations').attachProjectReservation({ order, offer: sourceOffer, reservationId: sourceReservationId, session });
    await require('./packageStart').closeOnProject({ order, session });
    await order.save({ session });

    const invoiceDate = new Date();
    const due = cents(order.totalAmount);
    // The first bill as a plan's (customerCreateServicePlanOrder.js); renewals add "Cycle n" bills (servicePlanRenewalCron.js).
    let invoice = await createProjectInvoice({ customerId: order.userId, orderId: order._id, amount: due / 100,
      lineItems: [{ name: order.orderItems[0].name, price: due / 100 }], serviceCycleNumber: 1, invoiceDate,
      dueDate: order.paymentPolicy ? paymentDueDate(order.paymentPolicy, invoiceDate) : invoiceDate, session });

    let walletPaid = 0, upiPending = 0;
    if (payment?.kind === 'customer') {
      // The wallet is read here, where the split is final: wallet first (instant), the rest by UPI (admin approves).
      const wallet = await User.findById(order.userId).select('walletBalance').session(session);
      const walletPart = Math.min(cents(wallet?.walletBalance || 0), due), upiPart = due - walletPart;
      if (upiPart > 0 && !payment.preparedEvidence) throw Object.assign(new Error('Your wallet balance changed. Try again.'), { statusCode: 409 });
      if (walletPart > 0) {
        const { transaction } = await deductWalletInstant({ userId: order.userId, transactionId: `${payment.transactionId}-W`, amount: walletPart / 100,
          orderId: order._id, sourceType: 'invoice', description: `Payment (wallet) for ${order.orderItems[0].name}`, parentTransactionId: upiPart > 0 ? payment.transactionId : null, session });
        ({ invoice } = await markProjectInvoicePaid({ invoice, customerId: order.userId, paymentMethod: 'wallet', amount: walletPart / 100, existingTransaction: transaction, session }));
        walletPaid = walletPart / 100;
      }
      if (upiPart > 0) {
        await createPaymentTransaction({ userId: order.userId, transactionId: payment.transactionId, amount: upiPart / 100, upiTransactionId: payment.upiReference,
          paymentMethod: 'upi', orderId: order._id, invoiceId: invoice._id, description: `Payment (UPI) for ${order.orderItems[0].name}`,
          session, preparedEvidence: payment.preparedEvidence });
        upiPending = upiPart / 100;
      }
    } else if (payment?.kind === 'admin') {
      ({ invoice } = await markProjectInvoicePaid({ invoice, customerId: order.userId, actorId, amount: due / 100, session,
        paymentMethod: payment.recordPayment.paymentMethod, transactionReference: payment.recordPayment.transactionReference,
        paymentDetails: payment.recordPayment.paymentDetails || {}, preparedEvidence: payment.preparedEvidence }));
    }
    order.paidAmount = Number(invoice.amountPaid || 0);
    order.remainingAmount = Math.max(0, Number(order.totalAmount) - order.paidAmount);
    await order.save({ session });
    await require('./offerReservations').confirmReservationPayment({ order, invoice, session });
    return { order, invoice, reused: false, walletPaid, upiPending, client };
  });
}

// After the commit: a paid first bill approves the order and starts cycle 1 (the plan rule).
async function startPaidPackagePlan({ order, invoice }) {
  if (invoice?.status !== 'paid') return order;
  return require('./serviceCycleSettlement').settleServiceCycle({ orderId: order._id, invoice });
}

module.exports = { buildPackagePlanOrderData, persistPackagePlanOrder, startPaidPackagePlan, packageIdOf };
