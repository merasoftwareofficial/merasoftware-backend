const Rule = require('../models/communicationReminderRuleModel');
const mongoose = require('mongoose');
const FIELDS = {
  monthly_package: ['name', 'package', 'amount', 'dueDate', 'planLink', 'invoiceLink'],
  broadcast: ['name'],
};
function validateDraft(input) {
  const name = String(input?.name || '').trim();
  const source = input?.source;
  if (!name || name.length > 100) throw new Error('Enter a rule name of up to 100 characters.');
  if (!Object.hasOwn(FIELDS, source)) throw new Error('Choose a supported action.');
  if (input.enabled) throw new Error('Reminder activation is not available yet.');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 10) throw new Error('Add between 1 and 10 reminder steps.');
  const seen = new Set();
  const steps = input.steps.map(raw => {
    if (!Number.isInteger(raw.offsetDays) || raw.offsetDays < (source === 'broadcast' ? 0 : -365) || raw.offsetDays > 365 || seen.has(raw.offsetDays)) throw new Error('Each reminder needs a different valid whole day.');
    seen.add(raw.offsetDays);
    const subject = String(raw.subject || '').trim(), text = String(raw.text || '').trim();
    if (!subject || subject.length > 300 || /[\r\n]/.test(subject) || !text || text.length > 10000) throw new Error('Enter a subject and message for every reminder.');
    if (!['whatsapp', 'email', 'both'].includes(raw.channel)) throw new Error('Choose a valid delivery channel.');
    const keys = [...`${subject}\n${text}`.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]);
    if (keys.some(key => !FIELDS[source].includes(key))) throw new Error('A message contains a detail unavailable for this action.');
    return { offsetDays: raw.offsetDays, subject, text, channel: raw.channel };
  });
  return { name, source, enabled: false, steps: steps.sort((a, b) => a.offsetDays - b.offsetDays) };
}
async function createDraft(input, actorId) {
  const fields = validateDraft(input);
  return Rule.create({ ...fields, createdBy: actorId });
}
async function listDrafts() {
  return Rule.find().sort({ updatedAt: -1, _id: -1 }).limit(100).lean();
}
async function updateDraft(id, input) {
  if (!mongoose.isValidObjectId(id)) throw new Error('Unknown reminder rule.');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('Reload this rule before saving.');
  const fields = validateDraft(input);
  const updated = await Rule.findOneAndUpdate({ _id: id, enabled: false, revision: input.expectedRevision }, { $set: fields, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
  if (!updated) throw Object.assign(new Error('This rule changed or is active. Reload it before saving.'), { status: 409 });
  return updated;
}
async function setEnabled(id, enabled, expectedRevision) {
  if (!mongoose.isValidObjectId(id) || typeof enabled !== 'boolean' || !Number.isInteger(expectedRevision)) throw new Error('Reload the reminder rule and try again.');
  const current = await Rule.findById(id).lean();
  if (!current || current.revision !== expectedRevision || current.enabled === enabled) throw Object.assign(new Error('This rule changed. Reload it before continuing.'), { status: 409 });
  if (enabled) {
    if (process.env.COMMUNICATION_REMINDER_JOBS_ENABLED !== 'true' || process.env.ENABLE_CRONS !== 'true') throw new Error('Enable the reminder and plan-billing schedulers on the server before activating this rule.');
    validateDraft({ ...current, enabled: false });
    // Ensure the partial unique index is ready before two admins can activate.
    await Rule.init();
  }
  let result;
  try {
    result = await Rule.findOneAndUpdate({ _id: id, enabled: !enabled, revision: expectedRevision },
      { $set: { enabled, ...(enabled ? { activatedAt: new Date() } : {}) }, ...(enabled ? { $unset: { broadcastScanCursor: 1 } } : {}), $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
  } catch (error) { if (error.code === 11000) throw Object.assign(new Error('Another rule is already active for this action.'), { status: 409 }); throw error; }
  if (!result) throw Object.assign(new Error('This rule changed. Reload it before continuing.'), { status: 409 });
  if (!enabled) {
    // Rule state is authoritative even if this display cleanup fails: handoff
    // checks reject disabled rules, and the next worker run reconciles them.
    try { await require('../models/communicationReminderRunModel').updateMany({ ruleId: id, status: 'scheduled' }, { $set: { status: 'cancelled', reason: 'Rule disabled.' } }); }
    catch (error) { console.error('[reminders] disabled rule cleanup:', error.message); }
  }
  return result;
}
module.exports = { FIELDS, validateDraft, createDraft, listDrafts, updateDraft, setEnabled };
