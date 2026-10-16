const express = require('express');
const mongoose = require('mongoose');
const authToken = require('../middleware/authToken');
const userModel = require('../models/userModel');
const { EmailTemplate, EmailPolicy, EmailDraft, EmailHistory } = require('../models/emailControlModel');
const { events, byKey } = require('../helpers/emailCatalog');
const { decide, applyDefault, validateContent, applicationQuery, draftAccess, render, plainText, withRequiredLinks } = require('../helpers/emailController');
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
      req.emailAccess = { application: 'website', websiteAdmin: req.emailBridgeAccess === 'admin', validatedWebsite: req.emailBridgeAccess === 'admin' };
      return next();
    }
    const user = await userModel.findById(req.userId).select('roles isGuest isActive').lean();
    const ownDraftRoute = /^\/drafts\/[a-f\d]{24}(\/(decision|preview))?$/i.test(req.path);
    if (!user || user.isGuest || user.isActive === false || (!ownDraftRoute && !user.roles?.includes('admin'))) return res.status(403).json({ success: false, message: 'Admin access required for email settings' });
    const application = req.query.application || 'portal';
    if (!['portal', 'website'].includes(application)) throw new Error('Unknown application');
    req.emailApplication = application;
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
async function loadDraft(req) {
  const draft = await EmailDraft.findOne({ _id: req.params.id, ...draftAccess(req.userId, req.emailAccess), status: { $ne: 'staged' }, expiresAt: { $gt: new Date() } }).select('-html -attachments.content -headers').lean();
  if (!draft) throw new Error('Draft unavailable');
  return draft;
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
  const [policies, templates, drafts, history] = await Promise.all([
    EmailPolicy.find(eventFilter).lean(), EmailTemplate.find(eventFilter).sort({ name: 1 }).lean(),
    EmailDraft.find({ ...ownership, status: { $ne: 'staged' }, expiresAt: { $gt: new Date() } }).select('-html -attachments.content -headers').sort({ createdAt: -1 }).limit(100).lean(),
    EmailHistory.find(ownership).sort({ updatedAt: -1 }).limit(100).lean(),
  ]);
  res.json({ success: true, data: { application: req.emailApplication, events: events.filter(e => e.application === req.emailApplication), policies, templates, drafts, history, automaticSending: false, serverNow: Date.now() } });
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
function validateTemplate(body) {
  validateContent(body.subject, body.text);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw new Error('Template name is required (up to 100 characters)');
}
router.post('/templates', handle(async (req, res) => {
  adminOnly(req); allowedEvent(req, req.body.event); validateTemplate(req.body);
  const { event, name, subject, text } = req.body;
  res.json({ success: true, data: await EmailTemplate.create({ event, name: name.trim(), subject, text }) });
}));
router.put('/templates/:id', handle(async (req, res) => {
  adminOnly(req); validateTemplate(req.body);
  const current = await EmailTemplate.findById(req.params.id).lean();
  if (!current) throw new Error('Template not found');
  allowedEvent(req, current.event);
  const { name, subject, text } = req.body;
  res.json({ success: true, data: await EmailTemplate.findByIdAndUpdate(current._id, { $set: { name: name.trim(), subject, text } }, { new: true, runValidators: true }) });
}));
router.post('/templates/preview', handle(async (req, res) => {
  adminOnly(req); allowedEvent(req, req.body.event); validateContent(req.body.subject, req.body.text);
  const context = { subject: 'Sample subject', message: 'Sample action message', name: 'Sample customer' };
  res.json({ success: true, data: { subject: render(req.body.subject, context), text: render(req.body.text, context) } });
}));
router.get('/drafts/:id', handle(async (req, res) => {
  res.json({ success: true, data: await loadDraft(req) });
}));
router.post('/drafts/:id/preview', handle(async (req, res) => {
  const draft = await loadDraft(req);
  if (draft.status !== 'pending') throw new Error('The first send attempt locks the reviewed content');
  const values = { subject: draft.baseSubject || draft.subject, message: draft.baseText || draft.text, ...(draft.values || {}) };
  const template = req.body.templateId ? await EmailTemplate.findOne({ _id: req.body.templateId, event: draft.event }).lean() : null;
  if (req.body.templateId && !template) throw new Error('Choose a template for this action');
  res.json({ success: true, data: { subject: template ? render(template.subject, values) : values.subject, text: withRequiredLinks(template ? render(template.text, values) : values.message, draft.requiredLinks) } });
}));
router.post('/drafts/:id/decision', handle(async (req, res) => {
  res.json({ success: true, data: await decide(req.params.id, req.userId, req.body, req.emailAccess) });
}));
router.post('/lead-preview', handle(async (req, res) => {
  adminOnly(req); allowedEvent(req, 'lead.created');
  const name = String(req.body.name || 'Customer').slice(0, 200);
  const mail = await applyDefault('lead.created', { subject: 'Welcome to Mera Software', text: `Hello ${name},\n\nThank you for connecting with Mera Software. Our team will contact you to discuss your requirements.\n\nMera Software Team` }, { name });
  res.json({ success: true, data: mail && { to: [String(req.body.email || '')], subject: mail.subject, text: mail.text, event: 'lead.created' } });
}));
module.exports = router;
