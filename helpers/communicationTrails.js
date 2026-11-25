const mongoose = require('mongoose');
const Trail = require('../models/communicationTrailModel');
const Rule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const { ACTIONS } = require('./actionEvents');
const { cleanRule } = require('./actionRules');
const { SYSTEM_ACTION_KEYS } = require('./automationCatalog');

const MAX_CHAIN_DEPTH = 6;
const MAX_TEMPLATES_PER_AUDIENCE = 25;
const HEX24_RE = /^[a-f\d]{24}$/i;
const ADMIN_ORIGINS = ['Admin'];
const USER_ORIGINS = ['Client', 'Website', 'System'];
const VALID_CONTROLS = ['auto', 'review', 'off'];
const fail = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  throw err;
};

function resolveActionControls(raw = {}) {
  const base = VALID_CONTROLS.includes(raw.control) ? raw.control : 'auto';
  const enabled = raw.enabled !== false && base !== 'off';
  const fallback = base === 'review' ? 'review' : 'auto';
  const rawAdmin = VALID_CONTROLS.includes(raw.adminActionControl) ? raw.adminActionControl : fallback;
  const rawUser = VALID_CONTROLS.includes(raw.userActionControl) ? raw.userActionControl : fallback;
  return {
    enabled,
    rawAdmin,
    rawUser,
    admin: enabled ? rawAdmin : 'off',
    user: enabled ? rawUser : 'off',
  };
}

function cleanChannel(ch) {
  return ['whatsapp', 'email', 'both'].includes(ch) ? ch : 'whatsapp';
}

function normalizeMessageBlock(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let templates = [];
  if (Array.isArray(src.templates) && src.templates.length > 0) {
    const seenIds = new Set();
    templates = src.templates.slice(0, MAX_TEMPLATES_PER_AUDIENCE).map((item, idx) => {
      const t = item && typeof item === 'object' ? item : {};
      let id = typeof t.id === 'string' && HEX24_RE.test(t.id.trim()) ? t.id.trim().toLowerCase() : '';
      if (!id || seenIds.has(id)) id = new mongoose.Types.ObjectId().toString();
      seenIds.add(id);
      const name = String(t.name || '').trim().slice(0, 100) || (idx === 0 ? 'Default' : `Template ${idx + 1}`);
      return {
        id,
        name,
        channel: cleanChannel(t.channel),
        subject: String(t.subject || '').trim().slice(0, 300),
        text: String(t.text || '').trim(),
        isDefault: Boolean(t.isDefault),
      };
    });
  } else {
    templates = [{
      id: new mongoose.Types.ObjectId().toString(),
      name: 'Default',
      channel: cleanChannel(src.channel),
      subject: String(src.subject || '').trim().slice(0, 300),
      text: String(src.text || '').trim(),
      isDefault: true,
    }];
  }

  let defIdx = templates.findIndex(t => t.isDefault);
  if (defIdx < 0) defIdx = 0;
  templates = templates.map((t, idx) => ({ ...t, isDefault: idx === defIdx }));
  const def = templates[defIdx];
  return {
    channel: def.channel,
    subject: def.subject,
    text: def.text,
    templates,
  };
}

function defaultTemplateOf(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (Array.isArray(msg.templates) && msg.templates.length) {
    return msg.templates.find(t => t.isDefault) || msg.templates[0];
  }
  return {
    id: '',
    name: 'Default',
    channel: cleanChannel(msg.channel),
    subject: String(msg.subject || '').trim(),
    text: String(msg.text || '').trim(),
    isDefault: true,
  };
}

function normalizeInstantBlock(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const audience = ['off', 'client', 'admin', 'both'].includes(src.audience) ? src.audience : 'off';
  return {
    audience,
    client: normalizeMessageBlock(src.client),
    admin: normalizeMessageBlock(src.admin),
  };
}

function normalizeReminderStep(raw = {}) {
  const st = raw && typeof raw === 'object' ? raw : {};
  const amount = Number(st.amount);
  return {
    amount: Number.isFinite(amount) ? Math.max(0, amount) : 3,
    unit: st.unit === 'hours' ? 'hours' : 'days',
    pos: st.pos === 'on' || st.pos === 'after' ? st.pos : 'before',
    channel: cleanChannel(st.channel),
    subject: String(st.subject || '').trim().slice(0, 300),
    text: String(st.text || '').trim(),
  };
}

function normalizeSystemActions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 5)) {
    const key = String(item?.key || '').trim();
    if (!key || !SYSTEM_ACTION_KEYS.has(key)) continue;
    const config = item?.config && typeof item.config === 'object' ? { ...item.config } : {};
    out.push({ key, config });
  }
  return out;
}

function normalizeTimeoutBlock(raw, fallbackDays = 5) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const afterDays = Number(t.afterDays);
  const condVal = Number(t.conditionValue);
  const nextStageId = Number(t.nextStageId);
  return {
    enabled: Boolean(t.enabled),
    afterDays: Number.isFinite(afterDays) ? Math.max(0, Math.min(365, Math.round(afterDays))) : Math.max(0, fallbackDays),
    condition: typeof t.condition === 'string' && t.condition.trim() ? t.condition.trim() : 'not_stopped',
    conditionValue: Number.isFinite(condVal) ? Math.max(0, condVal) : 50,
    actions: normalizeSystemActions(t.actions),
    nextStageId: Number.isFinite(nextStageId) && nextStageId > 0 ? Math.round(nextStageId) : null,
  };
}

function normalizeReminderBlock(raw = {}, fallbackId = 1, defaultBaseDate = 'due_date') {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = Number.isFinite(Number(r.id)) ? Number(r.id) : fallbackId;
  const clientSteps = Array.isArray(r.clientSteps) && r.clientSteps.length
    ? r.clientSteps.slice(0, 10).map(normalizeReminderStep)
    : [normalizeReminderStep({})];
  const adminSteps = Array.isArray(r.adminSteps) && r.adminSteps.length
    ? r.adminSteps.slice(0, 10).map(normalizeReminderStep)
    : [normalizeReminderStep({})];
  const repeatForDays = Number(r.repeatForDays);
  const repeatEveryDays = Number(r.repeatEveryDays);
  const repeatPerDay = Number(r.repeatPerDay);
  const conditionValue = Number(r.conditionValue);
  const safeForDays = Number.isFinite(repeatForDays) ? Math.max(1, repeatForDays) : 7;
  return {
    id,
    startTrigger: typeof r.startTrigger === 'string' && r.startTrigger.trim() ? r.startTrigger.trim() : '__main__',
    audience: ['client', 'admin', 'both'].includes(r.audience) ? r.audience : 'client',
    clientMode: r.clientMode === 'universal' ? 'universal' : 'separate',
    adminMode: r.adminMode === 'universal' ? 'universal' : 'separate',
    clientSteps,
    adminSteps,
    repeatMode: ['off', 'permanent', 'limited'].includes(r.repeatMode) ? r.repeatMode : 'off',
    repeatForDays: safeForDays,
    repeatEveryDays: Number.isFinite(repeatEveryDays) ? Math.max(1, repeatEveryDays) : 2,
    repeatPerDay: Number.isFinite(repeatPerDay) ? Math.min(4, Math.max(1, repeatPerDay)) : 1,
    countDaysFrom: ['trigger_date', 'due_date', 'expiry_date', 'deadline_date'].includes(r.countDaysFrom) ? r.countDaysFrom : defaultBaseDate,
    condition: typeof r.condition === 'string' && r.condition.trim() ? r.condition.trim() : 'any',
    conditionValue: Number.isFinite(conditionValue) ? Math.max(0, conditionValue) : 50,
    stopOn: [...new Set((Array.isArray(r.stopOn) ? r.stopOn : []).map(k => String(k || '').trim()).filter(Boolean))],
    onTimeout: normalizeTimeoutBlock(r.onTimeout, safeForDays),
    stopChains: {},
  };
}

function mapScope(scopeMode, selectedPackages, actionsList) {
  const supportsScope = actionsList.some(a => ACTIONS[a]?.supportsScope);
  if (!supportsScope || !scopeMode || scopeMode === 'all') return { kind: 'all' };
  if (scopeMode === 'monthly') return { kind: 'monthly' };
  if (scopeMode === 'onetime' || scopeMode === 'one_time') return { kind: 'one_time' };
  const pkgs = [...new Set((Array.isArray(selectedPackages) ? selectedPackages : []).map(s => String(s || '').trim()).filter(Boolean))];
  if (scopeMode === 'include') return pkgs.length ? { kind: 'include', includedPackages: pkgs } : { kind: 'all' };
  if (scopeMode === 'exclude') return pkgs.length ? { kind: 'exclude', excludedPackages: pkgs } : { kind: 'all' };
  return { kind: 'all' };
}

function mapStep(step = {}, baseDate = 'due_date') {
  const pos = step.pos || 'before';
  const timingRef = (baseDate === 'trigger_date' && pos === 'after')
    ? 'after_action'
    : pos === 'before' ? 'before_due' : pos === 'on' ? 'on_due' : 'after_due';
  const unit = step.unit === 'hours' ? 'hours' : 'days';
  const amount = Math.max(0, Number(step.amount ?? 0));
  return {
    timingRef,
    unit,
    days: unit === 'days' ? amount : 0,
    hours: unit === 'hours' ? amount : 0,
    channel: step.channel || 'whatsapp',
    subject: String(step.subject || '').trim(),
    text: String(step.text || '').trim(),
  };
}

function mapCondition(condition, value) {
  if (condition === 'progress_min') return { condition: 'anytime', minProgress: Math.min(100, Math.max(0, Number(value || 0))), maxProgress: null, minRemainingLimit: null, maxRemainingLimit: null };
  if (condition === 'progress_max') return { condition: 'anytime', minProgress: 0, maxProgress: Math.min(100, Math.max(0, Number(value || 0))), minRemainingLimit: null, maxRemainingLimit: null };
  if (condition === 'limit_min') return { condition: 'anytime', minProgress: 0, maxProgress: null, minRemainingLimit: Math.min(1000, Math.max(0, Number(value || 0))), maxRemainingLimit: null };
  if (condition === 'limit_max') return { condition: 'anytime', minProgress: 0, maxProgress: null, minRemainingLimit: null, maxRemainingLimit: Math.min(1000, Math.max(0, Number(value || 0))) };
  if (['not_stopped', 'unpaid', 'pending_approval', 'installment_due', 'upload_pending', 'paid'].includes(condition)) {
    return { condition, minProgress: 0, maxProgress: null, minRemainingLimit: null, maxRemainingLimit: null };
  }
  return { condition: 'anytime', minProgress: 0, maxProgress: null, minRemainingLimit: null, maxRemainingLimit: null };
}

function compileInstant(instant, actionsList, scopeObj, actionControls, out, stageMeta = { stageId: 0, startMode: 'event' }) {
  if (!instant || instant.audience === 'off') return;
  const ctrls = typeof actionControls === 'string'
    ? { admin: actionControls, user: actionControls }
    : (actionControls || { admin: 'auto', user: 'auto' });
  const variants = ctrls.admin === ctrls.user
    ? (ctrls.admin === 'off' ? [] : [{ control: ctrls.admin, originFilter: [] }])
    : [
        ...(ctrls.admin !== 'off' ? [{ control: ctrls.admin, originFilter: ADMIN_ORIGINS }] : []),
        ...(ctrls.user !== 'off' ? [{ control: ctrls.user, originFilter: USER_ORIGINS }] : []),
      ];
  if (!variants.length) return;
  const targets = instant.audience === 'both' ? ['client', 'admin'] : [instant.audience];
  for (const who of targets) {
    const msg = who === 'client' ? instant.client : instant.admin;
    const def = defaultTemplateOf(msg);
    const text = String(def?.text || '').trim();
    if (!text) continue;
    const channel = cleanChannel(def?.channel);
    const subject = channel === 'whatsapp' ? '' : (String(def?.subject || '').trim() || ACTIONS[actionsList[0]]?.label || 'Notification');
    for (const variant of variants) {
      out.push(cleanRule({
        kind: 'template',
        stageId: stageMeta.stageId,
        startMode: stageMeta.startMode,
        actions: actionsList,
        action: actionsList[0],
        audience: who === 'admin' ? 'admin' : 'customer',
        condition: 'anytime',
        originFilter: variant.originFilter,
        scope: scopeObj,
        steps: [{ timingRef: 'after_action', unit: 'days', days: 0, channel, subject, text }],
        repeat: { mode: 'off', times: 0, perDay: 1 },
        stopOn: [],
        control: variant.control,
      }));
    }
  }
}

function compileReminders(reminders, parentActions, trailScopeMode, trailPackages, control, out, depth = 0, branchSeen = new Set(), stageMeta = { stageId: 0, startMode: 'event' }) {
  if (!Array.isArray(reminders) || !reminders.length) return;
  if (depth > MAX_CHAIN_DEPTH) fail(`Maximum stop-trigger chain depth (${MAX_CHAIN_DEPTH}) exceeded.`);

  for (const rem of reminders) {
    const startActions = depth === 0 && rem.startTrigger && rem.startTrigger !== '__main__' && ACTIONS[rem.startTrigger]?.trigger
      ? [rem.startTrigger]
      : parentActions;
    const scopeObj = mapScope(trailScopeMode, trailPackages, startActions);
    const condFields = mapCondition(rem.condition, rem.conditionValue);
    const baseDate = ['trigger_date', 'due_date', 'expiry_date', 'deadline_date'].includes(rem.countDaysFrom) ? rem.countDaysFrom : 'due_date';
    const stopOn = [...new Set((Array.isArray(rem.stopOn) ? rem.stopOn : []).filter(k => Boolean(ACTIONS[k])))];
    const repeatMode = ['off', 'permanent', 'limited'].includes(rem.repeatMode) ? rem.repeatMode : 'off';
    const repeat = repeatMode === 'off'
      ? { mode: 'off', forDays: 0, times: 0, perDay: 1 }
      : {
          mode: repeatMode,
          forDays: repeatMode === 'limited' ? Math.max(1, Number(rem.repeatForDays || 1)) : 0,
          everyDays: Math.max(1, Number(rem.repeatEveryDays || 1)),
          perDay: Math.min(4, Math.max(1, Number(rem.repeatPerDay || 1))),
        };

    const audiences = rem.audience === 'both' ? ['client', 'admin'] : [rem.audience === 'admin' ? 'admin' : 'client'];
    const rawClientSteps = Array.isArray(rem.clientSteps) ? rem.clientSteps : [];
    let anchorStep = null;

    for (const who of audiences) {
      const isAdmin = who === 'admin';
      const mode = isAdmin ? rem.adminMode : rem.clientMode;
      const rawSteps = isAdmin ? (Array.isArray(rem.adminSteps) ? rem.adminSteps : []) : rawClientSteps;
      let builtSteps = [];

      if (mode === 'universal') {
        const tmpl = rawSteps[0] || {};
        const timingSource = (isAdmin && rem.audience === 'both' && rawClientSteps.length) ? rawClientSteps : rawSteps;
        builtSteps = timingSource
          .map(slot => mapStep({ ...slot, channel: tmpl.channel, subject: tmpl.subject, text: tmpl.text }, baseDate))
          .filter(st => st.text);
      } else {
        builtSteps = rawSteps.map(st => mapStep(st, baseDate)).filter(st => st.text);
      }

      if (!builtSteps.length) continue;
      if (!anchorStep) {
        const last = builtSteps[builtSteps.length - 1];
        anchorStep = { timingRef: last.timingRef, unit: last.unit, days: last.days, hours: last.hours };
      }

      const normalizedSteps = builtSteps.map(st => ({
        ...st,
        subject: st.channel === 'whatsapp' ? '' : (st.subject || ACTIONS[startActions[0]]?.label || 'Reminder'),
      }));

      const effectiveStopOn = stopOn;
      out.push(cleanRule({
        kind: 'reminder',
        stageId: stageMeta.stageId,
        startMode: stageMeta.startMode,
        actions: startActions,
        action: startActions[0],
        audience: isAdmin ? 'admin' : 'customer',
        ...condFields,
        baseDate,
        scope: scopeObj,
        steps: normalizedSteps,
        repeat,
        stopOn: effectiveStopOn,
        control,
      }));
    }

    // Compile optional Escalation / On-Timeout rule (Condition -> System Actions or Continue to Next Stage).
    const onTimeout = rem.onTimeout && typeof rem.onTimeout === 'object' ? rem.onTimeout : null;
    if (onTimeout?.enabled) {
      const rawActions = Array.isArray(onTimeout.actions) ? onTimeout.actions : [];
      const hasStageContinue = rawActions.some(a => a.key === 'stage.continue') || Boolean(onTimeout.nextStageId);
      const nonContinueActions = rawActions.filter(a => a.key !== 'stage.continue');
      const targetNextStageId = hasStageContinue && onTimeout.nextStageId ? Number(onTimeout.nextStageId) : null;
      if (targetNextStageId || nonContinueActions.length > 0) {
        const timeoutCond = mapCondition(onTimeout.condition || 'not_stopped', onTimeout.conditionValue);
        const fallbackAnchor = anchorStep || { timingRef: 'after_action', unit: 'days', days: 0, hours: 0 };
        out.push(cleanRule({
          kind: targetNextStageId ? 'stage_handoff' : 'system_action',
          stageId: stageMeta.stageId,
          startMode: stageMeta.startMode,
          nextStageId: targetNextStageId,
          actions: startActions,
          action: startActions[0],
          audience: 'customer',
          ...timeoutCond,
          baseDate,
          timeoutAfterDays: Number(onTimeout.afterDays ?? rem.repeatForDays ?? 0),
          anchorStep: fallbackAnchor,
          systemActions: nonContinueActions,
          scope: scopeObj,
          steps: [],
          repeat: { mode: 'off', times: 0, perDay: 1 },
          stopOn,
          control,
        }));
      }
    }

    // Recurse into Stop-Trigger "+" chains with cycle protection along this branch.
    const chains = rem.stopChains && typeof rem.stopChains === 'object' ? rem.stopChains : {};
    for (const stopKey of stopOn) {
      const chain = chains[stopKey];
      if (!chain || !ACTIONS[stopKey]?.trigger) continue;
      if (branchSeen.has(stopKey)) fail(`Loop detected on stop trigger "${ACTIONS[stopKey].label}".`);
      const nextSeen = new Set(branchSeen);
      nextSeen.add(stopKey);
      const chainScope = mapScope(trailScopeMode, trailPackages, [stopKey]);
      compileInstant(chain.instant, [stopKey], chainScope, control, out, stageMeta);
      compileReminders(chain.reminders, [stopKey], trailScopeMode, trailPackages, control, out, depth + 1, nextSeen, stageMeta);
    }
  }
}

function outPushStartActions(out, { stageMeta, stageTriggers, stageScope, onStartActions, stopOn, control }) {
  out.push(cleanRule({
    kind: 'system_action',
    stageId: stageMeta.stageId,
    startMode: stageMeta.startMode,
    actions: stageTriggers,
    action: stageTriggers[0],
    audience: 'customer',
    condition: 'anytime',
    baseDate: 'trigger_date',
    timeoutAfterDays: 0,
    anchorStep: { timingRef: 'after_action', unit: 'days', days: 0, hours: 0 },
    systemActions: onStartActions,
    scope: stageScope,
    steps: [],
    repeat: { mode: 'off', times: 0, perDay: 1 },
    stopOn,
    control,
  }));
}

function validateAndCompileTrail(raw = {}) {
  const triggers = [...new Set((Array.isArray(raw.triggers) ? raw.triggers : []).filter(k => ACTIONS[k]?.trigger))];
  if (!triggers.length) fail('Choose at least one valid trigger point.');
  const scope = ['all', 'monthly', 'onetime', 'include', 'exclude'].includes(raw.scope) ? raw.scope : 'all';
  const selectedPackages = (scope === 'include' || scope === 'exclude')
    ? [...new Set((Array.isArray(raw.selectedPackages) ? raw.selectedPackages : []).map(s => String(s || '').trim()).filter(Boolean))]
    : [];
  const actionControls = resolveActionControls(raw);
  const { enabled, rawAdmin: adminActionControl, rawUser: userActionControl } = actionControls;
  const control = !enabled ? 'off' : ((adminActionControl === 'review' || userActionControl === 'review') ? 'review' : 'auto');
  // Scheduled Reminders always run `auto` while the Trail is enabled (never blocked by Instant `review` mode).
  const reminderControl = enabled ? 'auto' : 'off';
  const instant = normalizeInstantBlock(raw.instant);
  const reminders = (Array.isArray(raw.reminders) ? raw.reminders : []).map((r, idx) => normalizeReminderBlock(r, idx + 1));
  const rawStages = Array.isArray(raw.stages) ? raw.stages : [];
  if (rawStages.length > MAX_CHAIN_DEPTH) fail(`Maximum ${MAX_CHAIN_DEPTH} follow-up stages allowed.`);

  const compiled = [];
  const topScope = mapScope(scope, selectedPackages, triggers);
  compileInstant(instant, triggers, topScope, actionControls, compiled);
  compileReminders(reminders, triggers, scope, selectedPackages, reminderControl, compiled, 0, new Set(triggers));

  const stages = [];
  const stageTriggersById = new Map([[0, triggers]]);
  for (let i = 0; i < rawStages.length; i++) {
    const st = rawStages[i] && typeof rawStages[i] === 'object' ? rawStages[i] : {};
    const stageId = Number.isFinite(Number(st.id)) && Number(st.id) > 0 ? Math.round(Number(st.id)) : (i + 1);
    const source = st.source === 'previous_timeout' ? 'previous_timeout' : 'trigger';
    const parentStageId = Number.isFinite(Number(st.parentStageId)) && Number(st.parentStageId) >= 0 ? Math.round(Number(st.parentStageId)) : 0;
    const rawStageTriggers = Array.isArray(st.triggers) && st.triggers.length
      ? st.triggers
      : (st.trigger ? [st.trigger] : []);
    let stageTriggers = [...new Set(rawStageTriggers.map(k => String(k || '').trim()).filter(k => ACTIONS[k]?.trigger))];
    if (source === 'previous_timeout' && !stageTriggers.length) {
      stageTriggers = stageTriggersById.get(parentStageId) || triggers;
    }
    if (!stageTriggers.length) fail(`Choose a valid trigger point for stage ${i + 2}.`);
    stageTriggersById.set(stageId, stageTriggers);
    const stageMeta = { stageId, startMode: source === 'previous_timeout' ? 'timeout_handoff' : 'event' };
    const stageInstant = normalizeInstantBlock(st.instant);
    const defaultBase = source === 'previous_timeout' ? 'trigger_date' : 'due_date';
    const stageReminder = st.reminder && typeof st.reminder === 'object' ? normalizeReminderBlock(st.reminder, i + 1, defaultBase) : null;
    const onStartActions = normalizeSystemActions(st.onStartActions).filter(a => a.key !== 'stage.continue');
    const stageScope = mapScope(scope, selectedPackages, stageTriggers);
    if (onStartActions.length > 0) {
      const startStopOn = stageReminder ? stageReminder.stopOn.filter(k => Boolean(ACTIONS[k])) : [];
      outPushStartActions(compiled, {
        stageMeta,
        stageTriggers,
        stageScope,
        onStartActions,
        stopOn: startStopOn,
        control: reminderControl,
      });
    }
    compileInstant(stageInstant, stageTriggers, stageScope, actionControls, compiled, stageMeta);
    if (stageReminder) {
      compileReminders([stageReminder], stageTriggers, scope, selectedPackages, reminderControl, compiled, 0, new Set(stageTriggers), stageMeta);
    }
    stages.push({
      id: stageId,
      source,
      parentStageId,
      triggers: stageTriggers,
      trigger: stageTriggers[0],
      onStartActions,
      instant: stageInstant,
      reminder: stageReminder,
    });
  }

  return {
    trailFields: { triggers, scope, selectedPackages, instant, reminders, stages, control, adminActionControl, userActionControl, enabled },
    compiled,
  };
}

async function cancelRunsForTrail(trailId, reason) {
  const oldRules = await Rule.find({ trailId }).select('_id').lean();
  if (!oldRules.length) return;
  const oldRuleIds = oldRules.map(r => r._id);
  const activeRuns = await Run.find({ ruleId: { $in: oldRuleIds }, source: 'action', status: { $in: ['scheduled', 'queued'] } }).select('_id status').lean();
  if (!activeRuns.length) return;
  const schedIds = activeRuns.filter(r => r.status === 'scheduled').map(r => r._id);
  if (schedIds.length) {
    await Run.updateMany({ _id: { $in: schedIds }, status: 'scheduled' }, { $set: { status: 'cancelled', reason } });
  }
  const { Queue, finishedExpiry } = require('../whatsapp/src/models.js');
  await Queue.updateMany(
    { reminderRunId: { $in: activeRuns.map(r => r._id) }, status: 'pending' },
    { $set: { status: 'cancelled', lastError: reason, expiresAt: finishedExpiry(new Date()) } },
  );
}

async function syncCompiledRules(trail, compiled, actorId) {
  await cancelRunsForTrail(trail._id, 'Trail updated or paused.');
  await Rule.deleteMany({ trailId: trail._id });
  if (!compiled.length) return [];
  const docs = compiled.map((fields, idx) => ({
    ...fields,
    trailId: trail._id,
    name: `${ACTIONS[fields.action]?.label || fields.action} · Trail #${idx + 1}`.slice(0, 200),
    enabled: Boolean(trail.enabled),
    activatedAt: trail.enabled ? (trail.activatedAt || new Date()) : null,
    origin: 'new',
    revision: trail.revision || 1,
    createdBy: actorId || trail.createdBy,
  }));
  return Rule.insertMany(docs);
}

async function listTrails() {
  return Trail.find().sort({ updatedAt: -1 }).lean();
}

async function createTrail(raw, actorId) {
  const { trailFields, compiled } = validateAndCompileTrail(raw);
  const trail = await Trail.create({
    ...trailFields,
    activatedAt: trailFields.enabled ? new Date() : null,
    revision: 1,
    createdBy: actorId,
  });
  await syncCompiledRules(trail, compiled, actorId);
  if (raw?.migratedLegacy) {
    await require('./legacyMigrationBridge').stampMigratedLegacy(trail._id, raw.migratedLegacy);
  }
  return trail.toObject();
}

async function updateTrail(id, raw, actorId) {
  const existing = await Trail.findById(id);
  if (!existing) fail('Automated message trail not found.', 404);
  const { trailFields, compiled } = validateAndCompileTrail(raw);
  existing.triggers = trailFields.triggers;
  existing.scope = trailFields.scope;
  existing.selectedPackages = trailFields.selectedPackages;
  existing.instant = trailFields.instant;
  existing.reminders = trailFields.reminders;
  existing.stages = trailFields.stages;
  existing.markModified('instant');
  existing.markModified('reminders');
  existing.markModified('stages');
  existing.control = trailFields.control;
  existing.adminActionControl = trailFields.adminActionControl;
  existing.userActionControl = trailFields.userActionControl;
  existing.enabled = trailFields.enabled;
  existing.activatedAt = trailFields.enabled ? (existing.activatedAt || new Date()) : null;
  existing.revision = (existing.revision || 1) + 1;
  await existing.save();
  await syncCompiledRules(existing, compiled, actorId || existing.createdBy);
  if (raw?.migratedLegacy) {
    await require('./legacyMigrationBridge').stampMigratedLegacy(existing._id, raw.migratedLegacy);
  }
  return existing.toObject();
}

async function setTrailEnabled(id, enabled) {
  const existing = await Trail.findById(id);
  if (!existing) fail('Automated message trail not found.', 404);
  existing.enabled = Boolean(enabled);
  if (existing.enabled && existing.control === 'off') existing.control = 'auto';
  existing.activatedAt = existing.enabled ? new Date() : null;
  await existing.save();
  if (!existing.enabled) {
    await cancelRunsForTrail(existing._id, 'Trail turned off by admin.');
  }
  const controls = resolveActionControls(existing);
  await Promise.all([
    Rule.updateMany(
      { trailId: existing._id, kind: 'template', originFilter: { $size: 0 } },
      { $set: { enabled: existing.enabled, control: controls.admin, activatedAt: existing.activatedAt } },
    ),
    Rule.updateMany(
      { trailId: existing._id, kind: 'template', originFilter: 'Admin' },
      { $set: { enabled: existing.enabled, control: controls.admin, activatedAt: existing.activatedAt } },
    ),
    Rule.updateMany(
      { trailId: existing._id, kind: 'template', originFilter: { $in: USER_ORIGINS } },
      { $set: { enabled: existing.enabled, control: controls.user, activatedAt: existing.activatedAt } },
    ),
    Rule.updateMany(
      { trailId: existing._id, kind: { $in: ['reminder', 'system_action', 'stage_handoff'] } },
      { $set: { enabled: existing.enabled, control: existing.enabled ? 'auto' : 'off', activatedAt: existing.activatedAt } },
    ),
  ]);
  return existing.toObject();
}

async function deleteTrail(id) {
  const existing = await Trail.findById(id);
  if (!existing) fail('Automated message trail not found.', 404);
  await cancelRunsForTrail(existing._id, 'Trail deleted by admin.');
  await Rule.deleteMany({ trailId: existing._id });
  await Trail.deleteOne({ _id: existing._id });
  return { deleted: true, id: String(existing._id) };
}

module.exports = {
  resolveActionControls,
  normalizeMessageBlock,
  normalizeInstantBlock,
  normalizeReminderStep,
  normalizeReminderBlock,
  defaultTemplateOf,
  validateAndCompileTrail,
  listTrails,
  createTrail,
  updateTrail,
  setTrailEnabled,
  deleteTrail,
};
