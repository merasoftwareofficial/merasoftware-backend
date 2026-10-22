// READ-ONLY audit script. Does not write/update/delete anything; prints counts only (no customer data).
// Purpose: Phase 0 of the Project Categories SSOT — how project category keys are used in live data
// before the hardcoded category lists are replaced.
// Run: node scripts/readOnlyAuditProjectCategories.js
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const CORE = ["standard_websites", "dynamic_websites", "cloud_software_development", "app_development"];
// Same set orderStatusEngine.js / frontend orderType.js use to recognise a project order.
const ENGINE = [...CORE, "web_applications", "mobile_apps"];

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName} (read-only audit)\n`);

  const orders = await db.collection("orders").aggregate([
    { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
    { $project: {
      flag: { $eq: ["$isWebsiteProject", true] },
      servicePlan: { $eq: ["$isServicePlan", true] },
      hasSnapshot: { $ne: [{ $ifNull: ["$projectSnapshot", null] }, null] },
      snapshotCategory: { $ifNull: ["$projectSnapshot.category", null] },
      productCategory: { $ifNull: [{ $arrayElemAt: ["$product.category", 0] }, null] },
      productMissing: { $and: [{ $ne: [{ $ifNull: ["$productId", null] }, null] }, { $eq: [{ $size: "$product" }, 0] }] },
      visibility: "$orderVisibility",
    } },
  ]).toArray();

  const count = (rows, key) => rows.reduce((map, row) => { const k = String(key(row)); map[k] = (map[k] || 0) + 1; return map; }, {});
  const lower = (value) => String(value || "").toLowerCase();
  const effective = (row) => row.snapshotCategory || row.productCategory || "";
  const isProjectItem = (row) => row.flag || ENGINE.includes(lower(row.snapshotCategory)) || ENGINE.includes(lower(row.productCategory));

  console.log(`Total orders: ${orders.length}`);
  console.log("\n1. Orders by projectSnapshot.category:", count(orders, (row) => row.snapshotCategory));
  console.log("\n2. Orders by catalogue product category (when no snapshot category):",
    count(orders.filter((row) => !row.snapshotCategory), (row) => row.productCategory));
  console.log("\n3. Snapshot present but isWebsiteProject is not true (plan assumes 0):",
    orders.filter((row) => row.hasSnapshot && !row.flag).length);
  console.log("   Snapshot category present but isWebsiteProject is not true:",
    orders.filter((row) => row.snapshotCategory && !row.flag).length);
  console.log("\n4. isWebsiteProject true but no projectSnapshot (legacy, need label fallback):",
    orders.filter((row) => row.flag && !row.hasSnapshot).length);
  console.log("   ...of those, catalogue product missing:", orders.filter((row) => row.flag && !row.hasSnapshot && row.productMissing).length);

  // AppContent/OrderPage/WalletDetails use only the 4 core keys; isProjectItem() also accepts the
  // flag and legacy keys. Any order counted here would start appearing in those "active project" lists.
  const wouldChange = orders.filter((row) => isProjectItem(row) && !CORE.includes(lower(effective(row))));
  console.log("\n5. isProjectItem() true but category outside the 4 core keys:", wouldChange.length,
    count(wouldChange, (row) => `${effective(row) || "(none)"} | ${row.visibility}`));
  console.log("   Service-plan orders counted as projects by isProjectItem():",
    orders.filter((row) => row.servicePlan && isProjectItem(row)).length);

  const products = await db.collection("products").aggregate([
    { $group: { _id: "$category", total: { $sum: 1 }, hidden: { $sum: { $cond: [{ $eq: ["$isHidden", true] }, 1, 0] } } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  console.log("\n6. Catalogue products by category:", products.map((row) => `${row._id}: ${row.total} (hidden ${row.hidden})`));

  const compatible = await db.collection("products").aggregate([
    { $match: { category: "feature_upgrades" } },
    { $project: { values: { $cond: [{ $gt: [{ $size: { $ifNull: ["$compatibleWith", []] } }, 0] }, "$compatibleWith", ["(all categories)"]] } } },
    { $unwind: "$values" }, { $group: { _id: "$values", features: { $sum: 1 } } }, { $sort: { _id: 1 } },
  ]).toArray();
  console.log("\n7. Feature compatibleWith values:", compatible.map((row) => `${row._id}: ${row.features}`));

  const categories = await db.collection("categorybaseprices").find({}).toArray();
  console.log("\n8. Category base price records:");
  for (const key of CORE) {
    const row = categories.find((entry) => entry.category === key);
    console.log(`   ${key}: ${row ? `basePrice=${row.basePrice} description=${row.description ? "yes" : "no"} startingNode=${row.startingNodeTitle ? "yes" : "no"}` : "NOT SAVED (shown as ₹0)"}`);
  }
  const extra = categories.filter((entry) => !CORE.includes(entry.category)).map((entry) => entry.category);
  if (extra.length) console.log("   Unexpected records:", extra);

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("Audit failed:", error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
