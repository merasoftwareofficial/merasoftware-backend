const Trail = require('../models/communicationTrailModel');
const Rule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const { ACTIONS } = require('./actionEvents');
const { cleanRule } = require('./actionRules');

const MAX_CHAIN_DEPTH = 6;
const fail = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  throw err;
};

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
  if (condition === 'progress_min') return { condition: 'anytime', minProgress: Math.min(100, Math.max(0, Number(value || 0))), minRemainingLimit: null, maxRemainingLimit: null };
  if (condition === 'limit_min') return { condition: 'anytime', minProgress: 0, minRemainingLimit: Math.min(1000, Math.max(0, Number(value || 0))), maxRemainingLimit: null };
  if (condition === 'limit_max') return { condition: 'anytime', minProgress: 0, minRemainingLimit: null, maxRemainingLimit: Math.min(1000, Math.max(0, Number(value || 0))) };
  if (['unpaid', 'pending_approval', 'installment_due', 'upload_pending', 'paid'].includes(condition)) {
    return { condition, minProgress: 0, minRemainingLimit: null, maxRemainingLimit: null };
  }
  return { condition: 'anytime', minProgress: 0, minRemainingLimit: null, maxRemainingLimit: null };
}

function compileInstant(instant, actionsList, scopeObj, control, out) {
  if (!instant || instant.audience === 'off') return;
  const targets = instant.audience === 'both' ? ['client', 'admin'] : [instant.audience];
  for (const who of targets) {
    const msg = who === 'client' ? instant.client : instant.admin;
    const text = String(msg?.text || '').trim();
    if (!text) continue;
    const channel = msg?.channel || 'whatsapp';
    const subject = channel === 'whatsapp' ? '' : (String(msg?.subject || '').trim() || ACTIONS[actionsList[0]]?.label || 'Notification');
    out.push(cleanRule({
      kind: 'template',
      actions: actionsList,
      action: actionsList[0],
      audience: who === 'admin' ? 'admin' : 'customer',
      condition: 'anytime',
      scope: scopeObj,
      steps: [{ timingRef: 'after_action', unit: 'days', days: 0, channel, subject, text }],
      repeat: { mode: 'off', times: 0, perDay: 1 },
      stopOn: [],
      control,
    }));
  }
}

function compileReminders(reminders, parentActions, trailScopeMode, trailPackages, control, out, depth = 0, branchSeen = new Set()) {
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

      const normalizedSteps = builtSteps.map(st => ({
        ...st,
        subject: st.channel === 'whatsapp' ? '' : (st.subject || ACTIONS[startActions[0]]?.label || 'Reminder'),
      }));

      // If multiple steps or permanent repeat without stop trigger, require at least one stop trigger.
      const effectiveStopOn = stopOn;
      out.push(cleanRule({
        kind: 'reminder',
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

    // Recurse into Stop-Trigger "+" chains with cycle protection along this branch.
    const chains = rem.stopChains && typeof rem.stopChains === 'object' ? rem.stopChains : {};
    for (const stopKey of stopOn) {
      const chain = chains[stopKey];
      if (!chain || !ACTIONS[stopKey]?.trigger) continue;
      if (branchSeen.has(stopKey)) fail(`Loop detected on stop trigger "${ACTIONS[stopKey].label}".`);
      const nextSeen = new Set(branchSeen);
      nextSeen.add(stopKey);
      const chainScope = mapScope(trailScopeMode, trailPackages, [stopKey]);
      compileInstant(chain.instant, [stopKey], chainScope, control, out);
      compileReminders(chain.reminders, [stopKey], trailScopeMode, trailPackages, control, out, depth + 1, nextSeen);
    }
  }
}

function validateAndCompileTrail(raw = {}) {
  const triggers = [...new Set((Array.isArray(raw.triggers) ? raw.triggers : []).filter(k => ACTIONS[k]?.trigger))];
  if (!triggers.length) fail('Choose at least one valid trigger point.');
  const scope = ['all', 'monthly', 'onetime', 'include', 'exclude'].includes(raw.scope) ? raw.scope : 'all';
  const selectedPackages = (scope === 'include' || scope === 'exclude')
    ? [...new Set((Array.isArray(raw.selectedPackages) ? raw.selectedPackages : []).map(s => String(s || '').trim()).filter(Boolean))]
    : [];
  const control = ['auto', 'review', 'off'].includes(raw.control) ? raw.control : 'auto';
  const enabled = raw.enabled !== false && control !== 'off';
  const instant = raw.instant && typeof raw.instant === 'object'
    ? raw.instant
    : { audience: 'off', client: { channel: 'whatsapp', subject: '', text: '' }, admin: { channel: 'whatsapp', subject: '', text: '' } };
  const reminders = Array.isArray(raw.reminders) ? raw.reminders : [];

  const compiled = [];
  const topScope = mapScope(scope, selectedPackages, triggers);
  compileInstant(instant, triggers, topScope, control, compiled);
  compileReminders(reminders, triggers, scope, selectedPackages, control, compiled, 0, new Set(triggers));

  return {
    trailFields: { triggers, scope, selectedPackages, instant, reminders, control, enabled },
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
  existing.control = trailFields.control;
  existing.enabled = trailFields.enabled;
  existing.activatedAt = trailFields.enabled ? (existing.activatedAt || new Date()) : null;
  existing.revision = (existing.revision || 1) + 1;
  await existing.save();
  await syncCompiledRules(existing, compiled, actorId || existing.createdBy);
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
  await Rule.updateMany(
    { trailId: existing._id },
    { $set: { enabled: existing.enabled, control: existing.control, activatedAt: existing.activatedAt } },
  );
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
  validateAndCompileTrail,
  listTrails,
  createTrail,
  updateTrail,
  setTrailEnabled,
  deleteTrail,
};
