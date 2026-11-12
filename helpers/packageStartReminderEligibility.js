const StartRequest = require('../models/packageStartRequestModel');
const { EmailPolicy } = require('../models/emailControlModel');
async function maySendPackageStartReminder({ event, application, dedupeKey }) {
  if (event !== 'package.start.request.admin' || application !== 'portal') return true;
  if (!dedupeKey) return false;
  if (!String(dedupeKey).startsWith('package-start-pending:')) return true;
  const match = /^package-start-pending:([a-f\d]{24}):([1-3])$/i.exec(dedupeKey);
  if (!match) return false;
  const row = await StartRequest.findById(match[1]).select('closedAt alerts remindersPaused').lean();
  if (!row || row.closedAt || row.remindersPaused || Number(row.alerts || 0) < Number(match[2])) return false;
  const policy = await EmailPolicy.findOne({ event }).select('mode').lean();
  return policy?.mode !== 'off';
}
module.exports = { maySendPackageStartReminder };
