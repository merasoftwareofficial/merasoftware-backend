// READ-ONLY preview. Does not write/update/delete anything, and does not call Google Drive,
// Resend or WhatsApp.
//
// Answers one question before ENABLE_CRONS=true is set on Render: "on the first night, what
// will each cron do to the live data?" Production crons have been off since the new backend
// went live (~28 Sep 2026), so the first run catches up on everything that waited.
//
// Each section mirrors one job as it ships today. If a job's code changes,
// update its section here too:
//
//   00:00      helpers/fileCleanupScheduler.js   cleanupExpiredFiles()       Drive delete — PERMANENT
//   01:05 IST  cron/servicePlanRenewalCron.js    processServicePlanRenewals()
//   */15 min   cron/offerPaymentReminderCron.js  processOfferPaymentReminders()  emails — cannot be unsent
//   every 2 h  chess/chessCleanupCron.js         expireStaleEndRequests(12)
//   */5 min    index.js keep-alive               HEAD ping only, no data
//
// Safety: every MongoDB write command is blocked before it reaches the server (installWriteGuard),
// and index/collection auto-creation is off, so even a mistake here cannot change the database.
//
// Run against production (PowerShell, from E:\Allprojects\backend):
//   $env:MONGODB_URI = "<production URI>"; node scripts/readOnlyCronFirstRunPreview.js
//   Remove-Item Env:MONGODB_URI
// Optional: --at=2026-10-23T01:30:00+05:30   evaluate as of that moment (default: now)
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") }); // never overrides a URI set in the shell

const mongoose = require("mongoose");

const WRITE_METHODS = [
  "insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany",
  "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "bulkWrite",
  "createIndex", "createIndexes", "dropIndex", "dropIndexes", "drop", "rename",
];
function installWriteGuard() {
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  const proto = mongoose.mongo.Collection.prototype;
  for (const method of WRITE_METHODS) {
    proto[method] = function blocked() { throw new Error(`READ-ONLY: blocked ${method} on ${this.collectionName}`); };
  }
}

const DAY = 86400000;
const HOUR = 3600000;

/** Everything the first run would do, as plain data. No side effects. */
async function collectFirstRunPreview(now = new Date()) {
  const Order = require("../models/orderProductModel");
  const Invoice = require("../models/invoiceModel");
  const UpdateRequest = require("../models/updateRequestModel");
  const User = require("../models/userModel");
  require("../models/productModel"); // registers 'product' for populate
  const { EmailPolicy, EmailHistory, EmailDraft } = require("../models/emailControlModel");
  const ChessGame = require("../chess/chessGameModel");
  const { isFixedTenureService, isFinalCycle, getNextCycleNumber, resolveServiceRenewalPrice } = require("../helpers/serviceBillingSchedule");
  const { modeForCycle, paymentDueDate } = require("../helpers/offerPaymentPolicy");

  const users = new Map();
  const who = async (id) => {
    if (!id) return "—";
    const key = String(id);
    if (!users.has(key)) {
      const user = await User.findById(id).select("name email").lean();
      users.set(key, user ? `${user.name || "?"} <${user.email || "?"}>` : `deleted user ${key}`);
    }
    return users.get(key);
  };
  const serviceName = (order) => order.servicePlanSnapshot?.serviceName || order.orderItems?.[0]?.name || "Service";

  // 1. File cleanup — Drive delete is permanent.
  const fileCleanup = [];
  for (const request of await UpdateRequest.find({ "files.expirationDate": { $lt: now } }).lean()) {
    const expired = (request.files || []).filter((file) => file.expirationDate && new Date(file.expirationDate) < now);
    fileCleanup.push({
      requestId: String(request._id), customer: await who(request.userId),
      driveDeletes: expired.filter((file) => file.driveFileId).map((file) => ({ name: file.originalName, expired: file.expirationDate })),
      recordsRemovedWithoutDrive: expired.filter((file) => !file.driveFileId).length,
    });
  }

  // Legacy monthly renewal/overdue processing has been retired.
  // Keep empty report fields for consumers of earlier preview output.
  const overdueMonthly = [];
  const legacyRenewals = [];

  // 3. Service plan renewals.
  const serviceRenewals = [];
  for (const service of await Order.find({ isServicePlan: true, servicePlanStatus: "active", serviceNextBillingDate: { $lte: now } }).lean()) {
    const row = { orderId: String(service._id), customer: await who(service.userId), service: serviceName(service),
      nextBillingDate: service.serviceNextBillingDate, planEndDate: service.servicePlanEndDate || null, offer: Boolean(service.paymentPolicy) };
    if (service.paymentPolicy) {
      if (service.orderVisibility === "cancelled") row.outcome = "nothing (cancelled)";
      else if ((isFixedTenureService(service) && isFinalCycle(service, service.serviceCurrentCycleNumber)) || (service.servicePlanEndDate && new Date(service.servicePlanEndDate) <= now)) row.outcome = "expired";
      else if (!isFixedTenureService(service) && !service.serviceAutoRenew) row.outcome = "inactive";
      else {
        const next = Number(service.serviceCurrentCycleNumber || 1) + 1;
        const exists = await Invoice.exists({ paymentPolicyKey: `${service._id}:${next}` });
        const mode = modeForCycle(service, next);
        row.outcome = `cycle ${next} starts, status ${mode === "advance" ? "paused" : "active"}`;
        if (!exists) row.newInvoice = Number(service.serviceCyclePrice || 0);
      }
    } else if (isFixedTenureService(service) && isFinalCycle(service, service.serviceCurrentCycleNumber)) row.outcome = "expired";
    else if (!isFixedTenureService(service) && !service.serviceAutoRenew) row.outcome = "inactive";
    else if (await Invoice.exists({ orderId: service._id, invoiceType: "plan_renewal", status: { $in: ["unpaid", "partially_paid", "overdue"] } })) row.outcome = "paused (renewal bill already unpaid)";
    else {
      const amount = resolveServiceRenewalPrice(service);
      if (amount > 0) { row.outcome = `paused until cycle ${getNextCycleNumber(service)} is paid`; row.newInvoice = amount; }
      else row.outcome = "nothing (no renewal price)";
    }
    // Stopped although the customer's own ending is still ahead — the earlier-cycle risk.
    row.endsEarly = ["inactive", "expired"].includes(row.outcome) && Boolean(service.servicePlanEndDate) && new Date(service.servicePlanEndDate) > now;
    serviceRenewals.push(row);
  }

  // 4a. Offer installment bills that ensureOfferProjectInvoices() would create.
  const offerInvoicesCreated = [];
  for (const order of await Order.find({ isWebsiteProject: true, isPartialPayment: true, paymentPolicy: { $ne: null }, orderVisibility: { $nin: ["cancelled", "payment-rejected"] } }).lean()) {
    const target = (order.installments || []).find((item) => item.installmentNumber === order.currentInstallment && !item.paid);
    if (!target || (target.progressThreshold != null && Number(order.projectProgress || 0) < target.progressThreshold)) continue;
    if (await Invoice.exists({ orderId: order._id, invoiceType: "project", installmentNumber: target.installmentNumber })) continue;
    offerInvoicesCreated.push({ orderId: String(order._id), customer: await who(order.userId), installment: target.installmentNumber, amount: target.amount,
      dueDate: target.dueDate || paymentDueDate(order.paymentPolicy, order.paymentPolicy.appliedAt) });
  }

  // 4b. Offer payment reminder emails (Email Control can switch the action Off).
  const reminderPolicy = await EmailPolicy.findOne({ event: "offer.payment.reminder" }).lean();
  const remindersOff = reminderPolicy?.mode === "off";
  const offerReminders = [];
  const offerInvoicesOverdue = [];
  for (const invoice of await Invoice.find({ invoiceType: { $in: ["project", "plan_renewal"] }, status: { $in: ["unpaid", "partially_paid", "overdue"] } }).lean()) {
    const order = await Order.findById(invoice.orderId).lean();
    if (!order?.paymentPolicy || order.orderVisibility === "cancelled" || order.servicePlanStatus === "pending_activation") continue;
    if (order.isServicePlan && Number(invoice.serviceCycleNumber) > 1 && order.paymentPolicy.cycleScope !== "every_cycle") continue;
    if (invoice.installmentNumber && invoice.installmentNumber !== order.currentInstallment) continue;
    if (invoice.installmentNumber) {
      const installment = (order.installments || []).find((item) => item.installmentNumber === invoice.installmentNumber);
      if (installment?.progressThreshold != null && Number(order.projectProgress || 0) < installment.progressThreshold) continue;
    }
    if (new Date(invoice.dueDate) < now && invoice.status !== "overdue") offerInvoicesOverdue.push(invoice.invoiceNumber || String(invoice._id));
    const customer = await User.findById(order.userId).select("name email isActive deletedAt").lean();
    if (!customer?.email || customer.isActive === false || customer.deletedAt) continue;
    const due = (order.paymentPolicy.reminderOffsets || []).filter((offset) => new Date(invoice.dueDate).getTime() + offset * DAY <= now.getTime()).sort((a, b) => b - a);
    if (!due.length) continue;
    const dedupeKey = `offer-reminder:${invoice._id}:${due[0]}`;
    const already = await EmailHistory.exists({ dedupeKey }) || await EmailDraft.exists({ dedupeKey });
    offerReminders.push({ invoice: invoice.invoiceNumber || String(invoice._id), to: `${customer.name || "?"} <${customer.email}>`, dueDate: invoice.dueDate,
      offsetDays: due[0], willSend: !already && !remindersOff, reason: already ? "already sent" : remindersOff ? "Email Control has it Off" : "" });
  }

  // 5. Chess games stuck in an unanswered end request for 12 h are deleted.
  const chessDeleted = await ChessGame.countDocuments({ status: "end-pending", endRequestedAt: { $lte: new Date(now.getTime() - 12 * HOUR) } });

  return { now, fileCleanup, overdueMonthly, legacyRenewals, serviceRenewals, offerInvoicesCreated, offerInvoicesOverdue, offerReminders, remindersOff, chessDeleted };
}

function printReport(r) {
  const out = (s = "") => console.log(s);
  const date = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
  const head = (s) => { out(""); out("=".repeat(90)); out(s); out("=".repeat(90)); };
  const drive = r.fileCleanup.reduce((n, row) => n + row.driveDeletes.length, 0);
  const sends = r.offerReminders.filter((row) => row.willSend);

  head(`CRON FIRST-RUN PREVIEW (read-only) — as of ${r.now.toISOString()}`);
  out("Nothing below has happened. It is what the crons WOULD do on their first night.");
  out("No cron charges a wallet: renewals only create UNPAID bills and pause the plan.");

  head(`1. FILE CLEANUP (00:00) — ${drive} file(s) PERMANENTLY deleted from Google Drive`);
  for (const row of r.fileCleanup) {
    out(`  request ${row.requestId}  ${row.customer}`);
    for (const file of row.driveDeletes) out(`    - ${file.name}  (expired ${date(file.expired)})`);
    if (row.recordsRemovedWithoutDrive) out(`    + ${row.recordsRemovedWithoutDrive} expired record(s) without a Drive file removed from the list`);
  }

  head("2. LEGACY MONTHLY RENEWAL / OVERDUE JOB — retired; existing bills unchanged");

  head(`3. SERVICE PLAN RENEWALS (01:05 IST) — ${r.serviceRenewals.length} plan(s) due`);
  for (const row of r.serviceRenewals) {
    out(`  ${row.service}  [${row.offer ? "offer" : "normal"}]  order ${row.orderId}  ${row.customer}`);
    out(`    billing date ${date(row.nextBillingDate)}  ending ${date(row.planEndDate)}  → ${row.outcome}${row.newInvoice ? `  (new unpaid bill ₹${row.newInvoice})` : ""}`);
    if (row.endsEarly) out("    ⚠ STOPS BEFORE ITS OWN ENDING DATE — customer loses paid time");
  }

  head(`4. OFFER PAYMENT REMINDERS (every 15 min) — ${sends.length} email(s) would be sent${r.remindersOff ? " (action is OFF in Email Control)" : ""}`);
  for (const row of r.offerReminders) out(`  ${row.invoice}  due ${date(row.dueDate)}  day ${row.offsetDays >= 0 ? "+" : ""}${row.offsetDays}  ${row.to}  → ${row.willSend ? "SEND" : `skip (${row.reason})`}`);
  if (r.offerInvoicesCreated.length) {
    out(`  + ${r.offerInvoicesCreated.length} offer installment bill(s) created first:`);
    for (const row of r.offerInvoicesCreated) out(`    order ${row.orderId}  installment ${row.installment}  ₹${row.amount}  due ${date(row.dueDate)}  ${row.customer}`);
  }
  if (r.offerInvoicesOverdue.length) out(`  + ${r.offerInvoicesOverdue.length} offer bill(s) marked overdue: ${r.offerInvoicesOverdue.join(", ")}`);
  if (sends.length) out("  Each sent email is also queued for WhatsApp when ENABLE_WHATSAPP=true.");

  head(`5. CHESS CLEANUP (every 2 h) — ${r.chessDeleted} stuck game(s) deleted`);

  head("SUMMARY");
  out(`  Google Drive files deleted (permanent): ${drive}`);
  out(`  Customer emails sent (cannot be unsent): ${sends.length}`);
  out(`  Plans paused / inactive / expired:      ${r.overdueMonthly.filter((x) => x.planPaused).length + r.serviceRenewals.filter((x) => /paused|inactive|expired/.test(x.outcome)).length}`);
  out(`  Plans stopped before their ending:      ${r.serviceRenewals.filter((x) => x.endsEarly).length}`);
  out(`  New unpaid bills:                       ${r.legacyRenewals.length + r.serviceRenewals.filter((x) => x.newInvoice).length + r.offerInvoicesCreated.length}`);
  out("");
}

async function main() {
  const at = process.argv.find((arg) => arg.startsWith("--at="));
  const now = at ? new Date(at.slice(5)) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("--at is not a valid date");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  installWriteGuard();
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Database: ${mongoose.connection.name}  (read-only; writes are blocked)`);
  try { printReport(await collectFirstRunPreview(now)); }
  finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch((error) => { console.error("Preview failed:", error.message); process.exit(1); });
module.exports = { collectFirstRunPreview, installWriteGuard, printReport };
