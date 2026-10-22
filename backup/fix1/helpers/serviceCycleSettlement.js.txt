const orderModel = require("../models/orderProductModel");
const { getCycleDates, isFinalCycle } = require("./serviceBillingSchedule");
const { syncServiceBillingStatement } = require("./serviceBillingStatement");
const { markOrderApproved } = require("./orderLifecycle");

const settleServiceCycle = async ({ orderId, invoice, now = new Date() }) => {
  const service = await orderModel.findOne({ _id: orderId, isServicePlan: true });
  if (!service) throw new Error("Service order not found");
  if (invoice.status !== "paid") return service;

  const cycleNumber = Number(invoice.serviceCycleNumber || service.serviceCurrentCycleNumber || 1);
  const awaitingActivation = service.servicePlanStatus === "pending_activation";
  const cycle = getCycleDates(service, cycleNumber, now);
  const history = Array.isArray(service.serviceCycleHistory) ? service.serviceCycleHistory : [];
  const historyIndex = history.findIndex((entry) => Number(entry.cycleNumber) === cycleNumber);
  const entry = {
    cycleNumber,
    cycleStart: cycle.start,
    cycleEnd: cycle.end,
    accessUsed: Number(service.serviceAccessUsedInCycle || 0),
    invoiceId: invoice._id,
    amount: Number(invoice.amount || 0),
    paidAt: invoice.paidDate || now,
  };
  if (historyIndex >= 0) history[historyIndex] = { ...history[historyIndex].toObject?.(), ...entry };
  else history.push(entry);

  service.serviceCycleHistory = history;
  service.serviceCurrentCycleNumber = cycleNumber;
  service.serviceCompletedCycles = Math.max(Number(service.serviceCompletedCycles || 0), cycleNumber);
  service.serviceCurrentCycleStart = cycle.start;
  service.serviceCurrentCycleEnd = cycle.end;
  service.serviceAccessUsedInCycle = 0;
  // A paid final cycle remains active until its contracted end date. The scheduler
  // marks it expired when that date arrives; no extra invoice is created.
  service.servicePlanStatus = awaitingActivation ? "pending_activation" : "active";
  service.serviceNextBillingDate = awaitingActivation ? null : cycle.end;

  if (cycleNumber === 1) {
    service.paidAmount = Number(invoice.amountPaid || invoice.amount || 0);
    service.remainingAmount = 0;
    service.paymentComplete = true;
    // A cancelled service stays cancelled — settling its first cycle must never
    // resurrect it (see helpers/orderLifecycle.js).
    markOrderApproved(service);
  }

  await service.save();
  await syncServiceBillingStatement(service);
  return service;
};

module.exports = { settleServiceCycle };
