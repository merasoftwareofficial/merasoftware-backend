const Legacy = require('../models/messageTemplateModel');
const { EmailTemplate } = require('../models/emailControlModel');
const { definitions } = require('./emailDefinitions');
const { validateTemplateVariables } = require('./emailTemplates');

// Originals remain intact. A unique source ID makes repeated/concurrent imports safe.
async function migrateNodeTemplates({ apply = false } = {}) {
  const report = [];
  for (const row of await Legacy.find({ purpose: { $ne: 'broadcast' }, communicationMigratedAt: null }).lean()) {
    try {
      const subject = definitions.sendProjectUpdateEmail.subject;
      validateTemplateVariables('sendProjectUpdateEmail', subject, row.message);
      if (apply) {
        const imported = await EmailTemplate.findOneAndUpdate({ legacySourceId: row._id }, { $setOnInsert: {
        event: 'sendProjectUpdateEmail', name: row.name, subject, text: row.message, system: false,
        } }, { upsert: true, new: true });
        await Legacy.updateOne({ _id: row._id }, { $set: { communicationMigratedAt: new Date(), communicationTemplateId: imported._id } });
      }
      report.push({ id: String(row._id), status: apply ? 'imported-or-existing' : 'ready' });
    } catch (error) { report.push({ id: String(row._id), status: 'needs-review', reason: error.message }); }
  }
  return report;
}
module.exports = { migrateNodeTemplates };
