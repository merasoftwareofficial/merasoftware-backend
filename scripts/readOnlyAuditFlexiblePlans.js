// READ-ONLY audit for the Flexible Plans work (merasoftware/src/docs/plan.md, phase P0).
// Does not write/update/delete anything, and does not call Google Drive, email or WhatsApp.
//
// Answers, from live data instead of code theory:
//   1. Which service plans exist in the catalogue, and which settings would the new rules change
//      (multi-year billing options, fractional prices, "per month" plans billed for longer).
//   2. Which service-plan orders exist, and how many are affected by the known problems
//      (renewal price source, tenure > 12 months, quota label vs cycle length).
//   3. Which OLD (legacy update-plan) orders and records still exist, and what each one holds,
//      so old work can be kept viewable before the legacy code is removed.
//
// How an order is classified (by the order's own flags, never by default fields):
//   isServicePlan === true      -> service plan
//   isWebsiteProject === true   -> project
//   neither                     -> "other" = legacy candidate
// updatesUsed / currentMonthUpdatesUsed default to 0 on EVERY order (orderProductModel.js), so
// their presence proves nothing; the older readOnlyAuditLegacyPlanOrphans.js relies on them and
// therefore counts every project as legacy.
//
// Safety: every MongoDB write command is blocked before it reaches the server, no models are
// loaded (so no index is ever created), and only raw collections are read.
//
// Run against production (PowerShell, from E:\Allprojects\backend):
//   $env:MONGODB_URI = "<production URI>"; node scripts/readOnlyAuditFlexiblePlans.js
//   Remove-Item Env:MONGODB_URI
// Share the block between "SUMMARY START" and "SUMMARY END". Add --detail to also list each
// legacy-candidate order.
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

const MULTI_YEAR = ["every_2_years", "every_3_years", "every_4_years", "every_5_years"];
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12, every_2_years: 24, every_3_years: 36, every_4_years: 48, every_5_years: 60 };
const isFractional = (value) => Number.isFinite(Number(value)) && Math.round(Number(value) * 100) % 100 !== 0;
const isLegacyProduct = (p) => Boolean(p.isWebsiteUpdate || p.isMonthlyLimitedPlan || p.isMonthlyRenewablePlan || p.category === "website_updates");
const tally = (rows, pick) => rows.reduce((acc, row) => { const key = String(pick(row) ?? "(none)"); acc[key] = (acc[key] || 0) + 1; return acc; }, {});
const orderKind = (o) => (o.isServicePlan === true ? "service" : o.isWebsiteProject === true ? "project" : "other");

/** Everything the audit reports, as plain data. No side effects. */
async function collectAudit(db) {
  const [products, orders, updateRequests, monthlyInvoices, invoices, transactions] = await Promise.all([
    db.collection("products").find({}).toArray(),
    db.collection("orders").find({}).toArray(),
    db.collection("updaterequests").find({}, { projection: { updatePlanId: 1, createdAt: 1, status: 1 } }).toArray(),
    db.collection("monthlyinvoices").find({}, { projection: { orderId: 1, amount: 1, status: 1 } }).toArray(),
    db.collection("invoices").find({}, { projection: { orderId: 1, amount: 1, invoiceType: 1, status: 1 } }).toArray(),
    db.collection("transactions").find({}, { projection: { orderId: 1, amount: 1, type: 1, status: 1 } }).toArray(),
  ]);

  const productById = new Map(products.map((p) => [String(p._id), p]));
  const orderById = new Map(orders.map((o) => [String(o._id), o]));
  const legacyProductIds = new Set(products.filter(isLegacyProduct).map((p) => String(p._id)));
  const byOrder = (rows, field) => rows.reduce((map, row) => {
    const key = row[field] ? String(row[field]) : null;
    if (key) map.set(key, [...(map.get(key) || []), row]);
    return map;
  }, new Map());
  const requestsByOrder = byOrder(updateRequests, "updatePlanId");
  const monthlyByOrder = byOrder(monthlyInvoices, "orderId");
  const invoicesByOrder = byOrder(invoices, "orderId");
  const txnsByOrder = byOrder(transactions, "orderId");
  const kindOfRef = (ref) => { const o = ref && orderById.get(String(ref)); return o ? orderKind(o) : "order missing"; };

  // 1. Catalogue
  const servicePlans = products.filter((p) => p.isServicePlan === true).map((p) => {
    const s = p.servicePlan || {};
    const options = s.billingOptions || [];
    return {
      id: String(p._id), name: p.serviceName, state: p.archivedAt ? "archived" : p.retiredAt ? "retired" : p.isHidden ? "hidden" : "on sale",
      planType: s.planType, capability: s.capability, purchaseType: s.purchaseType, limitScope: s.limitScope,
      attempts: s.portalAccessCount, files: s.filesLimit, monthlyReferencePrice: s.monthlyReferencePrice, price: p.sellingPrice ?? p.price,
      billingOptions: options.map((o) => `${o.billingCycle}:${o.discountPercent}%:${o.pricePerCycle}`),
      hasMultiYear: options.some((o) => MULTI_YEAR.includes(o.billingCycle)) || MULTI_YEAR.includes(s.billingCycle),
      hasFractionalPrice: options.some((o) => isFractional(o.pricePerCycle)) || isFractional(p.sellingPrice ?? p.price),
      perMonthButLongerCycle: s.limitScope === "per_month" && options.some((o) => (CYCLE_MONTHS[o.billingCycle] || 0) > 1),
    };
  });

  // 2. Service-plan orders
  const services = orders.filter((o) => orderKind(o) === "service");
  const serviceRows = services.map((o) => {
    const snap = o.servicePlanSnapshot || {};
    const optionPrice = (snap.billingOptions || []).find((b) => b.billingCycle === o.serviceSelectedBillingCycle)?.pricePerCycle;
    return {
      id: String(o._id), plan: snap.serviceName || o.orderItems?.[0]?.name || "(no name)", status: o.servicePlanStatus, visibility: o.orderVisibility,
      cycle: o.serviceSelectedBillingCycle, cycleMonths: o.serviceBillingCycleMonths, tenure: o.serviceTenureMonths,
      cyclePrice: o.serviceCyclePrice, optionPrice, userId: String(o.userId),
      legacyOrigin: legacyProductIds.has(String(o.productId)) || (o.monthlyRenewalHistory || []).length > 0 || monthlyByOrder.has(String(o._id)),
      renewalPriceDiffers: optionPrice !== undefined && o.serviceCyclePrice !== undefined && Number(optionPrice) !== Number(o.serviceCyclePrice),
      perMonthButLongerCycle: snap.limitScope === "per_month" && Number(o.serviceBillingCycleMonths || 0) > 1,
      linkedToProject: Boolean(o.linkedProjectOrderId), offerTerms: Boolean(o.paymentPolicy),
    };
  });

  // 3. Legacy candidates ("other" orders) and legacy-origin service orders
  const others = orders.filter((o) => orderKind(o) === "other").map((o) => {
    const key = String(o._id);
    const product = o.productId ? productById.get(String(o.productId)) : null;
    const txns = txnsByOrder.get(key) || [];
    return {
      id: key, createdAt: o.createdAt, name: (o.orderItems || []).find((i) => i.type === "main")?.name || o.orderItems?.[0]?.name || o.projectSnapshot?.displayName || "(no name)",
      product: !o.productId ? "productId null" : !product ? "product deleted" : isLegacyProduct(product) ? "legacy plan product" : `category ${product.category}`,
      price: o.price, paidAmount: o.paidAmount, isActive: o.isActive, planStatus: o.planStatus, visibility: o.orderVisibility,
      updateRequests: (requestsByOrder.get(key) || []).length, monthlyInvoices: (monthlyByOrder.get(key) || []).length,
      invoices: (invoicesByOrder.get(key) || []).length, transactions: txns.length,
      completedAmount: txns.filter((t) => t.status === "completed").reduce((sum, t) => sum + Number(t.amount || 0), 0),
      renewalHistory: (o.monthlyRenewalHistory || []).length, hasServiceSnapshot: Boolean(o.servicePlanSnapshot),
    };
  });

  return {
    totals: { products: products.length, orders: orders.length, updateRequests: updateRequests.length, monthlyInvoices: monthlyInvoices.length, invoices: invoices.length, transactions: transactions.length },
    productsByCategory: tally(products, (p) => p.category),
    legacyProducts: products.filter(isLegacyProduct).map((p) => ({ id: String(p._id), name: p.serviceName, archived: Boolean(p.archivedAt), retired: Boolean(p.retiredAt) })),
    servicePlans,
    ordersByKind: tally(orders, orderKind),
    services: {
      total: serviceRows.length,
      customers: new Set(serviceRows.map((r) => r.userId)).size,
      byStatus: tally(serviceRows, (r) => r.status), byVisibility: tally(serviceRows, (r) => r.visibility),
      byCycle: tally(serviceRows, (r) => r.cycle), byPlan: tally(serviceRows, (r) => r.plan),
      tenureOver12: serviceRows.filter((r) => Number(r.tenure) > 12).length,
      missingCyclePrice: serviceRows.filter((r) => r.cyclePrice === undefined || r.cyclePrice === null).length,
      fractionalCyclePrice: serviceRows.filter((r) => isFractional(r.cyclePrice)).length,
      renewalPriceDiffers: serviceRows.filter((r) => r.renewalPriceDiffers).map((r) => r.id),
      perMonthButLongerCycle: serviceRows.filter((r) => r.perMonthButLongerCycle).map((r) => r.id),
      legacyOrigin: serviceRows.filter((r) => r.legacyOrigin).map((r) => r.id),
      linkedToProject: serviceRows.filter((r) => r.linkedToProject).length, offerTerms: serviceRows.filter((r) => r.offerTerms).length,
    },
    others,
    records: {
      updateRequestsByOrderKind: tally(updateRequests, (r) => kindOfRef(r.updatePlanId)),
      monthlyInvoicesByOrderKind: tally(monthlyInvoices, (r) => kindOfRef(r.orderId)),
      monthlyInvoicesByStatus: tally(monthlyInvoices, (r) => r.status),
      invoicesByType: tally(invoices, (r) => r.invoiceType),
      fractionalInvoices: tally(invoices.filter((r) => isFractional(r.amount)), (r) => r.invoiceType),
      transactionsByType: tally(transactions, (r) => r.type),
      renewalTransactionsByOrderKind: tally(transactions.filter((t) => t.type === "renewal"), (t) => kindOfRef(t.orderId)),
    },
  };
}

function printReport(report, { detail = false } = {}) {
  const line = (label, value) => console.log(`${label.padEnd(46)} ${typeof value === "object" ? JSON.stringify(value) : value}`);
  console.log("\n=== SUMMARY START (readOnlyAuditFlexiblePlans) ===");
  line("totals", report.totals);
  line("products by category", report.productsByCategory);
  line("legacy plan products (incl. archived)", report.legacyProducts.length);
  line("orders by kind", report.ordersByKind);
  console.log("\n-- catalogue service plans --");
  for (const p of report.servicePlans) {
    line(`  ${p.name} [${p.state}]`, { planType: p.planType, capability: p.capability, purchase: p.purchaseType, scope: p.limitScope, attempts: p.attempts, files: p.files, price: p.price, options: p.billingOptions, multiYear: p.hasMultiYear, fractional: p.hasFractionalPrice, perMonthLongerCycle: p.perMonthButLongerCycle });
  }
  console.log("\n-- service-plan orders --");
  const s = report.services;
  line("total / customers", `${s.total} / ${s.customers}`);
  line("by status", s.byStatus); line("by visibility", s.byVisibility); line("by billing cycle", s.byCycle); line("by plan", s.byPlan);
  line("tenure > 12 months", s.tenureOver12);
  line("missing serviceCyclePrice", s.missingCyclePrice);
  line("fractional serviceCyclePrice", s.fractionalCyclePrice);
  line("renewal price differs from order price", s.renewalPriceDiffers.length ? s.renewalPriceDiffers : 0);
  line("'per month' plan on a longer cycle", s.perMonthButLongerCycle.length ? s.perMonthButLongerCycle : 0);
  line("service orders of legacy origin", s.legacyOrigin.length ? s.legacyOrigin : 0);
  line("linked to a project / with offer terms", `${s.linkedToProject} / ${s.offerTerms}`);
  console.log("\n-- legacy candidates (neither project nor service) --");
  line("count", report.others.length);
  line("by product state", tally(report.others, (o) => o.product));
  line("with update requests / monthly bills / txns", `${report.others.filter((o) => o.updateRequests).length} / ${report.others.filter((o) => o.monthlyInvoices).length} / ${report.others.filter((o) => o.transactions).length}`);
  line("completed money on them (₹)", report.others.reduce((sum, o) => sum + o.completedAmount, 0));
  console.log("\n-- records --");
  for (const [key, value] of Object.entries(report.records)) line(key, value);
  console.log("=== SUMMARY END ===\n");
  if (detail && report.others.length) {
    console.log("--- legacy candidate detail ---");
    for (const o of report.others) console.log(JSON.stringify(o));
  }
}

async function main() {
  installWriteGuard();
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Database: ${mongoose.connection.name}`);
  printReport(await collectAudit(mongoose.connection.db), { detail: process.argv.includes("--detail") });
  await mongoose.disconnect();
  console.log("Audit complete — nothing was written.");
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => { console.error("Audit failed:", error.message); process.exit(1); });
}

module.exports = { collectAudit, installWriteGuard, printReport, orderKind };
