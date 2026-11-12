const { AsyncLocalStorage } = require('node:async_hooks');
const { EmailDraft, EmailTemplate, EmailPolicy, EmailHistory } = require('../models/emailControlModel');
const { byKey, eventKeys, isCustomerTriggered, isAdminRecipientEvent, customerEventKeys } = require('./emailCatalog');
const userModel = require('../models/userModel');
const { render, compose, withRequiredLinks } = require('./emailMarkup');
const { resolveTemplate, systemTemplate, composeTemplate, REVIEWED_NAME } = require('./emailTemplates');
const { enqueueWhatsAppForEmail } = require('./whatsappQueue');
const requestScope = new AsyncLocalStorage();
const eventScope = new AsyncLocalStorage();
const suppressed = () => ({ data: null, error: null, suppressed: true });
function unregisterReviewDraft(id) {
  const scope = requestScope.getStore();
  if (scope) scope.ids = scope.ids.filter(item => String(item) !== String(id));
}
// Reattach a persisted review after a business request/response interruption.
function registerReviewDraft(draft) {
  const scope = requestScope.getStore();
  if (!scope || scope.closed || !['staged', 'pending', 'failed'].includes(draft.status) || draft.expiresAt <= new Date()) return false;
  if (!scope.ids.some(id => String(id) === String(draft._id))) scope.ids.push(draft._id);
  return true;
}
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
      ...(draft.offerReminderContext ? { offerReminderContext: draft.offerReminderContext } : {}),
      ...(decidedBy ? { decidedBy } : {}), to: draft.to, subject: draft.subject,
      status: draft.delivery?.channels?.length ? (draft.delivery.channels.includes('email') ? (draft.delivery.emailStatus === 'sent' ? 'sent' : draft.status) : (draft.status === 'failed' ? 'skipped' : draft.status)) : draft.status,
      delivery: draft.delivery?.channels?.length ? { channels: draft.delivery.channels, emailStatus: draft.delivery.emailStatus, whatsappStatus: draft.delivery.whatsappStatus, failure: draft.delivery.failure } : undefined,
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
  // A visitor's plan request, sent by the website server (controller/lead/planRequest.js, integration
  // bearer already checked): only that request's own two mails, and only while their action is On.
  const planIntake = scope.req.planRequestIntake === true;
  if (planIntake && !['plan.request.admin', 'plan.request.received'].includes(event)) return suppressed();
  if (!publicIntake && !planIntake && !scope.system) {
    if (!scope.req.userId) return suppressed();
    const actor = await userModel.findById(scope.req.userId).select('isGuest isActive').lean();
    if (!actor || actor.isGuest || actor.isActive === false) return suppressed();
  }
  // Builders send their data as values/blocks; the lead form adds its own values.
  const values = { ...(mail.values || {}), ...(extraValues || {}) };
  const content = await applyDefault(event, mail, values);
  if (!content) return suppressed();
  // Mail to the admins goes where they saved it in Admin → Settings (helpers/teamContacts.js), not to the builder's address.
  const to = isAdminRecipientEvent(event) ? await require('./teamContacts').teamRecipients()
    : (Array.isArray(content.to) ? content.to : [content.to]).filter(Boolean);
  if ((!to.length && !(require('./whatsappQueue').normalizePhone(mail.phone) && process.env.ENABLE_WHATSAPP === 'true')) || to.some(address => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))) return suppressed();
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
    templateName: content.templateName || REVIEWED_NAME, sourceTemplateId: content.sourceTemplateId,
    whatsappTo: require('./whatsappQueue').normalizePhone(mail.phone),
    attachments: (content.attachments || []).map(a => ({ filename: a.filename, content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content })),
    headers: content.headers,
    reminderInvoice: content.reminderInvoice,
    reminderRunId: mail.reminderRunId,
    offerReminderContext: mail.offerReminderContext,
    leadId: mail.leadId,
    orderId: mail.orderId,
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
            // A failed channel send stays in Email Control; its id lets the page offer the retry.
            return json({ ...body, emailStatus: result.status, ...(result.delivery ? { messageDelivery: result.delivery } : {}),
              ...(result.status === 'failed' ? { emailDraftIds: scope.ids.map(String) } : {}) });
          } catch {
            return json({ ...body, emailStatus: 'failed', emailDraftIds: scope.ids.map(String) });
          }
        }
      }
      // Only hydrate a single owned portal lead review; bulk responses remain small.
      let emailReviewDraft;
      if (reviewIds.length === 1) {
        const draft = drafts.find(row => String(row._id) === reviewIds[0]);
        if ((draft?.leadId || draft?.event === 'lead.finalMessage') && String(draft.actor) === String(req.userId)) {
          const user = await userModel.findById(req.userId).select('roles isGuest isActive').lean();
          if (user?.roles?.includes('admin') && !user.isGuest && user.isActive !== false) {
            const safe = draft.toObject();
            delete safe.headers;
            safe.attachments = (safe.attachments || []).map(({ content, ...attachment }) => attachment);
            try { emailReviewDraft = await require('./emailReviewData').buildReview(safe, true); }
            catch { /* The explicit draft endpoint remains the recovery path. */ }
          }
        }
      }
      return json(reviewIds.length ? { ...body, emailDraftIds: reviewIds, emailStatus: 'awaiting-review', ...(emailReviewDraft ? { emailReviewDraft } : {}) } : body);
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
async function decideEmail(id, actor, decision, access = {}, options = {}) {
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
  const text = withRequiredLinks(decision.text, policyDraft.requiredLinks, policyDraft.values);
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
    if (draft.reminderRunId) {
      const eligibility = await require('./communicationReminderEligibility').maySendReminder(draft.reminderRunId, { emails: draft.to });
      if (!eligibility.allowed) throw new Error(`Reminder not sent: ${eligibility.reason}`);
    }
    if (!await require('./reservationReminderEligibility').maySendReservationReminder(draft)) throw new Error('Reservation reminder is no longer eligible.');
    if (!await require('./packageStartReminderEligibility').maySendPackageStartReminder(draft)) throw new Error('Package request reminder is no longer eligible.');
    if (!await require('./offerPaymentReminderEligibility').maySendOfferPaymentReminder(draft)) throw new Error('Offer payment reminder is no longer eligible.');
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
    if (!options.skipWhatsApp) enqueueWhatsAppForEmail(draft).catch(error => console.error('[whatsapp] Could not queue this email for WhatsApp:', error.message));
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
// The one channel coordinator. A send without an explicit choice (automatic mail, or a review that
// picked none) goes by its action's "Send via" (reviewDelivery.actionChannel). Only a draft whose first
// email attempt started before channels existed keeps the email path, so its retry repeats that delivery.
async function decideChannels(id, actor, decision, access) {
  if (decision.choice === 'send') {
    const draft = await EmailDraft.findOne({ _id: id, ...draftAccess(actor, access), expiresAt: { $gt: new Date() } }).lean();
    if (draft?.event === 'broadcast.manual' && !access.broadcastDelivery) throw new Error('Manage this delivery from Broadcast; its channels and content are locked.');
    const locked = !!draft?.delivery?.channels?.length;
    if (draft && (locked || decision.channels !== undefined || (draft.status === 'pending' && !draft.attemptCount))) {
      const delivery = require('./reviewDelivery');
      // A retry repeats the channels its first attempt locked.
      let chosen = locked && decision.channels === undefined ? { ...decision, channels: delivery.selectionFor(draft.delivery.channels) } : decision;
      if (!locked && decision.channels === undefined) {
        let channels = await delivery.actionChannel(draft.event);
        if (actor === null) {
          // Automatic mail (no reviewer to choose). Both: each part goes where it can, as the email +
          // WhatsApp copy always did (a team address usually has no phone). A single route that can't
          // reach this person is recorded as Not sent with the reason, never sent another way.
          const { choices } = await delivery.availability(draft);
          const usable = id => choices.find(row => row.id === id)?.enabled;
          if (channels === 'both' && !usable('both')) channels = usable('email') ? 'email' : usable('whatsapp') ? 'whatsapp' : channels;
          if (!usable(channels)) return markNotSent(draft, choices.find(row => row.id === channels)?.reason || 'Channel unavailable.');
        }
        chosen = { ...decision, channels };
      }
      return delivery.deliver({ draft, actor, decision: chosen, access, sendEmail: payload => decideEmail(id, actor, payload, access, { skipWhatsApp: true }), recordHistory, reviewedMail, validateContent });
    }
  }
  return decideEmail(id, actor, decision, access);
}
async function markNotSent(draft, reason) {
  const failure = `Not sent: ${reason}`;
  const skipped = await EmailDraft.findOneAndUpdate({ _id: draft._id, status: 'pending' }, { $set: { status: 'skipped', failure } }, { new: true });
  if (skipped) await recordHistory(skipped, null);
  return { status: 'skipped', notSent: true, failure, event: draft.event, reference: draft.reference };
}
// Delivered by the action's route: an email that was sent, or a WhatsApp-only message in the queue.
const DELIVERED = ['sent', 'queued'];
async function decide(id, actor, decision, access = {}) {
  if (decision.choice === 'skip' && !access.broadcastDelivery && await EmailDraft.exists({ _id: id, event: 'broadcast.manual' })) throw new Error('Manage this delivery from Broadcast; its channels and content are locked.');
  if (decision.choice === 'send') await require('./leadContactBlock').assertDraftMayGo(id);
  const result = await decideChannels(id, actor, decision, access);
  // Send message on a lead's page leaves a line on its timeline. It can never change the send's result.
  if (decision.choice === 'send' && ['sent', 'queued'].includes(result.status)) {
    await require('./leadMessage').recordOnTimeline(id).catch(error => console.error('[email] Sent; could not add the lead timeline line:', error.message));
    // Upgrade completed on a project's page leaves its ₹0 complimentary invoice. Same rule: never changes the send's result.
    await require('./complimentaryUpgrade').recordCompleted(id).catch(error => console.error('[email] Sent; could not record the complimentary invoice:', error.message));
  }
  return result;
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
  mail.offerReminderContext = { invoiceId: invoice._id, expectedAmount: Math.max(0, Number(invoice.amount) - Number(invoice.amountPaid || 0)), dueAt: invoice.dueDate, offset };
  const scope = { system: true, closed: false, ids: [], req: { method: 'CRON', originalUrl: '/offer-payment-reminders', userId: null } };
  const result = await requestScope.run(scope, () => queueMail(event, mail));
  if (!result.draftId) return;
  const draft = await EmailDraft.findOneAndUpdate({ _id: result.draftId, status: 'staged' }, { $set: { status: 'pending' } }, { new: true }) || await EmailDraft.findById(result.draftId);
  if (!draft || [...DELIVERED, 'sending', 'skipped'].includes(draft.status) || draft.expiresAt <= new Date()) return;
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
  if (DELIVERED.includes(history?.status)) return 'sent';
  const mail = require('./emailTemplates').buildTemplatedMail(event, reservation, user);
  if (!mail) throw new Error('Reservation mail website URL or recipient is unavailable');
  return sendSystemMail(event, mail, dedupeKey, '/offer-reservations');
}
// Sends one system-triggered mail (emailCatalog.js SYSTEM_TRIGGERED) outside any review: staged,
// recorded, then sent through decide() like a reviewed send, so the action's On/Off policy and its
// "Send via" apply. dedupeKey makes it once-only: a retry or a second caller returns 'sent'.
// 'sent' = delivered by the action's route; 'not-sent' = that route can't reach this person (never retried).
async function sendSystemMail(event, mail, dedupeKey, source, options = {}) {
  const history = await EmailHistory.findOne({ dedupeKey }).lean();
  // For a new rule-step delivery, an email can be accepted while its WhatsApp
  // copy fails. A history row labeled sent alone does not mean both parts finished.
  const complete = delivery => !delivery?.channels?.length || delivery.channels.every(channel => channel === 'email' ? delivery.emailStatus === 'sent' : delivery.whatsappStatus === 'queued');
  if (DELIVERED.includes(history?.status) && (!options.channel || complete(history.delivery))) return 'sent';
  mail.dedupeKey = dedupeKey;
  const scope = { system: true, closed: false, ids: [], req: { method: 'SYSTEM', originalUrl: source, userId: null } };
  const result = await requestScope.run(scope, () => queueMail(event, mail));
  if (!result.draftId) return 'paused';
  const draft = await EmailDraft.findOneAndUpdate({ _id: result.draftId, status: 'staged' }, { $set: { status: 'pending' } }, { new: true }) || await EmailDraft.findById(result.draftId);
  if (DELIVERED.includes(draft?.status)) return 'sent';
  if (draft?.status === 'skipped' && draft.failure?.startsWith('Not sent:')) return 'not-sent';
  if (!draft || draft.expiresAt <= new Date() || draft.status === 'skipped') return 'expired';
  if (draft.status === 'sending') throw new Error('Confirmation delivery is awaiting reconciliation');
  await recordHistory(draft, null, true);
  let channel = options.channel;
  if (channel && draft.delivery?.channels?.length) channel = require('./reviewDelivery').selectionFor(draft.delivery.channels);
  if (channel) {
    const { choices } = await require('./reviewDelivery').availability(draft);
    const usable = id => choices.find(row => row.id === id)?.enabled;
    if (channel === 'both' && !usable('both')) channel = usable('email') ? 'email' : usable('whatsapp') ? 'whatsapp' : channel;
    if (!usable(channel)) return (await markNotSent(draft, choices.find(row => row.id === channel)?.reason || 'Channel unavailable.')).notSent ? 'not-sent' : 'paused';
  }
  const decision = await decide(String(draft._id), null, { choice: 'send', subject: draft.subject, text: draft.text, ...(channel ? { channels: channel } : {}) }, { application: 'portal', portalAdmin: true });
  // A failed part of a channel send is retried by the caller's job: same draft, same provider key.
  if (decision.status === 'failed') throw new Error(decision.delivery?.failure || 'Delivery failed');
  return DELIVERED.includes(decision.status) ? 'sent' : decision.notSent ? 'not-sent' : 'paused';
}
const hasActiveRequestScope = () => { const scope = requestScope.getStore(); return !!scope && !scope.closed && !scope.system && !!scope.req.userId; };
module.exports = { recordHistory, registerReviewDraft, unregisterReviewDraft, queueMail, reviewTransport, withEvent, requestMiddleware, decide, applyDefault, reviewedMail, plainText, validateContent, applicationQuery, draftAccess, sendScheduledOfferReminder, sendReservationConfirmation, sendReservationMail, sendSystemMail, hasActiveRequestScope };
