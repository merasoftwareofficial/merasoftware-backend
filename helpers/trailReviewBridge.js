const mongoose = require('mongoose');
const Trail = require('../models/communicationTrailModel');
const Rule = require('../models/communicationActionRuleModel');
const { EmailPolicy } = require('../models/emailControlModel');
const { byKey, isAdminRecipientEvent, isCustomerTriggered, isAutomaticEvent, channelFor } = require('./emailCatalog');
const { resolveActionControls, normalizeMessageBlock, defaultTemplateOf } = require('./communicationTrails');
const { templateWithDocs } = require('./emailTemplates');

const HEX24_RE = /^[a-f\d]{24}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function audienceForEvent(event, override) {
  if (override === 'admin' || override === 'client') return override;
  return (isAdminRecipientEvent(event) || byKey.get(event)?.audience === 'team') ? 'admin' : 'client';
}

function safeSubject(subject, event, fallbackName) {
  const clean = String(subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  if (clean) return clean;
  const label = byKey.get(event)?.label || fallbackName || 'Notification';
  return String(label).replace(/[\r\n]+/g, ' ').trim().slice(0, 300) || 'Notification';
}

function trailSyncKey(trailId, audience) {
  return `${String(trailId)}:${audience === 'admin' ? 'admin' : 'customer'}`;
}

function actionControlForEvent(trail, event) {
  if (!trail || !trail.enabled || trail.control === 'off') return 'off';
  const controls = resolveActionControls(trail);
  return isAutomaticEvent(event) ? controls.user : controls.admin;
}

function isTrailActiveForAudience(trail, audience) {
  if (!trail || !trail.enabled || trail.control === 'off') return false;
  const aud = trail.instant?.audience || 'off';
  if (aud !== 'both' && aud !== audience) return false;
  const def = defaultTemplateOf(trail.instant?.[audience]);
  return Boolean(String(def?.text || '').trim());
}

async function activeTrailForEvent(event) {
  const audience = audienceForEvent(event);
  if (!event || event === 'reminder.automated') return { migrated: false, trail: null, audience };
  const policy = await EmailPolicy.findOne({ event }).select('migratedToTrailId').lean();
  if (!policy?.migratedToTrailId) return { migrated: false, trail: null, audience };
  const trail = await Trail.findById(policy.migratedToTrailId).lean();
  return { migrated: true, trail: trail || null, audience };
}

async function resolveMailTrail(event, mail = {}, scope = null) {
  if (!event || event === 'reminder.automated') return { migrated: false };
  const { migrated, trail, audience } = await activeTrailForEvent(event);
  if (!migrated) return { migrated: false };
  if (!isTrailActiveForAudience(trail, audience)) {
    return { migrated: true, action: 'suppress', trail, audience };
  }
  const actorControl = actionControlForEvent(trail, event);
  if (actorControl === 'off' && !mail?.reviewed && !mail?.interactiveReview) {
    return { migrated: true, action: 'suppress', trail, audience };
  }
  const interactive = Boolean(
    mail?.reviewed
    || mail?.interactiveReview
    || (actorControl === 'review' && scope && !scope.system && !isCustomerTriggered(event)),
  );
  if (interactive) {
    return {
      migrated: true,
      action: 'stage',
      trail,
      audience,
      syncKey: trailSyncKey(trail._id, audience),
    };
  }
  if (process.env.ACTION_RULES_ENABLED === 'true') {
    return { migrated: true, action: 'worker', trail, audience };
  }
  return { migrated: true, action: 'suppress', trail, audience };
}

function toReviewTemplate(tpl, event, trailUpdatedAt) {
  const idStr = HEX24_RE.test(String(tpl?.id || '')) ? String(tpl.id).toLowerCase() : new mongoose.Types.ObjectId().toString();
  return {
    _id: new mongoose.Types.ObjectId(idStr),
    event: event || 'reminder.automated',
    name: String(tpl?.name || 'Default').trim() || 'Default',
    subject: safeSubject(tpl?.subject, event, tpl?.name),
    text: String(tpl?.text || ''),
    channel: ['whatsapp', 'email', 'both'].includes(tpl?.channel) ? tpl.channel : 'whatsapp',
    isDefault: Boolean(tpl?.isDefault),
    system: false,
    updatedAt: trailUpdatedAt || new Date(),
  };
}

async function resolveTrailTemplate(trailId, audience, templateId, event) {
  if (!trailId || !mongoose.isValidObjectId(trailId)) throw fail('Automated message trail not found', 404);
  const trail = await Trail.findById(trailId).select('instant updatedAt').lean();
  if (!trail) throw fail('Automated message trail not found', 404);
  const aud = audience === 'admin' ? 'admin' : 'client';
  const block = normalizeMessageBlock(trail.instant?.[aud]);
  let chosen;
  if (templateId) {
    const wanted = String(templateId).trim().toLowerCase();
    chosen = block.templates.find(t => String(t.id).toLowerCase() === wanted);
    if (!chosen) throw fail('Choose a template for this action', 400);
  } else {
    chosen = block.templates.find(t => t.isDefault) || block.templates[0];
  }
  if (!chosen || !String(chosen.text || '').trim()) throw fail('Choose a template for this action', 400);
  return toReviewTemplate(chosen, event, trail.updatedAt);
}

async function resolveTemplateForEvent(event, templateId, trailId, trailAudience) {
  if (trailId && mongoose.isValidObjectId(trailId)) {
    return resolveTrailTemplate(trailId, audienceForEvent(event, trailAudience), templateId, event);
  }
  const { migrated, trail, audience } = await activeTrailForEvent(event);
  if (migrated && trail && isTrailActiveForAudience(trail, audience)) {
    return resolveTrailTemplate(trail._id, audience, templateId, event);
  }
  return require('./emailTemplates').resolveTemplate(event, templateId);
}

async function trailTemplateOptions(trailId, audience) {
  if (!trailId || !mongoose.isValidObjectId(trailId)) return [];
  const trail = await Trail.findById(trailId).select('instant').lean();
  if (!trail) return [];
  const aud = audience === 'admin' ? 'admin' : 'client';
  const block = normalizeMessageBlock(trail.instant?.[aud]);
  return block.templates
    .filter(t => String(t.text || '').trim())
    .map(t => ({ id: String(t.id), name: t.name, system: false }));
}

async function hasTrailTemplate(event, templateId) {
  if (!templateId || !HEX24_RE.test(String(templateId))) return false;
  const { migrated, trail, audience } = await activeTrailForEvent(event);
  if (!migrated || !trail) return false;
  const block = normalizeMessageBlock(trail.instant?.[audience]);
  const wanted = String(templateId).trim().toLowerCase();
  return block.templates.some(t => String(t.id).toLowerCase() === wanted);
}

async function trailChannelForDraft(draft) {
  if (!draft?.trailId || !mongoose.isValidObjectId(draft.trailId)) return null;
  const trail = await Trail.findById(draft.trailId).select('instant').lean();
  if (!trail) return null;
  const aud = audienceForEvent(draft.event, draft.trailAudience);
  const block = normalizeMessageBlock(trail.instant?.[aud]);
  const wanted = draft.sourceTemplateId ? String(draft.sourceTemplateId).toLowerCase() : '';
  const tpl = (wanted && block.templates.find(t => String(t.id).toLowerCase() === wanted))
    || block.templates.find(t => t.isDefault)
    || block.templates[0];
  const ch = tpl?.channel || 'whatsapp';
  return byKey.has(draft.event) ? channelFor(draft.event, { channel: ch }) : ch;
}

async function assertTrailEnabled(trailId) {
  if (!trailId || !mongoose.isValidObjectId(trailId)) throw fail('Messages for this action are Off.', 409);
  const trail = await Trail.findById(trailId).select('enabled control').lean();
  if (!trail || !trail.enabled || trail.control === 'off') {
    throw fail('Messages for this action are Off.', 409);
  }
  return trail;
}

function checkExpectedUpdatedAt(trail, expectedUpdatedAt) {
  if (!expectedUpdatedAt) return;
  const expected = new Date(expectedUpdatedAt).getTime();
  const actual = trail.updatedAt ? new Date(trail.updatedAt).getTime() : 0;
  if (Number.isFinite(expected) && actual && Math.abs(actual - expected) > 1000) {
    throw fail('This template changed elsewhere. Reload it before saving.', 409);
  }
}

// Non-destructive sync: updates ONLY the compiled Instant `kind: 'template'` rule wording
// without touching or cancelling any active scheduled `kind: 'reminder'` runs.
async function syncDefaultTemplateRule(trail, audience, defTpl) {
  const ruleAudience = audience === 'admin' ? 'admin' : 'customer';
  const subject = defTpl.channel === 'whatsapp' ? '' : safeSubject(defTpl.subject, '', defTpl.name);
  await Rule.updateMany(
    { trailId: trail._id, kind: 'template', audience: ruleAudience },
    { $set: { 'steps.0.channel': defTpl.channel, 'steps.0.subject': subject, 'steps.0.text': defTpl.text } },
  );
}

async function createTrailTemplate({ trailId, trailAudience, event, sourceTemplateId, name, subject, text }) {
  if (!trailId || !mongoose.isValidObjectId(trailId)) throw fail('Automated message trail not found', 404);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw fail('Template name is required (up to 100 characters)', 400);
  const trail = await Trail.findById(trailId);
  if (!trail) throw fail('Automated message trail not found', 404);
  const aud = audienceForEvent(event, trailAudience);
  const block = normalizeMessageBlock(trail.instant?.[aud]);
  const src = sourceTemplateId
    ? block.templates.find(t => String(t.id).toLowerCase() === String(sourceTemplateId).toLowerCase())
    : block.templates.find(t => t.isDefault);
  const newId = new mongoose.Types.ObjectId().toString();
  const newTpl = {
    id: newId,
    name: name.trim().slice(0, 100),
    channel: src?.channel || block.channel || 'whatsapp',
    subject: String(subject || '').trim().slice(0, 300),
    text: String(text || '').trim(),
    isDefault: block.templates.length === 0,
  };
  const nextBlock = normalizeMessageBlock({ ...block, templates: [...block.templates, newTpl] });
  trail.instant = { ...(trail.instant || {}), [aud]: nextBlock };
  trail.markModified('instant');
  await trail.save();
  const saved = nextBlock.templates.find(t => t.id === newId) || newTpl;
  return templateWithDocs(toReviewTemplate(saved, event, trail.updatedAt));
}

async function updateTrailTemplate({ trailId, trailAudience, templateId, event, name, subject, text, expectedUpdatedAt }) {
  if (!trailId || !mongoose.isValidObjectId(trailId)) throw fail('Automated message trail not found', 404);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw fail('Template name is required (up to 100 characters)', 400);
  const trail = await Trail.findById(trailId);
  if (!trail) throw fail('Automated message trail not found', 404);
  checkExpectedUpdatedAt(trail, expectedUpdatedAt);
  const aud = audienceForEvent(event, trailAudience);
  const block = normalizeMessageBlock(trail.instant?.[aud]);
  const wanted = String(templateId || '').trim().toLowerCase();
  const idx = block.templates.findIndex(t => String(t.id).toLowerCase() === wanted);
  if (idx < 0) throw fail('Template not found', 404);
  const nextTemplates = block.templates.map((t, i) => (i === idx ? {
    ...t,
    name: name.trim().slice(0, 100),
    subject: String(subject || '').trim().slice(0, 300),
    text: String(text || '').trim(),
  } : t));
  const nextBlock = normalizeMessageBlock({ ...block, templates: nextTemplates });
  trail.instant = { ...(trail.instant || {}), [aud]: nextBlock };
  trail.markModified('instant');
  await trail.save();
  const updated = nextBlock.templates[idx];
  if (updated.isDefault) await syncDefaultTemplateRule(trail, aud, updated);
  return templateWithDocs(toReviewTemplate(updated, event, trail.updatedAt));
}

async function renameTrailTemplate({ trailId, trailAudience, templateId, event, name, expectedUpdatedAt }) {
  if (!trailId || !mongoose.isValidObjectId(trailId)) throw fail('Automated message trail not found', 404);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw fail('Template name is required (up to 100 characters)', 400);
  const trail = await Trail.findById(trailId);
  if (!trail) throw fail('Automated message trail not found', 404);
  checkExpectedUpdatedAt(trail, expectedUpdatedAt);
  const aud = audienceForEvent(event, trailAudience);
  const block = normalizeMessageBlock(trail.instant?.[aud]);
  const wanted = String(templateId || '').trim().toLowerCase();
  const idx = block.templates.findIndex(t => String(t.id).toLowerCase() === wanted);
  if (idx < 0) throw fail('Template not found', 404);
  const nextTemplates = block.templates.map((t, i) => (i === idx ? { ...t, name: name.trim().slice(0, 100) } : t));
  const nextBlock = normalizeMessageBlock({ ...block, templates: nextTemplates });
  trail.instant = { ...(trail.instant || {}), [aud]: nextBlock };
  trail.markModified('instant');
  await trail.save();
  return templateWithDocs(toReviewTemplate(nextBlock.templates[idx], event, trail.updatedAt));
}

async function deleteTrailTemplate({ trailId, trailAudience, templateId, replacementTemplateId, expectedUpdatedAt }) {
  if (!trailId || !mongoose.isValidObjectId(trailId)) throw fail('Automated message trail not found', 404);
  const trail = await Trail.findById(trailId);
  if (!trail) throw fail('Automated message trail not found', 404);
  checkExpectedUpdatedAt(trail, expectedUpdatedAt);
  const aud = trailAudience === 'admin' ? 'admin' : 'client';
  const block = normalizeMessageBlock(trail.instant?.[aud]);
  const wanted = String(templateId || '').trim().toLowerCase();
  const target = block.templates.find(t => String(t.id).toLowerCase() === wanted);
  if (!target) throw fail('Template not found', 404);
  if (block.templates.length <= 1) throw fail('Cannot delete the last remaining template on this trail.', 400);
  const remaining = block.templates.filter(t => String(t.id).toLowerCase() !== wanted);
  if (target.isDefault) {
    const repId = String(replacementTemplateId || '').trim().toLowerCase();
    const rep = remaining.find(t => String(t.id).toLowerCase() === repId);
    if (!rep) throw fail('Choose a replacement default for this action before deleting.', 400);
    remaining.forEach(t => { t.isDefault = String(t.id).toLowerCase() === repId; });
  }
  const nextBlock = normalizeMessageBlock({ ...block, templates: remaining });
  trail.instant = { ...(trail.instant || {}), [aud]: nextBlock };
  trail.markModified('instant');
  await trail.save();
  if (target.isDefault) {
    const nextDef = nextBlock.templates.find(t => t.isDefault) || nextBlock.templates[0];
    if (nextDef) await syncDefaultTemplateRule(trail, aud, nextDef);
  }
  return { deleted: String(templateId) };
}

module.exports = {
  audienceForEvent,
  safeSubject,
  trailSyncKey,
  actionControlForEvent,
  isTrailActiveForAudience,
  activeTrailForEvent,
  resolveMailTrail,
  toReviewTemplate,
  resolveTrailTemplate,
  resolveTemplateForEvent,
  trailTemplateOptions,
  hasTrailTemplate,
  trailChannelForDraft,
  assertTrailEnabled,
  createTrailTemplate,
  updateTrailTemplate,
  renameTrailTemplate,
  deleteTrailTemplate,
};
