// Explicit local/operator migration; dry run by default. Never runs on server startup.
require('dotenv').config();
const mongoose = require('mongoose');
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  await require('../models/emailControlModel').EmailTemplate.init();
  console.log(JSON.stringify(await require('../helpers/migrateNodeTemplates').migrateNodeTemplates({ apply: process.argv.includes('--apply') }), null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
