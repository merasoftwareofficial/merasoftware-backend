// One-time backfill: show every package saved before website package pages existed on the
// default "One-Time Packages" page (website lib/package-pages.ts, slug one-time-packages).
//
// DRY-RUN by default — prints what would change and writes nothing.
//   node scripts/backfillPackagePages.js           (dry run)
//   node scripts/backfillPackagePages.js --apply   (writes; owner approval required)
//
// Run only after the backend with package pages is deployed (an older backend drops `pages`
// when a package is saved). Only packages with no `pages` field are touched; a package an
// admin already saved, even with no page ticked, keeps its choice. Nothing else changes.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Catalogue = require("../models/salesCatalogueModel");

const PAGE = "one-time-packages";
const apply = process.argv.includes("--apply");

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Database: ${mongoose.connection.db.databaseName} — ${apply ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`);

  const row = await Catalogue.findById("packages").lean();
  const missing = Object.values(row ? row.packages : {}).filter((item) => !Array.isArray(item.pages));
  console.log(`Packages without a page: ${missing.length}`);
  for (const item of missing) console.log(`  ${item.id} — ${item.name} (${item.status}) → ${PAGE}`);

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to write.");
  } else if (missing.length) {
    const result = await Catalogue.updateOne(
      { _id: "packages" },
      { $set: Object.fromEntries(missing.map((item) => [`packages.${item.id}.pages`, [PAGE]])) },
      { timestamps: false },
    );
    console.log(`\nUpdated: ${result.modifiedCount ? missing.length : 0} package(s).`);
  }
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
