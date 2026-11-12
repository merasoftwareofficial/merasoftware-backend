const { randomUUID } = require('node:crypto');
const Run = require('../models/communicationReminderRunModel');
const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
const { EmailDraft, EmailHistory } = require('../models/emailControlModel');
const { render } = require('./emailMarkup');
const { maySendReminder } = require('./communicationReminderEligibility');

function portalLink(path) {
  try {
    const base = new URL(process.env.FORNTEND_URL);
    if (!['http:', 'https:'].includes(base.protocol)) return '';
    return new URL(path, base).toString();
  } catch { return ''; }
}
const day = value => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(value);

// One due run, claimed atomically. Recovery uses the same delivery dedupe key;
// no caller may invoke this for a legacy reminder or an untagged message.
async function dispatchReminder(runId, now = new Date(), workerLeaseOwner = null) {
  const owner = randomUUID();
  const run = await Run.findOneAndUpdate({ _id: runId, dueAt: { $lte: now }, $or: [
    { status: 'scheduled' }, { status: 'preparing', lockUntil: { $lte: now } },
  ] }, { $set: { status: 'preparing', lockOwner: owner, lockUntil: new Date(Date.now() + 120000), ...(workerLeaseOwner ? { workerLeaseOwner } : {}) } }, { new: true }).lean();
  if (!run) return 'not-due';
  const finish = (status, fields = {}) => Run.updateOne({ _id: run._id, status: 'preparing', lockOwner: owner }, { $set: { status, ...fields }, $unset: { lockOwner: 1, lockUntil: 1, workerLeaseOwner: 1 } });
  try {
    const eligibility = await maySendReminder(run._id);
    if (!eligibility.allowed) { await finish('cancelled', { reason: eligibility.reason }); return 'cancelled'; }
    const frozen = await Run.updateOne({ _id: run._id, status: 'preparing', lockOwner: owner }, { $set: run.source === 'monthly_package' ? { expectedAmount: eligibility.candidate.amount } : { reason: '' } });
    if (!frozen.matchedCount) return 'not-owned';
    let values, to, phone;
    if (run.source === 'broadcast') {
      values = { name: eligibility.candidate.lead.name || 'Customer' };
      to = run.channel === 'whatsapp' ? [] : eligibility.candidate.emails;
      phone = eligibility.candidate.phones[0];
    } else {
      const [client, order] = await Promise.all([User.findById(run.clientId).select('name email phone').lean(), Order.findById(run.entityId).select('orderItems servicePlanSnapshot').lean()]);
      if (!client || !order) { await finish('cancelled', { reason: 'Client or package unavailable.' }); return 'cancelled'; }
      values = { name: client.name || 'Customer', package: order.orderItems?.[0]?.name || order.servicePlanSnapshot?.serviceName || 'Package',
        amount: `₹${eligibility.candidate.amount.toLocaleString('en-IN')}`, dueDate: day(eligibility.candidate.due),
        planLink: portalLink(`/plan-details/${order._id}`), invoiceLink: eligibility.candidate.invoiceId ? portalLink(`/invoice-detail/${eligibility.candidate.invoiceId}`) : '' };
      to = client.email ? [client.email] : []; phone = client.phone;
    }
    const key = `communication-reminder:${run._id}`;
    const mail = { reviewed: true, to, phone,
      subject: render(run.subject, values, {}, { plain: true }), text: run.text, values, reminderRunId: run._id };
    const result = await require('./emailController').sendSystemMail('reminder.automated', mail, key, '/communication-reminders', { channel: run.channel });
    const [draft, history] = await Promise.all([EmailDraft.findOne({ dedupeKey: key }).select('_id delivery status sentAt').lean(), EmailHistory.findOne({ dedupeKey: key }).select('delivery sentAt').lean()]);
    if (result === 'sent') {
      const delivery = draft?.delivery || history?.delivery;
      const pendingWhatsApp = delivery?.whatsappStatus === 'queued';
      const channels = delivery?.channels || [];
      const channelOutcomes = { email: channels.includes('email') ? delivery.emailStatus || 'unknown' : 'not-selected',
        whatsapp: channels.includes('whatsapp') ? delivery.whatsappStatus || 'unknown' : 'not-selected' };
      await finish(pendingWhatsApp ? 'queued' : 'sent', { ...(draft?._id ? { emailDraftId: draft._id } : {}), ...(!pendingWhatsApp && (draft?.sentAt || history?.sentAt) ? { sentAt: draft?.sentAt || history?.sentAt } : {}), channelOutcomes, reason: '' });
      return pendingWhatsApp ? 'queued' : 'sent';
    }
    await finish('skipped', { reason: `Delivery ${result}.`, ...(draft?._id ? { emailDraftId: draft._id } : {}) });
    return 'skipped';
  } catch (error) {
    // A provider can accept one channel before the other fails. Preserve the
    // durable draft and channel results rather than reporting the whole send
    // as failed or attempting an unsafe automatic replay.
    const draft = await EmailDraft.findOne({ dedupeKey: `communication-reminder:${run._id}` }).select('_id delivery').lean().catch(() => null);
    const delivery = draft?.delivery;
    const channels = delivery?.channels || [];
    const email = channels.includes('email') ? delivery.emailStatus || 'unknown' : 'not-selected';
    const whatsapp = channels.includes('whatsapp') ? delivery.whatsappStatus || 'unknown' : 'not-selected';
    const status = whatsapp === 'queued' ? 'queued' : email === 'sent' ? 'partial' : 'failed';
    await finish(status, { reason: String(error.message || 'Delivery failed').slice(0, 500),
      ...(draft?._id ? { emailDraftId: draft._id, channelOutcomes: { email, whatsapp } } : {}) });
    return status;
  }
}
module.exports = { dispatchReminder };
