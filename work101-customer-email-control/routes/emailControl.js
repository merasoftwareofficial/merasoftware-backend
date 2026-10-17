const express = require('express');
const mongoose = require('mongoose');
const authToken = require('../middleware/authToken');
const userModel = require('../models/userModel');
const { EmailTemplate, EmailPolicy, EmailDraft, EmailHistory } = require('../models/emailControlModel');
const { events, byKey } = require('../helpers/emailCatalog');
const { decide, applyDefault, reviewedMail, validateContent, applicationQuery, draftAccess } = require('../helpers/emailController');
const { withRequiredLinks } = require('../helpers/emailMarkup');
const { LEGACY_BUILT_IN, hasSystemTemplate, catalogFor, sampleContext, validateTemplateVariables, systemTemplate, ensureSystemTemplates, resolveTemplate, resetSystemTemplate, composeTemplate } = require('../helpers/emailTemplates');
const { verifyWebsiteAccess } = require('../helpers/websiteEmailAccess');
const { queryOutbox, reconcileSent } = require('../helpers/emailOutbox');
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
const draftContext = draft => ({ subject: draft.baseSubject || draft.subject, message: draft.baseText || draft.text, ...(draft.values || {}) });
// The choices a review offers, built-in first. '' is the legacy code-built mail of an action
// that has no system template yet.
async function templateOptions(event) {
  await systemTemplate(event);
  const templates = await EmailTemplate.find({ event }).sort({ system: -1, name: 1 }).select('name system').lean();
  const options = templates.map(row => ({ id: String(row._id), name: row.name, system: !!row.system }));
  return hasSystemTemplate(event) ? options : [{ id: '', name: LEGACY_BUILT_IN, system: true }, ...options];
}
router.post('/website-drafts', handle(async (req, res) => {
  const { event, to, subject, text, headers, requiredLinks, reference, dedupeKey } = req.body;
  if (!['website.subscription.confirm', 'website.subscription.manage'].includes(event)) throw new Error('Unknown website email action');
  validateContent(subject, text);
  // Legacy portal admins can still prepare their own website drafts, but only
  // the website server can submit public requests and validate a send decision.
  const { queueMail } = require('../helpers/emailController');
  const result = await queueMail(event, { to, subject, text, headers, requiredLinks, reference, dedupeKey });
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
  res.json({ success: true, data: { application: req.emailApplication, events: applicationEvents, catalog: catalogFor(applicationEvents), policies, templates, drafts, history, automaticSending: false, serverNow: Date.now() } });
}));
router.get('/outbox', handle(async (req, res) => {
  adminOnly(req);
  const ownership = { ...draftAccess(req.userId, req.emailAccess), application: req.emailApplication };
  res.json({ success: true, data: await queryOutbox(ownership, req.query) });
}));
router.put('/policies/:event', handle(async (req, res) => {
  adminOnly(req); const event = req.params.event; allowedEvent(req, event);
  if (!['review', 'off'].includes(req.body.mode)) throw new Error('Invalid sending rule');
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
router.post('/templates', handle(async (req, res) => {
  adminOnly(req); allowedEvent(req, req.body.event); validateTemplate(req.body.event, req.body);
  const { event, name, subject, text } = req.body;
  res.json({ success: true, data: await EmailTemplate.create({ event, name: name.trim(), subject, text }) });
}));
router.put('/templates/:id', handle(async (req, res) => {
  adminOnly(req);
  const current = await EmailTemplate.findById(req.params.id).lean();
  if (!current) throw new Error('Template not found');
  allowedEvent(req, current.event); validateTemplate(current.event, req.body);
  const { name, subject, text } = req.body;
  res.json({ success: true, data: await EmailTemplate.findByIdAndUpdate(current._id, { $set: { name: name.trim(), subject, text } }, { new: true, runValidators: true }) });
}));
router.post('/templates/:id/reset', handle(async (req, res) => {
  adminOnly(req);
  const current = await EmailTemplate.findById(req.params.id).select('event').lean();
  if (!current) throw new Error('Template not found');
  allowedEvent(req, current.event);
  res.json({ success: true, data: await resetSystemTemplate(req.params.id) });
}));
router.post('/templates/preview', handle(async (req, res) => {
  adminOnly(req); allowedEvent(req, req.body.event); validateContent(req.body.subject, req.body.text);
  validateTemplateVariables(req.body.event, req.body.subject, req.body.text);
  const { values, blocks } = sampleContext(req.body.event);
  const { subject, text, html } = composeTemplate({ subject: req.body.subject, text: req.body.text }, values, blocks);
  res.json({ success: true, data: { subject, text, html } });
}));
router.get('/drafts/:id', handle(async (req, res) => {
  const draft = await loadDraft(req);
  res.json({ success: true, data: req.emailIsAdmin ? { ...draft, templateOptions: await templateOptions(draft.event) } : draft });
}));
// Two previews: { templateId } fills that template for this mail; { subject, text } shows
// how the reviewer's edited text will be sent.
router.post('/drafts/:id/preview', handle(async (req, res) => {
  const draft = await loadDraft(req);
  if (draft.status !== 'pending') throw new Error('The first send attempt locks the reviewed content');
  if (typeof req.body.text === 'string') {
    validateContent(req.body.subject, req.body.text);
    return res.json({ success: true, data: { html: reviewedMail(draft, withRequiredLinks(req.body.text, draft.requiredLinks)).html } });
  }
  templateChoiceAllowed(req);
  const template = await resolveTemplate(draft.event, req.body.templateId);
  const context = draftContext(draft);
  const mail = template
    ? composeTemplate(template, context, draft.blocks, draft.requiredLinks)
    : { subject: context.subject, text: withRequiredLinks(context.message, draft.requiredLinks) };
  res.json({ success: true, data: { subject: mail.subject, text: mail.text, html: reviewedMail(draft, mail.text).html } });
}));
router.post('/drafts/:id/decision', handle(async (req, res) => {
  if (req.body.templateId !== undefined && req.body.templateId !== 'current') templateChoiceAllowed(req);
  res.json({ success: true, data: await decide(req.params.id, req.userId, req.body, req.emailAccess) });
}));
router.post('/lead-preview', handle(async (req, res) => {
  adminOnly(req); allowedEvent(req, 'lead.created');
  const name = String(req.body.name || 'Customer').slice(0, 200);
  const mail = await applyDefault('lead.created', { subject: 'Welcome to Mera Software', text: `Hello ${name},\n\nThank you for connecting with Mera Software. Our team will contact you to discuss your requirements.\n\nMera Software Team` }, { name });
  res.json({ success: true, data: mail && { to: [String(req.body.email || '')], subject: mail.subject, text: mail.text, event: 'lead.created' } });
}));
module.exports = router;
