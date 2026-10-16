const { AsyncLocalStorage } = require('node:async_hooks');
const { EmailDraft, EmailTemplate, EmailPolicy } = require('../models/emailControlModel');
const { byKey } = require('./emailCatalog');
const userModel = require('../models/userModel');
const requestScope = new AsyncLocalStorage();
const eventScope = new AsyncLocalStorage();
const suppressed = () => ({ data: null, error: null, suppressed: true });
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const textHtml = text => `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>`;
function plainText(html = '') {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)').replace(/<\/(p|div|h[1-6]|tr)>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
function render(template, values) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(values[key] ?? ''));
}
async function applyDefault(event, mail, values = {}) {
  const policy = await EmailPolicy.findOne({ event }).lean();
  if (policy?.mode === 'off') return null;
  const template = policy?.defaultTemplate && await EmailTemplate.findOne({ _id: policy.defaultTemplate, event }).lean();
  const context = { subject: mail.subject, message: mail.text || plainText(mail.html), ...values };
  if (!template) return { ...mail, text: context.message };
  const text = render(template.text, context);
  return { ...mail, subject: render(template.subject, context), text, html: textHtml(text) };
}
function validateContent(subject, text) {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 300 || /[\r\n]/.test(subject)) throw new Error('Subject must be 1–300 characters on one line');
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('Message must be 1–100000 characters');
}
async function prepareMail(event, mail, values) {
  const scope = requestScope.getStore();
  // Background jobs, cron, anonymous requests and old unintegrated callers fail closed.
  if (!scope || scope.closed || !scope.req.userId || !byKey.has(event)) return suppressed();
  const actor = await userModel.findById(scope.req.userId).select('isGuest isActive').lean();
  if (!actor || actor.isGuest || actor.isActive === false) return suppressed();
  const content = await applyDefault(event, mail, values);
  if (!content) return suppressed();
  const to = (Array.isArray(content.to) ? content.to : [content.to]).filter(Boolean);
  if (!to.length || to.some(address => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))) return suppressed();
  validateContent(content.subject, content.text);
  const draft = await EmailDraft.create({
    event, actor: scope.req.userId, source: `${scope.req.method} ${scope.req.originalUrl.split('?')[0]}`,
    to, subject: content.subject, text: content.text, html: content.html || textHtml(content.text),
    attachments: (content.attachments || []).map(a => ({ filename: a.filename, content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content })),
    headers: content.headers,
    reminderInvoice: content.reminderInvoice,
    expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
  });
  if (scope.closed) { await EmailDraft.deleteOne({ _id: draft._id }); return suppressed(); }
  scope.ids.push(draft._id);
  return { data: null, error: null, queued: true, draftId: String(draft._id) };
}
async function queueMail(event, mail, values) {
  try { return await prepareMail(event, mail, values); }
  catch (error) {
    const scope = requestScope.getStore();
    if (scope && !scope.closed) scope.req.emailPreparationFailed = true;
    throw error;
  }
}
const reviewTransport = { emails: { send: mail => queueMail(eventScope.getStore(), mail) } };
function withEvent(event, builder) {
  return (...args) => requestScope.getStore() && !requestScope.getStore().closed
    ? eventScope.run(event, () => builder(...args)) : Promise.resolve(false);
}
function requestMiddleware(req, res, next) {
  const scope = { req, ids: [], closed: false };
  const json = res.json.bind(res);
  res.json = function(body) {
    scope.closed = true;
    const success = res.statusCode < 400 && body?.success === true;
    const finish = async () => {
      if (!scope.ids.length) return json(req.emailPreparationFailed ? { ...body, emailStatus: 'unavailable' } : body);
      if (!success) {
        await EmailDraft.deleteMany({ _id: { $in: scope.ids }, status: 'staged' });
        return json(body);
      }
      await EmailDraft.updateMany({ _id: { $in: scope.ids }, status: 'staged' }, { $set: { status: 'pending' } });
      if (req.body?.emailReview?.choice === 'send' && scope.ids.length === 1) {
        const leadDraft = await EmailDraft.findOne({ _id: scope.ids[0], event: 'lead.created' }).lean();
        if (leadDraft) {
          try {
            const result = await decide(String(leadDraft._id), req.userId, req.body.emailReview);
            return json({ ...body, emailStatus: result.status });
          } catch {
            return json({ ...body, emailStatus: 'failed', emailDraftIds: scope.ids.map(String) });
          }
        }
      }
      return json({ ...body, emailDraftIds: scope.ids.map(String), emailStatus: 'awaiting-review' });
    };
    finish().catch(error => {
      console.error('[email] Could not finalize review drafts:', error.message);
      if (!res.headersSent) json({ ...body, emailStatus: 'unavailable' });
    });
    return res;
  };
  res.on('finish', () => { scope.closed = true; });
  requestScope.run(scope, next);
}
// This is the ONLY provider call. Content is locked on the first send attempt;
// retries reuse the same Resend idempotency key and identical payload.
async function decide(id, actor, decision) {
  if (!['send', 'skip'].includes(decision.choice)) throw new Error('Choose Send Mail or Don’t Send Mail');
  const query = { _id: id, actor, expiresAt: { $gt: new Date() } };
  if (decision.choice === 'skip') {
    const draft = await EmailDraft.findOneAndUpdate({ ...query, status: { $in: ['pending', 'failed'] } }, { $set: { status: 'skipped' } }, { new: true });
    if (!draft) throw new Error('Draft is unavailable or has already been decided');
    return { status: draft.status };
  }
  validateContent(decision.subject, decision.text);
  const policyDraft = await EmailDraft.findOne(query).lean();
  if (!policyDraft) throw new Error('Draft is unavailable');
  const policy = await EmailPolicy.findOne({ event: policyDraft.event }).lean();
  if (policy?.mode === 'off') throw new Error('Email for this action is disabled');
  const update = policyDraft.status === 'failed'
    ? { status: 'sending', failure: '' }
    : { status: 'sending', subject: decision.subject.trim(), text: decision.text, html: textHtml(decision.text), failure: '' };
  const draft = await EmailDraft.findOneAndUpdate({ ...query, status: { $in: ['pending', 'failed'] } }, { $set: update }, { new: true });
  if (!draft) throw new Error('Draft has already been decided or is being sent');
  try {
    if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) throw new Error('Email provider is not configured');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `email-draft-${draft._id}` },
      body: JSON.stringify({ from: `${process.env.FROM_NAME || 'Mera Software'} <${process.env.FROM_EMAIL}>`, to: draft.to, subject: draft.subject, text: draft.text, html: draft.html, attachments: draft.attachments.map(a => ({ filename: a.filename, content: a.content })), headers: Object.fromEntries(draft.headers || []) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error('Email provider refused the message');
    await EmailDraft.updateOne({ _id: draft._id }, { $set: { status: 'sent', providerId: result.id, sentAt: new Date() } });
    if (draft.reminderInvoice) {
      try {
        await require('../models/monthlyInvoiceModel').updateOne({ _id: draft.reminderInvoice }, { $inc: { remindersSent: 1 }, $set: { lastReminderDate: new Date() } });
      } catch (error) { console.error('[email] Delivered reminder; could not update invoice counters:', error.message); }
    }
    return { status: 'sent' };
  } catch (error) {
    await EmailDraft.updateOne({ _id: draft._id }, { $set: { status: 'failed', failure: error.message } });
    throw error;
  }
}
module.exports = { queueMail, reviewTransport, withEvent, requestMiddleware, decide, applyDefault, plainText, render, validateContent, textHtml };
