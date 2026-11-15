const Rule = require('../models/communicationActionRuleModel');
const { ACTIONS } = require('./actionEvents');
const { SELECTABLE_LEAD_STATUSES } = require('./leadStatuses');

const MAX_SENDS = 20;
const TIMING_REFS = ['after_action', 'before_due', 'on_due', 'after_due'];
const CONDITIONS = ['anytime', 'unpaid', 'paid'];
const SCOPE_KINDS = ['all', 'monthly', 'one_time', 'package'];
const DO_ALSO_TYPES = ['change_lead_stage', 'add_lead_note', 'stop_reminders'];
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function normalizeStep(step = {}, index = 0, isTemplate = false) {
  const timingRef = isTemplate ? 'after_action' : (step.timingRef || 'after_action');
  if (!TIMING_REFS.includes(timingRef)) fail(`Message ${index + 1}: invalid timing reference.`);
  const rawDays = step.days !== undefined ? step.days : step.afterDays;
  const days = isTemplate || timingRef === 'on_due' ? 0 : rawDays;
  if (!int(days, 0, 365)) fail(`Message ${index + 1}: days must be a whole number from 0 to 365.`);
  if (!['whatsapp', 'email', 'both'].includes(step.channel)) fail(`Message ${index + 1}: choose WhatsApp, Email or both.`);
  const text = String(step.text || '').trim();
  if (!text) fail(`Message ${index + 1}: write the message.`);
  const subject = String(step.subject || '').trim();
  if (step.channel !== 'whatsapp' && !subject) fail(`Message ${index + 1}: an email needs a subject.`);
  return {
    timingRef,
    days,
    afterDays: timingRef === 'after_action' ? days : 0,
    channel: step.channel,
    subject: step.channel === 'whatsapp' ? '' : subject,
    text,
  };
}

// Checks a rule from the form in plain words. Returns the clean fields to save.
function cleanRule(raw = {}) {
  const actionMeta = ACTIONS[raw.action];
  if (!actionMeta?.trigger) fail('Choose the action that starts this message.');
  const kind = raw.kind === 'template' ? 'template' : 'reminder';
  const audience = raw.audience === 'admin' ? 'admin' : 'customer';
  const allowedConditions = (actionMeta.conditions || [{ key: 'anytime' }]).map(c => c.key);
  const condition = raw.condition || 'anytime';
  if (!CONDITIONS.includes(condition) || !allowedConditions.includes(condition)) fail('Choose a valid condition for this action.');
  const scopeKind = SCOPE_KINDS.includes(raw.scope?.kind) ? raw.scope.kind : 'all';
  if (scopeKind !== 'all' && !actionMeta.supportsScope) fail('Package/plan scope is not available for this action.');
  const packageSlug = scopeKind === 'package' ? String(raw.scope?.packageSlug || '').trim() : '';
  if (scopeKind === 'package' && !packageSlug) fail('Choose a specific package.');

  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!steps.length || steps.length > 10) fail('Add 1 to 10 messages.');
  const isTemplate = kind === 'template';
  const clean = (isTemplate ? [steps[0]] : steps).map((step, index) => normalizeStep(step, index, isTemplate));
  if (!isTemplate) {
    const rank = st => (st.timingRef === 'after_action' ? st.days : st.timingRef === 'before_due' ? 10000 - st.days : st.timingRef === 'on_due' ? 10000 : 10000 + st.days);
    clean.sort((a, b) => rank(a) - rank(b));
  }

  const times = isTemplate ? 0 : (raw.repeat?.times || 0);
  if (!int(times, 0, 10)) fail('Repeat can be 0 to 10 times.');
  if (times && !int(raw.repeat.everyDays, 1, 90)) fail('Repeat every 1 to 90 days.');
  if (clean.length + times > MAX_SENDS) fail(`At most ${MAX_SENDS} messages per action.`);

  const stopOn = isTemplate ? [] : [...new Set(Array.isArray(raw.stopOn) ? raw.stopOn : [])];
  if (stopOn.some(key => !ACTIONS[key])) fail('Choose a valid stop action.');
  if (!isTemplate && clean.length + times > 1 && !stopOn.length) fail('A reminder needs a stop action.');

  const rawDoAlso = Array.isArray(raw.doAlso) ? raw.doAlso : [];
  if (rawDoAlso.length > 5) fail('At most 5 automatic steps per rule.');
  const doAlso = rawDoAlso.map((item, idx) => {
    const type = item?.type;
    if (!DO_ALSO_TYPES.includes(type)) fail(`Automatic step ${idx + 1}: invalid action type.`);
    if (type === 'change_lead_stage') {
      const stage = String(item.stage || '').trim();
      if (!SELECTABLE_LEAD_STATUSES.includes(stage)) fail(`Automatic step ${idx + 1}: choose a valid lead stage.`);
      return { type, stage, note: '' };
    }
    if (type === 'add_lead_note') {
      const note = String(item.note || '').trim().slice(0, 500);
      if (!note) fail(`Automatic step ${idx + 1}: write a follow-up note.`);
      return { type, stage: '', note };
    }
    return { type: 'stop_reminders', stage: '', note: '' };
  });

  const control = ['auto', 'review'].includes(raw.control) ? raw.control : 'off';
  return {
    kind,
    action: raw.action,
    actionId: String(raw.actionId || '').trim(),
    audience,
    condition,
    scope: { kind: scopeKind, packageSlug },
    steps: clean,
    repeat: times ? { everyDays: raw.repeat.everyDays, times } : { times: 0 },
    stopOn,
    doAlso,
    control,
  };
}

const stepLabel = (step, kind) => {
  if (kind === 'template') return 'now';
  const d = step.days ?? step.afterDays ?? 0;
  if (step.timingRef === 'before_due') return `${d}d before due`;
  if (step.timingRef === 'on_due') return 'on due date';
  if (step.timingRef === 'after_due') return `${d}d after due`;
  return d ? `after ${d} days` : 'now';
};

const autoName = rule => {
  const first = rule.steps[0];
  const who = rule.audience === 'admin' ? 'Admin' : 'Customer';
  const when = stepLabel(first, rule.kind);
  const cond = rule.condition === 'unpaid' ? ' · if unpaid' : rule.condition === 'paid' ? ' · if paid' : '';
  const scope = rule.scope?.kind === 'package' ? ` · ${rule.scope.packageSlug}`
    : rule.scope?.kind === 'monthly' ? ' · monthly'
      : rule.scope?.kind === 'one_time' ? ' · one-time' : '';
  const more = rule.kind === 'reminder' ? rule.steps.length + (rule.repeat?.times || 0) - 1 : 0;
  const stop = rule.stopOn?.length ? ` · stop when ${rule.stopOn.map(key => ACTIONS[key].label).join(', ')}` : '';
  return `${ACTIONS[rule.action].label} · ${who} · ${when}${cond}${scope}${more > 0 ? ` +${more} more` : ''}${stop}`.slice(0, 200);
};

async function createRule(raw, actorId) {
  const fields = cleanRule(raw);
  const activate = ['auto', 'review'].includes(fields.control) && raw.enabled === true;
  const origin = ['new', 'migrated', 'migrated_edited'].includes(raw.origin) ? raw.origin : 'new';
  const migratedFrom = String(raw.migratedFrom || '').trim();
  const pairId = String(raw.pairId || '').trim().slice(0, 64);
  return Rule.create({
    ...fields,
    name: autoName(fields),
    createdBy: actorId,
    origin,
    migratedFrom,
    pairId,
    enabled: activate,
    ...(activate ? { activatedAt: new Date() } : {}),
  });
}

// Editing always makes a new version: runs already planned keep their frozen text.
async function updateRule(id, raw) {
  const existing = await Rule.findById(id).select('origin migratedFrom pairId').lean();
  if (!existing) fail('Rule not found.');
  const fields = cleanRule(raw);
  const activate = ['auto', 'review'].includes(fields.control) && raw.enabled === true;
  const enabledUpdate = raw.enabled === undefined ? {} : activate ? { enabled: true, activatedAt: new Date() } : { enabled: false };
  const origin = existing.origin === 'migrated' || existing.origin === 'migrated_edited' ? 'migrated_edited' : (existing.origin || 'new');
  const pairId = raw.pairId !== undefined ? String(raw.pairId || '').trim().slice(0, 64) : (existing.pairId || '');
  const rule = await Rule.findOneAndUpdate(
    { _id: id },
    { $set: { ...fields, ...enabledUpdate, origin, pairId, name: autoName(fields) }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!rule) fail('Rule not found.');
  return rule;
}

// Turning a rule on is prospective: only actions after this moment are scheduled.
async function setRuleEnabled(id, enabled) {
  const existing = await Rule.findById(id).select('control').lean();
  if (!existing) fail('Rule not found.');
  const update = enabled
    ? { enabled: true, activatedAt: new Date(), ...(existing.control === 'off' ? { control: 'auto' } : {}) }
    : { enabled: false };
  const rule = await Rule.findOneAndUpdate({ _id: id }, { $set: update }, { new: true });
  if (!rule) fail('Rule not found.');
  return rule;
}

async function deleteRule(id) {
  const rule = await Rule.findByIdAndDelete(id);
  if (!rule) fail('Rule not found.');
  return rule;
}

module.exports = { cleanRule, autoName, createRule, updateRule, setRuleEnabled, deleteRule, MAX_SENDS };
