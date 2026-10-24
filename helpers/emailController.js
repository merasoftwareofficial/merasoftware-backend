const { AsyncLocalStorage } = require('node:async_hooks');
const { EmailDraft, EmailTemplate, EmailPolicy, EmailHistory } = require('../models/emailControlModel');
const { byKey, eventKeys, isCustomerTriggered, customerEventKeys } = require('./emailCatalog');
const userModel = require('../models/userModel');
const { render, compose, withRequiredLinks } = require('./emailMarkup');
const { resolveTemplate, systemTemplate, composeTemplate, REVIEWED_NAME } = require('./emailTemplates');
const { enqueueWhatsAppForEmail } = require('./whatsappQueue');
const requestScope = new AsyncLocalStorage();
const eventScope = new AsyncLocalStorage();
const suppressed = () => ({ data: null, error: null, suppressed: true });
function plainText(html = '') {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)').replace(/<\/(p|div|h[1-6]|tr)>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
function applicationQuery(application) {
  return { event: { $in: eventKeys(application) } };
}
// An action's user reviews its own mail, except customer-started mail: only admins may retry it.
function draftAccess(actor, access = {}) {
  if (access.application === 'website' && access.websiteAdmin) return applicationQuery('website');
  if (access.application === 'portal' && access.portalAdmin) return applicationQuery('portal');
  const own = { actor, event: { $nin: customerEventKeys } };
  return access.application ? { $and: [own, applicationQuery(access.application)] } : own;
}
async function recordHistory(draft, decidedBy, required = false) {
  try {
    await EmailHistory.updateOne({ draftId: draft._id }, { $set: {
      application: byKey.get(draft.event).application, event: draft.event, actor: draft.actor,
      ...(draft.dedupeKey ? { dedupeKey: draft.dedupeKey } : {}),
      ...(decidedBy ? { decidedBy } : {}), to: draft.to, subject: draft.subject, status: draft.status,
      providerId: draft.providerId, failure: draft.failure, expiresAt: draft.expiresAt, sentAt: draft.sentAt,
      source: draft.source, sender: draft.sender, templateName: draft.templateName,
      attemptCount: draft.attemptCount, lastAttemptAt: draft.lastAttemptAt, attempts: draft.attempts,
    } }, { upsert: true });
  } catch (error) {
    console.error('[email] Could not record email history:', error.message);
    if (required) throw error;
  }
}
// The action's default template, or its built-in system template, filled with the action's values.
async function applyDefault(event, mail, values = {}) {
  const policy = await EmailPolicy.findOne({ event }).lean();
  // Customer-started mail exists only while its action is On; it is Off until an admin turns it on.
  if (policy?.mode === 'off' || (isCustomerTriggered(event) && policy?.mode !== 'auto')) return null;
  // The lead form's mail is reviewed before the lead is saved: its text is final, never re-templated.
  if (mail.reviewed) {
    const text = render(mail.text, values, mail.blocks);
    const final = compose(text, mail.blocks);
    return { ...mail, text, plain: final.text, html: final.html };
  }
  const chosen = policy?.defaultTemplate && await EmailTemplate.findOne({ _id: policy.defaultTemplate, event }).lean();
  const template = chosen || await systemTemplate(event);
  if (!template) throw new Error(`No email template for ${event}`);
  return { ...mail, ...composeTemplate(template, values, mail.blocks, mail.requiredLinks) };
}
/**
 * What a reviewed text sends. Unchanged text keeps the prepared mail; edited text is filled
 * with this mail's own values (so a reviewer may use the same {{variables}}) and rendered.
 */
function reviewedMail(draft, text) {
  if (text === draft.text) return { text, html: draft.html, plain: draft.plain || draft.text };
  const filled = render(text, draft.values, draft.blocks);
  const mail = compose(filled, draft.blocks);
  return { text: filled, html: mail.html, plain: mail.text };
}
function validateContent(subject, text) {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 300 || /[\r\n]/.test(subject)) throw new Error('Subject must be 1–300 characters on one line');
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('Message must be 1–100000 characters');
}
async function prepareMail(event, mail, extraValues) {
  const scope = requestScope.getStore();
  // Background jobs, cron, anonymous requests and old unintegrated callers fail closed.
  if (!scope || scope.closed || !byKey.has(event)) return suppressed();
  // Only events the catalog registers as system-triggered may send from a background scope.
  if (scope.system && byKey.get(event).trigger !== 'system') return suppressed();
  const publicIntake = scope.req.emailBridgeAccess === 'intake';
  if (publicIntake && !['website.subscription.confirm', 'website.subscription.manage'].includes(event)) return suppressed();
  if (!publicIntake && !scope.system) {
    if (!scope.req.userId) return suppressed();
    const actor = await userModel.findById(scope.req.userId).select('isGuest isActive').lean();
    if (!actor || actor.isGuest || actor.isActive === false) return suppressed();
  }
  // Builders send their data as values/blocks; the lead form adds its own values.
  const values = { ...(mail.values || {}), ...(extraValues || {}) };
  const content = await applyDefault(event, mail, values);
  if (!content) return suppressed();
  const to = (Array.isArray(content.to) ? content.to : [content.to]).filter(Boolean);
  if (!to.length || to.some(address => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))) return suppressed();
  validateContent(content.subject, content.text);
  if (mail.dedupeKey) {
    if (scope.system) {
      const permanent = await EmailHistory.findOne({ dedupeKey: mail.dedupeKey }).lean();
      if (permanent) return { data: null, error: null, queued: true, draftId: String(permanent.draftId) };
    }
    const previous = await EmailDraft.findOne({ dedupeKey: mail.dedupeKey }).lean();
    if (previous) return { data: null, error: null, queued: true, draftId: String(previous._id) };
  }
  let draft;
  try { draft = await EmailDraft.create({
    event, actor: scope.req.userId, source: `${scope.req.method} ${scope.req.originalUrl.split('?')[0]}`,
    application: byKey.get(event).application, dedupeKey: mail.dedupeKey,
    reference: mail.reference, requiredLinks: mail.requiredLinks,
    baseSubject: mail.subject, baseText: mail.text || plainText(mail.html), values, blocks: mail.blocks,
    to, subject: content.subject, text: content.text, plain: content.plain,
    html: content.html || compose(content.text, mail.blocks).html,
    templateName: content.templateName || REVIEWED_NAME,
    attachments: (content.attachments || []).map(a => ({ filename: a.filename, content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content })),
    headers: content.headers,
    reminderInvoice: content.reminderInvoice,
    expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
  }); } catch (error) {
    if (error.code !== 11000 || !mail.dedupeKey) throw error;
    const previous = await EmailDraft.findOne({ dedupeKey: mail.dedupeKey }).lean();
    if (!previous) throw error;
    return { data: null, error: null, queued: true, draftId: String(previous._id) };
  }
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
      const drafts = await EmailDraft.find({ _id: { $in: scope.ids } });
      for (const draft of drafts) await recordHistory(draft);
      // Customer-started mail never opens a popup; it sends once the response has gone.
      const automatic = drafts.filter(draft => isCustomerTriggered(draft.event));
      const reviewIds = scope.ids.filter(id => !automatic.some(draft => draft._id.equals(id))).map(String);
      if (automatic.length) res.once('finish', () => { sendAutomatic(automatic); });
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
      return json(reviewIds.length ? { ...body, emailDraftIds: reviewIds, emailStatus: 'awaiting-review' } : body);
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
/**
 * Sends customer-started mail through the same decide() as a reviewed send. A failed send
 * stays in Email Control's review list for an admin to retry.
 */
async function sendAutomatic(drafts) {
  for (const draft of drafts) {
    try {
      await decide(String(draft._id), null, { choice: 'send', subject: draft.subject, text: draft.text }, { application: draft.application, portalAdmin: true, websiteAdmin: true });
    } catch (error) {
      console.error(`[email] Automatic ${draft.event} mail was not sent; it waits in Email Control:`, error.message);
    }
  }
}
// This is the ONLY provider call. Content is locked on the first send attempt;
// retries reuse the same Resend idempotency key and identical payload.
async function decide(id, actor, decision, access = {}) {
  if (!['send', 'skip'].includes(decision.choice)) throw new Error('Choose Send Mail or Don’t Send Mail');
  const query = { _id: id, ...draftAccess(actor, access), expiresAt: { $gt: new Date() } };
  if (decision.choice === 'skip') {
    const draft = await EmailDraft.findOneAndUpdate({ ...query, status: { $in: ['pending', 'failed'] } }, { $set: { status: 'skipped' } }, { new: true });
    if (!draft) throw new Error('Draft is unavailable or has already been decided');
    await recordHistory(draft, actor);
    return { status: draft.status };
  }
  validateContent(decision.subject, decision.text);
  const policyDraft = await EmailDraft.findOne(query).lean();
  if (!policyDraft) throw new Error('Draft is unavailable');
  if (policyDraft.event.startsWith('website.subscription.') && !access.validatedWebsite) throw new Error('Review this subscription email from the website panel');
  const policy = await EmailPolicy.findOne({ event: policyDraft.event }).lean();
  if (policy?.mode === 'off') throw new Error('Email for this action is disabled');
  const text = withRequiredLinks(decision.text, policyDraft.requiredLinks);
  let templateName = policyDraft.templateName;
  if (policyDraft.status === 'pending' && decision.templateId !== undefined && decision.templateId !== 'current') {
    templateName = (await resolveTemplate(policyDraft.event, decision.templateId)).name;
  }
  const update = policyDraft.status === 'failed'
    ? { status: 'sending', failure: '' }
    : { status: 'sending', subject: decision.subject.trim(), text, ...reviewedMail(policyDraft, text), failure: '' };
  const attemptedAt = new Date();
  const sender = policyDraft.sender || `${process.env.FROM_NAME || 'Mera Software'} <${process.env.FROM_EMAIL}>`;
  const draft = await EmailDraft.findOneAndUpdate({ ...query, status: { $in: ['pending', 'failed'] } }, {
    $set: { ...update, sender, templateName, lastAttemptAt: attemptedAt },
    $inc: { attemptCount: 1 }, $push: { attempts: { at: attemptedAt, status: 'sending' } },
  }, { new: true });
  if (!draft) throw new Error('Draft has already been decided or is being sent');
  let accepted = false;
  try {
    // Do not contact the provider unless a durable attempt exists first.
    await recordHistory(draft, actor, true);
    if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) throw new Error('Email provider is not configured');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `email-draft-${draft._id}` },
      body: JSON.stringify({ from: draft.sender, to: draft.to, subject: draft.subject, text: draft.plain || draft.text, html: draft.html, attachments: draft.attachments.map(a => ({ filename: a.filename, content: a.content })), headers: Object.fromEntries(draft.headers || []) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error('Email provider refused the message');
    if (!result.id) throw new Error('Email provider did not return a message ID');
    accepted = true;
    draft.status = 'sent'; draft.providerId = result.id; draft.sentAt = new Date();
    draft.attempts[draft.attempts.length - 1].status = 'sent';
    // Persist both copies independently. A post-acceptance database error must
    // never turn an accepted mail into a retryable failure.
    const writes = await Promise.allSettled([
      recordHistory(draft, actor, true),
      EmailDraft.updateOne({ _id: draft._id }, { $set: { status: 'sent', providerId: draft.providerId, sentAt: draft.sentAt, attempts: draft.attempts } }),
    ]);
    if (writes.every(write => write.status === 'rejected')) throw new Error('Provider accepted mail; recording its result needs recovery. Do not resend.');
    // The same message goes out on WhatsApp. Not awaited: it can never delay or change this mail's result.
    enqueueWhatsAppForEmail(draft).catch(error => console.error('[whatsapp] Could not queue this email for WhatsApp:', error.message));
    if (draft.reminderInvoice) {
      try {
        await require('../models/monthlyInvoiceModel').updateOne({ _id: draft.reminderInvoice }, { $inc: { remindersSent: 1 }, $set: { lastReminderDate: new Date() } });
      } catch (error) { console.error('[email] Delivered reminder; could not update invoice counters:', error.message); }
    }
    return { status: 'sent', sentAt: draft.sentAt, event: draft.event, reference: draft.reference };
  } catch (error) {
    if (accepted) throw error;
    draft.status = 'failed'; draft.failure = error.message;
    draft.attempts[draft.attempts.length - 1].status = 'failed';
    draft.attempts[draft.attempts.length - 1].failure = error.message;
    await EmailDraft.updateOne({ _id: draft._id }, { $set: { status: 'failed', failure: error.message, attempts: draft.attempts } });
    await recordHistory(draft, actor);
    throw error;
  }
}
// Only this named event is allowed outside a user request. Explicit offer
// reminder settings opt it in; all existing background builders stay suppressed.
async function sendScheduledOfferReminder(invoice, customer, offset) {
  const event = 'offer.payment.reminder';
  const mail = require('./emailTemplates').buildTemplatedMail(event,
    { ...invoice.toObject?.() || invoice, userId: customer, amount: Math.max(0, invoice.amount - Number(invoice.amountPaid || 0)) },
    'Your agreed offer payment is pending. Please pay the outstanding amount.');
  if (!mail) return;
  mail.dedupeKey = `offer-reminder:${invoice._id}:${offset}`;
  const scope = { system: true, closed: false, ids: [], req: { method: 'CRON', originalUrl: '/offer-payment-reminders', userId: null } };
  const result = await requestScope.run(scope, () => queueMail(event, mail));
  if (!result.draftId) return;
  const draft = await EmailDraft.findOneAndUpdate({ _id: result.draftId, status: 'staged' }, { $set: { status: 'pending' } }, { new: true }) || await EmailDraft.findById(result.draftId);
  if (!draft || ['sent', 'sending', 'skipped'].includes(draft.status) || draft.expiresAt <= new Date()) return;
  await recordHistory(draft, null, true);
  // Re-read money immediately before sending; never remind a settled/cancelled bill.
  const fresh = await require('../models/invoiceModel').findById(invoice._id).lean();
  const order = fresh && await require('../models/orderProductModel').findById(fresh.orderId).select('orderVisibility servicePlanStatus').lean();
  if (!fresh || !['unpaid', 'partially_paid', 'overdue'].includes(fresh.status) || !order || order.orderVisibility === 'cancelled') return;
  return decide(String(draft._id), null, { choice: 'send', subject: draft.subject, text: draft.text }, { application: 'portal', portalAdmin: true });
}
async function sendReservationConfirmation(reservation, user) {
  return sendReservationMail('offer.reserved', reservation, user, `offer-reserved:${reservation._id}`);
}
// One durable path for reservation mail (confirmation, extension); dedupeKey makes a retry safe.
async function sendReservationMail(event, reservation, user, dedupeKey) {
  const history = await EmailHistory.findOne({ dedupeKey }).lean();
  if (history?.status === 'sent') return 'sent';
  const mail = require('./emailTemplates').buildTemplatedMail(event, reservation, user);
  if (!mail) throw new Error('Reservation mail website URL or recipient is unavailable');
  mail.dedupeKey = dedupeKey;
  const scope = { system: true, closed: false, ids: [], req: { method: 'SYSTEM', originalUrl: '/offer-reservations', userId: null } };
  const result = await requestScope.run(scope, () => queueMail(event, mail));
  if (!result.draftId) return 'paused';
  const draft = await EmailDraft.findOneAndUpdate({ _id: result.draftId, status: 'staged' }, { $set: { status: 'pending' } }, { new: true }) || await EmailDraft.findById(result.draftId);
  if (draft?.status === 'sent') return 'sent';
  if (!draft || draft.expiresAt <= new Date() || draft.status === 'skipped') return 'expired';
  if (draft.status === 'sending') throw new Error('Confirmation delivery is awaiting reconciliation');
  await recordHistory(draft, null, true);
  const decision = await decide(String(draft._id), null, { choice: 'send', subject: draft.subject, text: draft.text }, { application: 'portal', portalAdmin: true });
  return decision.status === 'sent' ? 'sent' : 'paused';
}
module.exports = { queueMail, reviewTransport, withEvent, requestMiddleware, decide, applyDefault, reviewedMail, plainText, validateContent, applicationQuery, draftAccess, sendScheduledOfferReminder, sendReservationConfirmation, sendReservationMail };
