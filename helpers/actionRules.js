const Rule = require('../models/communicationActionRuleModel');
const { ACTIONS } = require('./actionEvents');

const MAX_SENDS = 20;
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// Checks a rule from the form in plain words. Returns the clean fields to save.
function cleanRule(raw = {}) {
  if (!ACTIONS[raw.action]?.trigger) fail('Choose the action that starts this message.');
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!steps.length || steps.length > 10) fail('Add 1 to 10 messages.');
  const clean = steps.map((step, index) => {
    if (!int(step.afterDays, 0, 365)) fail(`Message ${index + 1}: days must be a whole number from 0 to 365.`);
    if (!['whatsapp', 'email', 'both'].includes(step.channel)) fail(`Message ${index + 1}: choose WhatsApp, Email or both.`);
    const text = String(step.text || '').trim();
    if (!text) fail(`Message ${index + 1}: write the message.`);
    const subject = String(step.subject || '').trim();
    if (step.channel !== 'whatsapp' && !subject) fail(`Message ${index + 1}: an email needs a subject.`);
    return { afterDays: step.afterDays, channel: step.channel, subject: step.channel === 'whatsapp' ? '' : subject, text };
  }).sort((a, b) => a.afterDays - b.afterDays);
  const times = raw.repeat?.times || 0;
  if (!int(times, 0, 10)) fail('Repeat can be 0 to 10 times.');
  if (times && !int(raw.repeat.everyDays, 1, 90)) fail('Repeat every 1 to 90 days.');
  if (clean.length + times > MAX_SENDS) fail(`At most ${MAX_SENDS} messages per action.`);
  const stopOn = [...new Set(Array.isArray(raw.stopOn) ? raw.stopOn : [])];
  if (stopOn.some(key => !ACTIONS[key])) fail('Choose a valid stop action.');
  // A reminder (more than one message) always has a stop; the max count is the fixed end.
  if (clean.length + times > 1 && !stopOn.length) fail('A reminder needs a stop action.');
  const control = raw.control === 'auto' ? 'auto' : 'off';
  return { action: raw.action, steps: clean, repeat: times ? { everyDays: raw.repeat.everyDays, times } : { times: 0 }, stopOn, control };
}

const autoName = rule => {
  const first = rule.steps[0];
  const when = first.afterDays ? `after ${first.afterDays} days` : 'now';
  const more = rule.steps.length + (rule.repeat?.times || 0) - 1;
  const stop = rule.stopOn.length ? ` · stop when ${rule.stopOn.map(key => ACTIONS[key].label).join(', ')}` : '';
  return `${ACTIONS[rule.action].label} · Customer · ${when}${more ? ` +${more} more` : ''}${stop}`;
};

async function createRule(raw, actorId) {
  const fields = cleanRule(raw);
  return Rule.create({ ...fields, name: autoName(fields), createdBy: actorId, enabled: false });
}

// Editing always makes a new version: runs already planned keep their frozen text.
async function updateRule(id, raw) {
  const fields = cleanRule(raw);
  const rule = await Rule.findOneAndUpdate({ _id: id }, { $set: { ...fields, name: autoName(fields) }, $inc: { revision: 1 } }, { new: true });
  if (!rule) fail('Rule not found.');
  return rule;
}

// Turning a rule on is prospective: only actions after this moment are scheduled.
async function setRuleEnabled(id, enabled) {
  const update = enabled ? { enabled: true, activatedAt: new Date() } : { enabled: false };
  const rule = await Rule.findOneAndUpdate({ _id: id }, { $set: update }, { new: true });
  if (!rule) fail('Rule not found.');
  return rule;
}

module.exports = { cleanRule, autoName, createRule, updateRule, setRuleEnabled, MAX_SENDS };
