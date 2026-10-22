// One-time backfill: freeze projectSnapshot.categoryLabel on project orders created before the
// Project Categories SSOT (helpers/projectCategories.js). New projects store it at creation.
//
// DRY-RUN by default — prints what would change and writes nothing.
//   node scripts/backfillProjectCategoryLabels.js           (dry run)
//   node scripts/backfillProjectCategoryLabels.js --apply   (writes; owner approval required)
//
// Only sets a label that is missing; never overwrites one and never touches updatedAt.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const orderModel = require("../models/orderProductModel");
const { listProjectCategories } = require("../helpers/projectCategories");

const apply = process.argv.includes("--apply");

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Database: ${mongoose.connection.db.databaseName} — ${apply ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`);

  const labels = Object.fromEntries((await listProjectCategories()).map((entry) => [entry.category, entry.label]));
  const filter = { "projectSnapshot.category": { $type: "string" }, "projectSnapshot.categoryLabel": { $exists: false } };
  const orders = await orderModel.find(filter).select("_id projectSnapshot.category").lean();

  const byCategory = {};
  const unknown = [];
  for (const order of orders) {
    const key = order.projectSnapshot.category;
    if (!labels[key]) { unknown.push(String(order._id)); continue; }
    byCategory[key] = (byCategory[key] || 0) + 1;
  }
  console.log(`Orders missing a category label: ${orders.length}`);
  for (const [key, count] of Object.entries(byCategory)) console.log(`  ${key} → "${labels[key]}": ${count}`);
  if (unknown.length) console.log(`  Unknown category (left unchanged): ${unknown.length}`);

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to write.");
  } else {
    let written = 0;
    for (const [key, label] of Object.entries(labels)) {
      if (!byCategory[key]) continue;
      // timestamps:false keeps updatedAt, which lists use for "latest first" ordering.
      const result = await orderModel.updateMany(
        { ...filter, "projectSnapshot.category": key },
        { $set: { "projectSnapshot.categoryLabel": label } },
        { timestamps: false },
      );
      written += result.modifiedCount;
    }
    console.log(`\nLabels written: ${written}`);
  }

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("Backfill failed:", error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
