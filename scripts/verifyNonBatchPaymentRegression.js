/**
 * REGRESSION CHECK for the payment-batch refactor: proves the flows that were NOT meant to
 * change still behave identically — single-service purchase (wallet / UPI / combined) and
 * its approve + reject paths, including the combined-payment wallet refund.
 *
 * These paths never involved a batch, so nothing here should be affected. Runs the real
 * controllers against the live DB, then deletes everything it created.
 *
 * Usage: node scripts/verifyNonBatchPaymentRegression.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const userModel = require("../models/userModel");
const productModel = require("../models/productModel");
const orderModel = require("../models/orderProductModel");
const invoiceModel = require("../models/invoiceModel");
const transactionModel = require("../models/transactionModel");

const singleController = require("../controller/order/customerCreateServicePlanOrder");
const { approveTransaction, rejectTransaction } = require("../controller/user/transactionApprovalController");

const results = [];
const check = (name, passed, detail = "") => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const mockRes = () => {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

const createdOrderIds = [];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const plan = await productModel
    .findOne({ category: "service_plan", isServicePlan: true, isHidden: { $ne: true } })
    .lean();

  if (!plan) {
    console.log("SKIPPED — no service plan available in the catalogue.");
    await mongoose.disconnect();
    return;
  }

  const billingOptions = plan.servicePlan?.billingOptions || [];
  const selection = billingOptions.length
    ? { selectedBillingCycle: billingOptions[0].billingCycle, tenureMonths: 12 }
    : {};

  const user = await userModel.create({
    name: "ZZ NonBatch Regression Test",
    email: `zz-nonbatch-test-${Date.now()}@example.invalid`,
    password: "x",
    roles: ["customer"],
    walletBalance: 0,
  });
  const userId = String(user._id);

  const buySingle = async ({ txnId, upiTxnId }) => {
    const res = mockRes();
    await singleController(
      {
        userId,
        userRole: "customer", // the purchase API sells only to the customer role
        body: {
          planId: String(plan._id),
          paymentDetails: { transactionId: txnId, upiTransactionId: upiTxnId },
          ...selection,
        },
      },
      res
    );
    const orderId = res.body?.data?.orderId || res.body?.data?.order?._id;
    if (orderId) createdOrderIds.push(String(orderId));
    return res;
  };

  console.log(`\nFixture: user=${userId}, plan=${plan.serviceName}\n`);

  // =====================================================================
  // CASE 1 — single service, pure UPI -> approve
  // =====================================================================
  console.log("--- CASE 1: single service UPI -> approve ---");
  const txn1 = `ZZSNG${Date.now()}A`;
  const buy1 = await buySingle({ txnId: txn1, upiTxnId: "444444444444" });
  check("single purchase created", buy1.statusCode === 201, buy1.body?.message);

  if (buy1.statusCode !== 201) {
    await userModel.deleteOne({ _id: user._id });
    await mongoose.disconnect();
    process.exit(1);
  }

  const txn1Doc = await transactionModel.findOne({ transactionId: txn1 }).lean();
  check("payment IS a transaction (not a batch)", Boolean(txn1Doc));
  check("transaction carries its orderId", Boolean(txn1Doc?.orderId), String(txn1Doc?.orderId));

  const approve1 = mockRes();
  await approveTransaction({ userRole: "admin", userId, params: { transactionId: txn1 } }, approve1);
  check("single payment approved", approve1.statusCode === 200, approve1.body?.message);

  const order1 = await orderModel.findById(txn1Doc.orderId).lean();
  check("service order approved", order1?.orderVisibility === "approved", order1?.orderVisibility);

  const cycleInv1 = await invoiceModel
    .find({ orderId: txn1Doc.orderId, invoiceType: { $ne: "service_statement" } })
    .lean();
  check("cycle invoice paid", cycleInv1.length > 0 && cycleInv1.every((i) => i.status === "paid"), cycleInv1.map((i) => i.status).join(","));

  // =====================================================================
  // CASE 2 — single service, pure UPI -> reject
  // =====================================================================
  console.log("\n--- CASE 2: single service UPI -> reject ---");
  const txn2 = `ZZSNG${Date.now()}B`;
  const buy2 = await buySingle({ txnId: txn2, upiTxnId: "555555555555" });
  check("second single purchase created", buy2.statusCode === 201);

  const reject2 = mockRes();
  await rejectTransaction(
    { userRole: "admin", userId, params: { transactionId: txn2 }, body: { rejectionReason: "regression test" } },
    reject2
  );
  check("single payment rejected", reject2.statusCode === 200, reject2.body?.message);

  const txn2Doc = await transactionModel.findOne({ transactionId: txn2 }).lean();
  const order2 = await orderModel.findById(txn2Doc.orderId).lean();
  check("rejected order marked payment-rejected", order2?.orderVisibility === "payment-rejected", order2?.orderVisibility);

  // =====================================================================
  // CASE 3 — single service, COMBINED (wallet+UPI) -> reject refunds wallet
  // =====================================================================
  console.log("\n--- CASE 3: single service combined -> reject refunds wallet ---");
  const price = Number(plan.sellingPrice || plan.price || 0);
  const walletSeed = Math.max(1, Math.floor(price / 2));
  await userModel.findByIdAndUpdate(user._id, { walletBalance: walletSeed });

  const txn3 = `ZZSNG${Date.now()}C`;
  const buy3 = await buySingle({ txnId: txn3, upiTxnId: "666666666666" });
  check("combined single purchase created", buy3.statusCode === 201, `walletPaid=${buy3.body?.data?.walletPaid}`);

  const balAfterBuy = (await userModel.findById(user._id).select("walletBalance").lean())?.walletBalance;
  check("wallet debited at purchase", Number(balAfterBuy) === 0, `balance=${balAfterBuy}`);

  const txn3Doc = await transactionModel.findOne({ transactionId: txn3 }).lean();

  const reject3 = mockRes();
  await rejectTransaction(
    { userRole: "admin", userId, params: { transactionId: txn3 }, body: { rejectionReason: "regression combined" } },
    reject3
  );
  check("combined single payment rejected", reject3.statusCode === 200);

  const balAfterReject = (await userModel.findById(user._id).select("walletBalance").lean())?.walletBalance;
  check("wallet portion refunded", Number(balAfterReject) === walletSeed, `balance=${balAfterReject}, expected=${walletSeed}`);

  const order3 = await orderModel.findById(txn3Doc.orderId).lean();
  const invoices3 = await invoiceModel.find({ orderId: txn3Doc.orderId, invoiceType: { $ne: "service_statement" } }).lean();
  check("rejected combined order has no paid balance", Number(order3?.paidAmount || 0) === 0 && Number(order3?.remainingAmount || 0) === price, `paid=${order3?.paidAmount}, remaining=${order3?.remainingAmount}`);
  check("rejected combined order is payment-rejected", order3?.orderVisibility === "payment-rejected", order3?.orderVisibility);
  check("rejected combined invoice is unpaid", invoices3.length > 0 && invoices3.every((invoice) => Number(invoice.amountPaid || 0) === 0 && invoice.status === "unpaid"), invoices3.map((invoice) => `${invoice.status}:${invoice.amountPaid}`).join(","));

  const retryReject3 = mockRes();
  await rejectTransaction(
    { userRole: "admin", userId, params: { transactionId: txn3 }, body: { rejectionReason: "retry regression combined" } },
    retryReject3
  );
  const balanceAfterRetry = (await userModel.findById(user._id).select("walletBalance").lean())?.walletBalance;
  check("repeat reject cannot double-refund", retryReject3.statusCode === 400 && Number(balanceAfterRetry) === walletSeed, `response=${retryReject3.statusCode}, balance=${balanceAfterRetry}`);

  // =====================================================================
  // Teardown
  // =====================================================================
  const allOrderIds = [...new Set(createdOrderIds)];
  await invoiceModel.deleteMany({ orderId: { $in: allOrderIds } });
  await orderModel.deleteMany({ _id: { $in: allOrderIds } });
  await transactionModel.deleteMany({ userId: user._id });
  await userModel.deleteOne({ _id: user._id });
  check("teardown removed all test data", (await orderModel.countDocuments({ _id: { $in: allOrderIds } })) === 0);

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("FAILED:");
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
  }
  console.log("=".repeat(72));

  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
  console.error("\nRegression check crashed:", error);
  try { await mongoose.disconnect(); } catch (e) {}
  process.exit(1);
});
