const { randomUUID } = require('node:crypto');
const { EmailDraft, EmailPolicy, EmailHistory } = require('../models/emailControlModel');
const { normalizePhone, savedPhoneFor, enqueueWhatsAppForEmail } = require('./whatsappQueue');
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };

async function availability(draft) {
  const emails = draft.to || [];
  const email = emails.length > 0 && emails.every(value => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value));
  const recipients = emails.length
    ? await Promise.all(emails.map(async address => ({ email: address, phone: normalizePhone(emails.length === 1 && draft.whatsappTo ? draft.whatsappTo : await savedPhoneFor(address)) })))
    : [{ phone: normalizePhone(draft.whatsappTo) }];
  const whatsapp = !draft.event?.startsWith('website.subscription.') && process.env.ENABLE_WHATSAPP === 'true' && recipients.length > 0 && recipients.every(row => row.phone);
  const phoneReason = process.env.ENABLE_WHATSAPP !== 'true' ? 'WhatsApp is off on the server.' : 'A valid saved phone number is missing.';
  return {
    choices: [
      { id: 'email', label: 'Email', enabled: !!email, reason: email ? '' : 'A valid email address is missing.' },
      { id: 'whatsapp', label: 'WhatsApp', enabled: !!whatsapp, reason: whatsapp ? '' : phoneReason },
      { id: 'both', label: 'Both', enabled: !!email && !!whatsapp, reason: !email ? 'A valid email address is missing.' : !whatsapp ? phoneReason : '' },
    ],
    defaultChannel: email && whatsapp ? 'both' : email ? 'email' : 'whatsapp',
    recipients,
  };
}
function channelsFor(selection) {
  if (!['email', 'whatsapp', 'both'].includes(selection)) fail('Choose Email, WhatsApp or Both.', 400);
  return selection === 'both' ? ['email', 'whatsapp'] : [selection];
}
const selectionFor = channels => channels.length === 2 ? 'both' : channels[0];

async function deliver({ draft, actor, decision, sendEmail, recordHistory, reviewedMail, validateContent }) {
  const policy = await EmailPolicy.findOne({ event: draft.event }).lean();
  if (policy?.mode === 'off') fail('Messages for this action are Off.');
  if (draft.status === 'staged' || draft.status === 'skipped') fail('Draft is unavailable.');
  if (draft.event.startsWith('website.subscription.') && decision.channels !== 'email') fail('Subscription confirmation requires email.');
  const owner = randomUUID(), now = new Date();
  const claim = await EmailDraft.findOneAndUpdate({ _id: draft._id,
    $or: [{ 'delivery.lockUntil': null }, { 'delivery.lockUntil': { $lte: now } }],
  }, { $set: { 'delivery.lockOwner': owner, 'delivery.lockUntil': new Date(now.getTime() + 120000) } }, { new: true });
  if (!claim) fail('This message is being processed. Please wait.');
  const renew = setInterval(() => EmailDraft.updateOne({ _id: draft._id, 'delivery.lockOwner': owner }, { $set: { 'delivery.lockUntil': new Date(Date.now() + 120000) } }).catch(() => {}), 30000);
  renew.unref?.();
  try {
    let current = claim.toObject();
    if (!current.delivery?.channels?.length) {
      if (current.status !== 'pending' || current.attemptCount) fail('The first send attempt already locked this message.');
      const available = await availability(current);
      const channels = channelsFor(decision.channels);
      if (!available.choices.find(row => row.id === decision.channels)?.enabled) fail(available.choices.find(row => row.id === decision.channels)?.reason || 'Channel unavailable.');
      validateContent(decision.subject, decision.text);
      const { withRequiredLinks } = require('./emailMarkup');
      const frozen = reviewedMail(current, withRequiredLinks(decision.text, current.requiredLinks));
      const selected = decision.templateId && decision.templateId !== 'current' ? await require('./emailTemplates').resolveTemplate(current.event, decision.templateId) : null;
      await EmailDraft.updateOne({ _id: current._id, 'delivery.lockOwner': owner }, { $set: {
        subject: decision.subject, ...frozen,
        ...(selected ? { sourceTemplateId: selected._id, templateName: selected.name } : {}),
        'delivery.channels': channels, 'delivery.subject': decision.subject, 'delivery.text': frozen.text,
        'delivery.recipients': available.recipients.filter(row => row.phone), 'delivery.lockedAt': now,
        'delivery.emailStatus': channels.includes('email') ? 'pending' : 'not-selected',
        'delivery.whatsappStatus': channels.includes('whatsapp') ? 'pending' : 'not-selected',
      } });
      current = (await EmailDraft.findById(current._id)).toObject();
    } else if (decision.channels && decision.channels !== selectionFor(current.delivery.channels)) {
      fail('The first send attempt locked the selected channels. Retry the original selection.');
    }
    const delivery = current.delivery;
    const errors = [];
    if (delivery.channels.includes('email') && delivery.emailStatus !== 'sent') {
      const accepted = current.providerId || await EmailHistory.exists({ draftId: current._id, status: 'sent', providerId: { $nin: [null, ''] } });
      if (accepted) {
        delivery.emailStatus = 'sent';
      } else {
        try {
          await sendEmail({ choice: 'send', subject: delivery.subject, text: delivery.text });
          delivery.emailStatus = 'sent';
        } catch (error) {
          const recorded = await EmailHistory.exists({ draftId: current._id, status: 'sent', providerId: { $nin: [null, ''] } });
          if (recorded) delivery.emailStatus = 'sent';
          else { delivery.emailStatus = 'failed'; errors.push(error.message); }
        }
      }
      await EmailDraft.updateOne({ _id: current._id, 'delivery.lockOwner': owner }, { $set: { 'delivery.emailStatus': delivery.emailStatus } });
    }
    if (delivery.channels.includes('whatsapp') && delivery.whatsappStatus !== 'queued') {
      try {
        await enqueueWhatsAppForEmail({ ...current, subject: delivery.subject }, { recipients: delivery.recipients, strict: true });
        delivery.whatsappStatus = 'queued';
      } catch (error) { delivery.whatsappStatus = 'failed'; errors.push(error.message); }
    }
    const status = errors.length ? 'failed' : delivery.channels.includes('email') ? 'sent' : 'queued';
    await EmailDraft.updateOne({ _id: current._id, 'delivery.lockOwner': owner }, { $set: { status, failure: errors.join(' '), 'delivery.whatsappStatus': delivery.whatsappStatus, 'delivery.failure': errors.join(' ') } });
    const result = await EmailDraft.findById(current._id);
    await recordHistory(result, actor, true);
    return { status, sentAt: result.sentAt, event: result.event, reference: result.reference,
      delivery: { channels: delivery.channels, email: delivery.emailStatus, whatsapp: delivery.whatsappStatus, failure: errors.join(' ') } };
  } finally {
    clearInterval(renew);
    await EmailDraft.updateOne({ _id: draft._id, 'delivery.lockOwner': owner }, { $unset: { 'delivery.lockOwner': 1, 'delivery.lockUntil': 1 } });
  }
}
module.exports = { availability, deliver, selectionFor, channelsFor };
