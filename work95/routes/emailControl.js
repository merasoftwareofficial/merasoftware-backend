const express = require('express');
const mongoose = require('mongoose');
const authToken = require('../middleware/authToken');
const userModel = require('../models/userModel');
const { EmailTemplate, EmailPolicy, EmailDraft } = require('../models/emailControlModel');
const { events, byKey } = require('../helpers/emailCatalog');
const { decide, applyDefault, validateContent } = require('../helpers/emailController');
const router = express.Router();
router.use(authToken);
router.use(async (req, res, next) => {
  try {
    const user = await userModel.findById(req.userId).select('roles isGuest isActive').lean();
    const ownDraftRoute = /^\/drafts\/[a-f\d]{24}(\/decision)?$/i.test(req.path);
    if (!user || user.isGuest || user.isActive === false || (!ownDraftRoute && !user.roles?.includes('admin'))) return res.status(403).json({ success: false, message: 'Admin access required for email settings' });
    next();
  } catch { res.status(503).json({ success: false, message: 'Could not verify email access' }); }
});
const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
};
router.post('/website-drafts', handle(async (req, res) => {
  const { event, to, subject, text, headers } = req.body;
  if (!['website.subscription.confirm', 'website.subscription.manage'].includes(event)) throw new Error('Unknown website email action');
  validateContent(subject, text);
  const { queueMail } = require('../helpers/emailController');
  const result = await queueMail(event, { to, subject, text, headers });
  res.json({ success: true, data: { queued: !!result.queued, sent: false } });
}));
router.get('/', handle(async (req, res) => {
  const [policies, templates, drafts] = await Promise.all([
    EmailPolicy.find().lean(), EmailTemplate.find().sort({ name: 1 }).lean(),
    EmailDraft.find({ actor: req.userId, status: { $ne: 'staged' }, expiresAt: { $gt: new Date() } }).select('-html -attachments.content -headers').sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  res.json({ success: true, data: { events, policies, templates, drafts, automaticSending: false } });
}));
router.put('/policies/:event', handle(async (req, res) => {
  const event = req.params.event;
  if (!byKey.has(event) || !['review', 'off'].includes(req.body.mode)) throw new Error('Invalid action or mode');
  const defaultTemplate = req.body.defaultTemplate || null;
  if (defaultTemplate && (!mongoose.isValidObjectId(defaultTemplate) || !await EmailTemplate.exists({ _id: defaultTemplate, event }))) throw new Error('Choose a template for this action');
  await EmailPolicy.findOneAndUpdate({ event }, { $set: { mode: req.body.mode, defaultTemplate } }, { upsert: true, runValidators: true });
  res.json({ success: true });
}));
router.post('/templates', handle(async (req, res) => {
  const { event, name, subject, text } = req.body;
  if (!byKey.has(event) || typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Choose an action and a template name (up to 100 characters)');
  validateContent(subject, text);
  const template = await EmailTemplate.create({ event, name: name.trim(), subject, text });
  res.json({ success: true, data: template });
}));
router.put('/templates/:id', handle(async (req, res) => {
  validateContent(req.body.subject, req.body.text);
  if (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.length > 100) throw new Error('Template name is required (up to 100 characters)');
  const template = await EmailTemplate.findByIdAndUpdate(req.params.id, { $set: { name: req.body.name.trim(), subject: req.body.subject, text: req.body.text } }, { new: true, runValidators: true });
  if (!template) throw new Error('Template not found');
  res.json({ success: true, data: template });
}));
router.get('/drafts/:id', handle(async (req, res) => {
  const draft = await EmailDraft.findOne({ _id: req.params.id, actor: req.userId, status: { $ne: 'staged' }, expiresAt: { $gt: new Date() } }).select('-html -attachments.content -headers').lean();
  if (!draft) throw new Error('Draft unavailable');
  res.json({ success: true, data: draft });
}));
router.post('/drafts/:id/decision', handle(async (req, res) => {
  res.json({ success: true, data: await decide(req.params.id, req.userId, req.body) });
}));
router.post('/lead-preview', handle(async (req, res) => {
  const name = String(req.body.name || 'Customer').slice(0, 200);
  const mail = await applyDefault('lead.created', { subject: 'Welcome to Mera Software', text: `Hello ${name},\n\nThank you for connecting with Mera Software. Our team will contact you to discuss your requirements.\n\nMera Software Team` }, { name });
  res.json({ success: true, data: mail && { to: [String(req.body.email || '')], subject: mail.subject, text: mail.text, event: 'lead.created' } });
}));
module.exports = router;
