const Rule = require('../models/communicationActionRuleModel');
const { ACTIONS } = require('./actionEvents');
const { SELECTABLE_LEAD_STATUSES } = require('./leadStatuses');

const MAX_SENDS = 60;
const TIMING_REFS = ['after_action', 'before_due', 'on_due', 'after_due'];
const CONDITIONS = ['anytime', 'unpaid', 'pending_approval', 'paid', 'installment_due', 'upload_pending'];
const BASE_DATES = ['trigger_date', 'due_date', 'expiry_date', 'deadline_date'];
const ORIGIN_SURFACES = ['Admin', 'Client', 'Website', 'System'];
const SCOPE_KINDS = ['all', 'monthly', 'one_time', 'package', 'include', 'exclude', 'offer_payment'];
const DO_ALSO_TYPES = ['change_lead_stage', 'add_lead_note', 'stop_reminders'];
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function normalizeStep(step = {}, index = 0, isTemplate = false) {
  const timingRef = isTemplate ? 'after_action' : (step.timingRef || 'after_action');
  if (!TIMING_REFS.includes(timingRef)) fail(`Message ${index + 1}: invalid timing reference.`);
  const unit = !isTemplate && step.unit === 'hours' ? 'hours' : 'days';
  const rawDays = step.days !== undefined ? step.days : step.afterDays;
  const rawHours = step.hours !== undefined ? step.hours : rawDays;
  const days = unit === 'days' && !isTemplate && timingRef !== 'on_due' ? Number(rawDays ?? 0) : 0;
  const hours = unit === 'hours' && !isTemplate && timingRef !== 'on_due' ? Number(rawHours ?? 0) : 0;
  if (unit === 'days' && !int(days, 0, 365)) fail(`Message ${index + 1}: days must be a whole number from 0 to 365.`);
  if (unit === 'hours' && !int(hours, 0, 720)) fail(`Message ${index + 1}: hours must be a whole number from 0 to 720.`);
  if (!['whatsapp', 'email', 'both'].includes(step.channel)) fail(`Message ${index + 1}: choose WhatsApp, Email or both.`);
  const text = String(step.text || '').trim();
  if (!text) fail(`Message ${index + 1}: write the message.`);
  const subject = String(step.subject || '').trim();
  if (step.channel !== 'whatsapp' && !subject) fail(`Message ${index + 1}: an email needs a subject.`);
  return {
    timingRef,
    unit,
    days,
    hours,
    afterDays: timingRef === 'after_action' && unit === 'days' ? days : 0,
    channel: step.channel,
    subject: step.channel === 'whatsapp' ? '' : subject,
    text,
  };
}

// Checks a rule from the form in plain words. Returns the clean fields to save.
function cleanRule(raw = {}) {
  const actionsList = Array.isArray(raw.actions) && raw.actions.length
    ? [...new Set(raw.actions.filter(a => ACTIONS[a]?.trigger))]
    : (ACTIONS[raw.action]?.trigger ? [raw.action] : []);
  if (!actionsList.length) fail('Choose the action that starts this message.');
  const primaryAction = actionsList[0];
  const actionMeta = ACTIONS[primaryAction];
  const kind = raw.kind === 'template' ? 'template' : 'reminder';
  const audience = raw.audience === 'admin' ? 'admin' : 'customer';
  const allowedConditions = [...new Set(actionsList.flatMap(a => (ACTIONS[a]?.conditions || [{ key: 'anytime' }]).map(c => c.key)))];
  const condition = raw.condition || 'anytime';
  if (!CONDITIONS.includes(condition) || !allowedConditions.includes(condition)) fail('Choose a valid condition for this action.');
  const minProgress = raw.minProgress !== undefined && raw.minProgress !== null && raw.minProgress !== ''
    ? Number(raw.minProgress)
    : 0;
  if (!int(minProgress, 0, 100)) fail('Minimum progress must be a whole number from 0 to 100%.');
  const minRemainingLimit = raw.minRemainingLimit !== undefined && raw.minRemainingLimit !== null && raw.minRemainingLimit !== ''
    ? Number(raw.minRemainingLimit)
    : null;
  if (minRemainingLimit !== null && !int(minRemainingLimit, 0, 1000)) fail('Minimum remaining limit must be a whole number from 0 to 1000.');
  const maxRemainingLimit = raw.maxRemainingLimit !== undefined && raw.maxRemainingLimit !== null && raw.maxRemainingLimit !== ''
    ? Number(raw.maxRemainingLimit)
    : null;
  if (maxRemainingLimit !== null && !int(maxRemainingLimit, 0, 1000)) fail('Remaining limit threshold must be a whole number from 0 to 1000.');
  const baseDate = BASE_DATES.includes(raw.baseDate) ? raw.baseDate : 'due_date';
  const supportsScope = actionsList.some(a => ACTIONS[a]?.supportsScope);
  const scopeKind = SCOPE_KINDS.includes(raw.scope?.kind) ? raw.scope.kind : 'all';
  if (scopeKind !== 'all' && !supportsScope) fail('Package/plan scope is not available for this action.');
  const packageSlug = scopeKind === 'package' ? String(raw.scope?.packageSlug || '').trim() : '';
  if (scopeKind === 'package' && !packageSlug) fail('Choose a specific package.');
  const includedPackages = scopeKind === 'include'
    ? [...new Set((Array.isArray(raw.scope?.includedPackages) ? raw.scope.includedPackages : []).map(s => String(s || '').trim()).filter(Boolean))]
    : [];
  const excludedPackages = scopeKind === 'exclude'
    ? [...new Set((Array.isArray(raw.scope?.excludedPackages) ? raw.scope.excludedPackages : []).map(s => String(s || '').trim()).filter(Boolean))]
    : [];

  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!steps.length || steps.length > 10) fail('Add 1 to 10 messages.');
  const isTemplate = kind === 'template';
  const clean = (isTemplate ? [steps[0]] : steps).map((step, index) => normalizeStep(step, index, isTemplate));
  if (!isTemplate) {
    const hoursOf = st => (st.unit === 'hours' ? (st.hours || 0) : (st.days || 0) * 24);
    const rank = st => (st.timingRef === 'after_action' ? hoursOf(st) : st.timingRef === 'before_due' ? 100000 - hoursOf(st) : st.timingRef === 'on_due' ? 100000 : 100000 + hoursOf(st));
    clean.sort((a, b) => rank(a) - rank(b));
  }

  const rawRepeatMode = raw.repeat?.mode;
  const repeatMode = isTemplate ? 'off'
    : (['off', 'permanent', 'limited'].includes(rawRepeatMode) ? rawRepeatMode : ((raw.repeat?.times || 0) > 0 ? 'limited' : 'off'));
  const everyDays = repeatMode !== 'off' ? Number(raw.repeat?.everyDays || 1) : 1;
  const perDay = repeatMode !== 'off' ? Number(raw.repeat?.perDay ?? 1) : 1;
  const forDays = repeatMode === 'limited' ? Number(raw.repeat?.forDays || 0) : 0;
  const times = isTemplate || repeatMode === 'off' ? 0
    : repeatMode === 'permanent' ? 0
      : (raw.repeat?.times !== undefined ? Number(raw.repeat.times) : Math.min(60, Math.max(1, Math.floor((forDays || 1) / Math.max(1, everyDays)))));
  if (repeatMode === 'limited' && !int(times, 0, 60)) fail('Repeat can be 0 to 60 times.');
  if (repeatMode !== 'off' && !int(everyDays, 1, 90)) fail('Repeat every 1 to 90 days.');
  if (repeatMode !== 'off' && !int(perDay, 1, 4)) fail('Repeat can be 1 to 4 times a day.');
  if (repeatMode === 'limited' && clean.length + times * perDay > MAX_SENDS) fail(`At most ${MAX_SENDS} messages per action.`);

  const stopOn = isTemplate ? [] : [...new Set(Array.isArray(raw.stopOn) ? raw.stopOn : [])];
  if (stopOn.some(key => !ACTIONS[key])) fail('Choose a valid stop action.');
  if (!isTemplate && (repeatMode === 'permanent' || clean.length + times > 1) && !stopOn.length) fail('A reminder needs a stop action.');

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

  const purpose = String(raw.purpose || '').trim().slice(0, 120);
  const originFilter = [...new Set((Array.isArray(raw.originFilter) ? raw.originFilter : []).filter(s => ORIGIN_SURFACES.includes(s)))];
  const control = ['auto', 'review'].includes(raw.control) ? raw.control : 'off';
  return {
    purpose,
    kind,
    action: primaryAction,
    actions: actionsList,
    actionId: String(raw.actionId || '').trim(),
    originFilter,
    audience,
    condition,
    minProgress,
    minRemainingLimit,
    maxRemainingLimit,
    baseDate,
    scope: { kind: scopeKind, packageSlug, includedPackages, excludedPackages },
    steps: clean,
    repeat: repeatMode === 'permanent'
      ? { mode: 'permanent', forDays: 0, everyDays, times: 0, perDay }
      : times
        ? (rawRepeatMode ? { mode: 'limited', forDays, everyDays, times, perDay } : { everyDays, times, perDay })
        : { times: 0, perDay: 1 },
    stopOn,
    doAlso,
    control,
  };
}

const stepLabel = (step, kind) => {
  if (kind === 'template') return 'now';
  const isHours = step.unit === 'hours';
  const val = isHours ? (step.hours ?? 0) : (step.days ?? step.afterDays ?? 0);
  const unitShort = isHours ? 'h' : 'd';
  if (step.timingRef === 'before_due') return `${val}${unitShort} before due`;
  if (step.timingRef === 'on_due') return 'on due date';
  if (step.timingRef === 'after_due') return `${val}${unitShort} after due`;
  return val ? `after ${val} ${isHours ? 'hours' : 'days'}` : 'now';
};

const autoName = rule => {
  const first = rule.steps[0];
  const who = rule.audience === 'admin' ? 'Admin' : 'Customer';
  const when = stepLabel(first, rule.kind);
  const cond = rule.condition === 'unpaid' ? ' · if unpaid'
    : rule.condition === 'paid' ? ' · if paid'
      : rule.condition === 'upload_pending' ? ' · if upload pending' : '';
  const scope = rule.scope?.kind === 'package' ? ` · ${rule.scope.packageSlug}`
    : rule.scope?.kind === 'monthly' ? ' · monthly'
      : rule.scope?.kind === 'one_time' ? ' · one-time'
        : rule.scope?.kind === 'offer_payment' ? ' · offer payment' : '';
  const more = rule.kind === 'reminder' ? rule.steps.length + (rule.repeat?.times || 0) * (rule.repeat?.perDay || 1) - 1 : 0;
  const stop = rule.stopOn?.length ? ` · stop when ${rule.stopOn.map(key => ACTIONS[key].label).join(', ')}` : '';
  const title = rule.purpose || ACTIONS[rule.action].label;
  return `${title} · ${who} · ${when}${cond}${scope}${more > 0 ? ` +${more} more` : ''}${stop}`.slice(0, 200);
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
