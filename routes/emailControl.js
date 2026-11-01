const express = require('express');
const mongoose = require('mongoose');
const authToken = require('../middleware/authToken');
const userModel = require('../models/userModel');
const { EmailTemplate, EmailPolicy, EmailDraft, EmailHistory, EmailReviewPreference } = require('../models/emailControlModel');
const { events, byKey, isAutomaticEvent: isCustomerTriggered } = require('../helpers/emailCatalog');
const { decide, applyDefault, reviewedMail, validateContent, applicationQuery, draftAccess } = require('../helpers/emailController');
const { withRequiredLinks } = require('../helpers/emailMarkup');
const { catalogFor, sampleContext, validateTemplateVariables, systemTemplate, ensureSystemTemplates, resolveTemplate, resetSystemTemplate, composeTemplate, templateWithDocs, templateFromEditor, reviewWithDoc, reviewTextFromEditor } = require('../helpers/emailTemplates');
const { verifyWebsiteAccess } = require('../helpers/websiteEmailAccess');
const { queryOutbox, reconcileSent } = require('../helpers/emailOutbox');
const { messageText } = require('../helpers/whatsappQueue');
const { reviewSubjectFromEditor, templateOptions, editableReview } = require('../helpers/emailTemplates');
const { availability } = require('../helpers/reviewDelivery');
const { changeMessageType } = require('../helpers/leadMessage');
const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(async (req, res, next) => {
  try {
    const claims = verifyWebsiteAccess(req);
    if (!claims) return authToken(req, res, next);
    req.emailBridgeAccess = claims.access;
    req.userId = claims.sub;
    if (claims.access === 'intake') {
      if (req.method !== 'POST' || req.path !== '/website-drafts') return res.status(403).json({ success: false, message: 'Submission access cannot manage email' });
    } else {
      if (!mongoose.isValidObjectId(req.userId)) throw new Error('Invalid website actor');
      const user = await userModel.findById(req.userId).select('isGuest isActive').lean();
      if (!user || user.isGuest || user.isActive === false) throw new Error('Website account is unavailable');
    }
    next();
  } catch { res.status(401).json({ success: false, message: 'Invalid website email access' }); }
});
router.use(async (req, res, next) => {
  try {
    if (req.emailBridgeAccess) {
      if (req.query.application && req.query.application !== 'website') return res.status(403).json({ success: false, message: 'Website access cannot manage portal email' });
      req.emailApplication = 'website';
      req.emailIsAdmin = req.emailBridgeAccess === 'admin';
      req.emailAccess = { application: 'website', websiteAdmin: req.emailBridgeAccess === 'admin', validatedWebsite: req.emailBridgeAccess === 'admin' };
      return next();
    }
    const user = await userModel.findById(req.userId).select('roles isGuest isActive').lean();
    const ownDraftRoute = /^\/drafts\/[a-f\d]{24}(\/(decision|preview))?$/i.test(req.path);
    if (!user || user.isGuest || user.isActive === false || (!ownDraftRoute && !user.roles?.includes('admin'))) return res.status(403).json({ success: false, message: 'Admin access required for email settings' });
    const application = req.query.application || 'portal';
    if (!['portal', 'website'].includes(application)) throw new Error('Unknown application');
    req.emailApplication = application;
    req.emailIsAdmin = !!user.roles?.includes('admin');
    req.emailAccess = { application, websiteAdmin: user.roles?.includes('admin') && application === 'website', portalAdmin: user.roles?.includes('admin') && application === 'portal' };
    // Preserve existing per-action popup ownership across both event families.
    if (ownDraftRoute && !req.query.application) req.emailAccess = {};
    next();
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});
const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};
function allowedEvent(req, event) {
  if (!byKey.has(event) || byKey.get(event).application !== req.emailApplication) throw new Error('This action belongs to another application');
}
function adminOnly(req) {
  if (req.emailBridgeAccess === 'intake') throw new Error('Admin access required');
}
// Customers review the mail of their own actions; only an admin picks a template for it.
function templateChoiceAllowed(req) {
  if (!req.emailIsAdmin) throw Object.assign(new Error('Only an admin can choose an email template'), { status: 403 });
}
async function loadDraft(req) {
  const draft = await EmailDraft.findOne({ _id: req.params.id, ...draftAccess(req.userId, req.emailAccess), status: { $ne: 'staged' }, expiresAt: { $gt: new Date() } }).select('-attachments.content -headers').lean();
  if (!draft) throw new Error('Draft unavailable');
  return draft;
}
router.post('/website-drafts', handle(async (req, res) => {
  const { event, to, subject, text, headers, requiredLinks, reference, dedupeKey, values } = req.body;
  if (!['website.subscription.confirm', 'website.subscription.manage'].includes(event)) throw new Error('Unknown website email action');
  // The website still sends its own subject and text (kept on the draft as its base); the mail
  // itself comes from the action's template, filled with the topics and the required link.
  validateContent(subject, text);
  const details = {
    link: Array.isArray(requiredLinks) && typeof requiredLinks[0] === 'string' ? requiredLinks[0] : '',
    topics: typeof values?.topics === 'string' ? values.topics.slice(0, 500) : '',
  };
  // Legacy portal admins can still prepare their own website drafts, but only
  // the website server can submit public requests and validate a send decision.
  const { queueMail } = require('../helpers/emailController');
  const result = await queueMail(event, { to, subject, text, headers, requiredLinks, reference, dedupeKey, values: details });
  res.json({ success: true, data: { queued: !!result.queued, sent: false, draftId: result.draftId } });
}));
router.get('/', handle(async (req, res) => {
  adminOnly(req);
  const eventFilter = applicationQuery(req.emailApplication);
  const ownership = draftAccess(req.userId, req.emailAccess);
  await reconcileSent(ownership);
  await ensureSystemTemplates(req.emailApplication);
  const [policies, templates, drafts, history] = await Promise.all([
    EmailPolicy.find(eventFilter).lean(), EmailTemplate.find(eventFilter).sort({ system: -1, name: 1 }).lean(),
    EmailDraft.find({ ...ownership, status: { $ne: 'staged' }, expiresAt: { $gt: new Date() } }).select('-html -attachments.content -headers').sort({ createdAt: -1 }).limit(100).lean(),
    EmailHistory.find(ownership).sort({ updatedAt: -1 }).limit(100).lean(),
  ]);
  const applicationEvents = events.filter(e => e.application === req.emailApplication);
  res.json({ success: true, data: { application: req.emailApplication, events: applicationEvents, catalog: catalogFor(applicationEvents), policies, templates: templates.map(templateWithDocs), drafts, history, automaticSending: false, serverNow: Date.now() } });
}));
// Counts and the last few decisions, for the website's Communication page: no Outbox sync, no templates,
// no full lists, no writes. A failed/sending draft whose audit row is already 'sent' was delivered
// (reconcileSent repairs it when the list opens), so it is not counted as waiting.
const RECENT = 5;
const UNDECIDED = ['pending', 'failed', 'sending'];
router.get('/summary', handle(async (req, res) => {
  adminOnly(req);
  const ownership = draftAccess(req.userId, req.emailAccess);
  const now = new Date();
  const [waiting, latest] = await Promise.all([
    EmailDraft.find({ ...ownership, status: { $in: UNDECIDED }, expiresAt: { $gt: now } }).select('status delivery.channels').lean(),
    EmailHistory.find(ownership).sort({ updatedAt: -1 }).limit(RECENT).select('application event to subject status sentAt updatedAt expiresAt').lean(),
  ]);
  const inFlight = waiting.filter(row => row.status !== 'pending' && !row.delivery?.channels?.length).map(row => row._id);
  const delivered = inFlight.length ? (await EmailHistory.distinct('draftId', { ...ownership, draftId: { $in: inFlight }, status: 'sent' })).length : 0;
  // Same status the history list shows: an undecided mail past its draft's expiry is "expired".
  const recent = latest.map(row => ({
    _id: row._id, application: row.application, event: row.event, label: byKey.get(row.event)?.label || row.event, to: row.to || [], subject: row.subject || '',
    status: UNDECIDED.includes(row.status) && row.expiresAt && row.expiresAt <= now ? 'expired' : row.status, at: row.sentAt || row.updatedAt,
  }));
  res.json({ success: true, data: { application: req.emailApplication, review: waiting.length - delivered, actions: events.filter(e => e.application === req.emailApplication).length, recent } });
}));
router.get('/outbox', handle(async (req, res) => {
  adminOnly(req);
  const ownership = { ...draftAccess(req.userId, req.emailAccess), application: req.emailApplication };
  res.json({ success: true, data: await queryOutbox(ownership, req.query) });
}));
router.put('/policies/:event', handle(async (req, res) => {
  adminOnly(req); const event = req.params.event; allowedEvent(req, event);
  if (!(isCustomerTriggered(event) ? ['auto', 'off'] : ['review', 'off']).includes(req.body.mode)) throw new Error('Invalid sending rule');
  const defaultTemplate = req.body.defaultTemplate || null;
  if (defaultTemplate && (!mongoose.isValidObjectId(defaultTemplate) || !await EmailTemplate.exists({ _id: defaultTemplate, event }))) throw new Error('Choose a template for this action');
  await EmailPolicy.findOneAndUpdate({ event }, { $set: { mode: req.body.mode, defaultTemplate } }, { upsert: true, runValidators: true });
  res.json({ success: true });
}));
function validateTemplate(event, body) {
  validateContent(body.subject, body.text);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw new Error('Template name is required (up to 100 characters)');
  validateTemplateVariables(event, body.subject, body.text);
}
router.get('/preferences/:event', handle(async (req, res) => {
  templateChoiceAllowed(req); allowedEvent(req, req.params.event);
  const saved = await EmailReviewPreference.findOne({ actor: req.userId, application: req.emailApplication, event: req.params.event }).lean();
  const valid = saved?.templateId && await EmailTemplate.exists({ _id: saved.templateId, event: req.params.event });
  const fallback = saved?.templateId && !valid ? await resolveTemplate(req.params.event) : null;
  res.json({ success: true, data: { channel: saved?.channel, templateId: valid ? String(saved.templateId) : fallback?._id ? String(fallback._id) : null, templateUnavailable: !!saved?.templateId && !valid } });
}));
router.put('/preferences/:event', handle(async (req, res) => {
  templateChoiceAllowed(req); allowedEvent(req, req.params.event);
  const fields = {};
  if (req.body.channel !== undefined) {
    if (!['email', 'whatsapp', 'both'].includes(req.body.channel)) throw new Error('Unknown delivery channel');
    fields.channel = req.body.channel;
  }
  if (req.body.templateId !== undefined) {
    if (req.body.templateId !== null && (!mongoose.isValidObjectId(req.body.templateId) || !await EmailTemplate.exists({ _id: req.body.templateId, event: req.params.event }))) throw new Error('Choose a template for this action');
    fields.templateId = req.body.templateId;
  }
  if (!Object.keys(fields).length) throw new Error('Choose a channel or template');
  const key = { actor: req.userId, application: req.emailApplication, event: req.params.event };
  let saved;
  try { saved = await EmailReviewPreference.findOneAndUpdate(key, { $set: fields }, { upsert: true, new: true, runValidators: true }).lean(); }
  catch (error) { if (error.code !== 11000) throw error; saved = await EmailReviewPreference.findOneAndUpdate(key, { $set: fields }, { new: true, runValidators: true }).lean(); }
  res.json({ success: true, data: { channel: saved.channel, templateId: saved.templateId } });
}));
router.patch('/templates/:id', handle(async (req, res) => {
  templateChoiceAllowed(req);
  const current = await EmailTemplate.findById(req.params.id).lean();
  if (!current) throw new Error('Template not found');
  allowedEvent(req, current.event);
  if (current.system) throw new Error('Built-in templates keep their original name');
  if (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.length > 100) throw new Error('Template name is required (up to 100 characters)');
  const updated = await EmailTemplate.findOneAndUpdate({ _id: current._id, ...(req.body.expectedUpdatedAt ? { updatedAt: new Date(req.body.expectedUpdatedAt) } : {}) }, { $set: { name: req.body.name.trim() } }, { new: true, runValidators: true }).lean();
  if (!updated) throw Object.assign(new Error('This template changed elsewhere. Reload it before saving.'), { status: 409 });
  res.json({ success: true, data: templateWithDocs(updated) });
}));
router.delete('/templates/:id', handle(async (req, res) => {
  templateChoiceAllowed(req);
  const current = await EmailTemplate.findById(req.params.id).lean();
  if (!current) throw new Error('Template not found');
  allowedEvent(req, current.event);
  if (current.system) throw new Error('Built-in templates cannot be deleted');
  const isDefault = await EmailPolicy.exists({ event: current.event, defaultTemplate: current._id });
  const replacement = req.body.replacementTemplateId;
  if (isDefault && (!replacement || String(replacement) === String(current._id) || !mongoose.isValidObjectId(replacement) || !await EmailTemplate.exists({ _id: replacement, event: current.event }))) throw new Error('Choose a replacement default for this action before deleting.');
  const deleted = await EmailTemplate.findOneAndDelete({ _id: current._id, ...(req.body.expectedUpdatedAt ? { updatedAt: new Date(req.body.expectedUpdatedAt) } : {}) });
  if (!deleted) throw Object.assign(new Error('This template changed elsewhere. Reload it before deleting.'), { status: 409 });
  if (isDefault) await EmailPolicy.updateOne({ event: current.event, defaultTemplate: current._id }, { $set: { defaultTemplate: replacement } });
  // Keep draft snapshots and audit history intact. Other users fall back on their next review.
  res.json({ success: true, data: { deleted: String(current._id) } });
}));
// Template bodies arrive as the editor's documents (or plain text from older clients).
router.post('/templates', handle(async (req, res) => {
  adminOnly(req);
  // Review saves create a custom copy. The source owns its action; clients cannot move it.
  let event = req.body.event;
  if (req.body.sourceTemplateId !== undefined) {
    const source = mongoose.isValidObjectId(req.body.sourceTemplateId) && await EmailTemplate.findById(req.body.sourceTemplateId).lean();
    if (!source) throw new Error('Source template not found');
    if (event !== undefined && event !== source.event) throw new Error('Choose a template for this action');
    event = source.event;
  }
  allowedEvent(req, event);
  const fields = templateFromEditor(event, req.body);
  validateTemplate(event, fields);
  const created = await EmailTemplate.create({ event, name: fields.name.trim(), subject: fields.subject, text: fields.text });
  res.json({ success: true, data: templateWithDocs(created.toObject()) });
}));
router.put('/templates/:id', handle(async (req, res) => {
  adminOnly(req);
  const current = await EmailTemplate.findById(req.params.id).lean();
  if (!current) throw new Error('Template not found');
  allowedEvent(req, current.event);
  const fields = templateFromEditor(current.event, req.body);
  validateTemplate(current.event, fields);
  const updated = await EmailTemplate.findOneAndUpdate({ _id: current._id, ...(req.body.expectedUpdatedAt ? { updatedAt: new Date(req.body.expectedUpdatedAt) } : {}) }, { $set: { name: fields.name.trim(), subject: fields.subject, text: fields.text } }, { new: true, runValidators: true }).lean();
  if (!updated) throw Object.assign(new Error('This template changed elsewhere. Reload it before saving.'), { status: 409 });
  res.json({ success: true, data: templateWithDocs(updated) });
}));
router.post('/templates/:id/reset', handle(async (req, res) => {
  adminOnly(req);
  const current = await EmailTemplate.findById(req.params.id).select('event').lean();
  if (!current) throw new Error('Template not found');
  allowedEvent(req, current.event);
  res.json({ success: true, data: templateWithDocs(await resetSystemTemplate(req.params.id)) });
}));
router.post('/templates/preview', handle(async (req, res) => {
  adminOnly(req); allowedEvent(req, req.body.event);
  const fields = templateFromEditor(req.body.event, req.body);
  validateContent(fields.subject, fields.text); validateTemplateVariables(req.body.event, fields.subject, fields.text);
  const { values, blocks } = sampleContext(req.body.event);
  const { subject, text, html, plain } = composeTemplate(fields, values, blocks);
  // The same mail as WhatsApp would send it, built by the queue's own function.
  res.json({ success: true, data: { subject, text, html, whatsapp: messageText({ subject, plain }) } });
}));
async function draftReview(req) {
  const draft = await loadDraft(req);
  return require('../helpers/emailReviewData').buildReview(draft, req.emailIsAdmin);
}
router.get('/drafts/:id', handle(async (req, res) => {
  res.json({ success: true, data: await draftReview(req) });
}));
// Send message's first dropdown: the same draft moves to another action, so nothing is left behind in History.
router.post('/drafts/:id/message-type', handle(async (req, res) => {
  adminOnly(req);
  await changeMessageType(req.params.id, req.body.event, req.userId);
  res.json({ success: true, data: await draftReview(req) });
}));
// Two previews: { templateId } fills that template for this mail; { subject, doc } (or text
// from older clients) shows how the reviewer's edited mail will be sent.
router.post('/drafts/:id/preview', handle(async (req, res) => {
  const draft = await loadDraft(req);
  if (draft.status !== 'pending') throw new Error('The first send attempt locks the reviewed content');
  if (req.body.doc || typeof req.body.text === 'string') {
    const text = reviewTextFromEditor(draft.event, req.body, draft.values, draft.blocks);
    const subject = reviewSubjectFromEditor(draft.event, req.body, draft.values);
    validateContent(subject, text);
    return res.json({ success: true, data: { subject, html: reviewedMail(draft, withRequiredLinks(text, draft.requiredLinks, draft.values)).html } });
  }
  templateChoiceAllowed(req);
  const template = await resolveTemplate(draft.event, req.body.templateId);
  const mail = composeTemplate(template, draft.values || {}, draft.blocks, draft.requiredLinks);
  const { doc } = reviewWithDoc(draft.event, mail.text, draft.values, draft.blocks);
  res.json({ success: true, data: { subject: mail.subject, text: mail.text, doc, html: reviewedMail(draft, mail.text).html, ...await editableReview(draft, template) } });
}));
router.post('/drafts/:id/decision', handle(async (req, res) => {
  if (req.body.templateId !== undefined && req.body.templateId !== 'current') templateChoiceAllowed(req);
  if (req.body.doc && req.body.choice === 'send') {
    const draft = await loadDraft(req);
    req.body.text = reviewTextFromEditor(draft.event, req.body, draft.values, draft.blocks);
    req.body.subject = reviewSubjectFromEditor(draft.event, req.body, draft.values);
  }
  res.json({ success: true, data: await decide(req.params.id, req.userId, req.body, req.emailAccess) });
}));
router.post('/lead-preview', handle(async (req, res) => {
  adminOnly(req); allowedEvent(req, 'lead.created');
  const name = String(req.body.name || 'Customer').slice(0, 200);
  const mail = await applyDefault('lead.created', {}, { name });
  if (!mail) return res.json({ success: true, data: null });
  const draft = { to: req.body.email ? [String(req.body.email)] : [], whatsappTo: require('../helpers/whatsappQueue').normalizePhone(req.body.phone), subject: mail.subject, text: mail.text,
    event: 'lead.created', sourceTemplateId: mail.sourceTemplateId, values: { name }, blocks: {} };
  const channels = await availability(draft);
  res.json({ success: true, data: { ...draft, ...reviewWithDoc(draft.event, mail.text, draft.values, {}),
    ...await editableReview(draft), templateOptions: await templateOptions(draft.event), channelOptions: channels.choices, defaultChannel: channels.defaultChannel } });
}));
// Unsaved Add Lead and the existing phone-only proposal popup share original-template selection.
// This endpoint only previews; final sending re-derives values/contacts from the saved business record.
router.post('/review-preview', handle(async (req, res) => {
  adminOnly(req); allowedEvent(req, req.body.event);
  if (!['lead.created', 'lead.proposal'].includes(req.body.event)) throw new Error('Use the saved draft preview for this action.');
  const template = await resolveTemplate(req.body.event, req.body.templateId);
  const draft = { event: req.body.event, values: req.body.values || {}, blocks: {} };
  const mail = composeTemplate(req.body.doc ? { ...template, ...templateFromEditor(draft.event, { ...req.body, name: template.name }) } : template, draft.values, {});
  res.json({ success: true, data: { ...mail, ...await editableReview(draft, template) } });
}));
module.exports = router;
