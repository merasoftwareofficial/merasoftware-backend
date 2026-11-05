// Shared review payload for action responses and explicit draft reads. No data cache.
async function buildReview(draft, isAdmin) {
  const { reviewWithDoc, templateOptions, editableReview } = require('./emailTemplates');
  const { availability } = require('./reviewDelivery');
  const { messageTypes } = require('./leadMessage');
  // Template initialization can update its revision; finish it before reading editable metadata.
  const options = isAdmin ? await templateOptions(draft.event) : undefined;
  const [channels, editable, types] = await Promise.all([
    availability(draft),
    isAdmin ? editableReview(draft) : undefined,
    isAdmin && draft.leadId ? messageTypes(draft.leadId) : undefined,
  ]);
  const channelEditable = (draft.status === 'pending' && !draft.attemptCount) || draft.delivery?.channels?.length;
  // Every number the WhatsApp copy goes to: frozen at the first send attempt, else as resolved now.
  const frozen = draft.delivery?.recipients?.length ? draft.delivery.recipients : channels.recipients;
  const whatsappNumbers = (frozen || []).filter(row => row.phone).map(row => ({ phone: row.phone, alt: !!row.alt }));
  return { ...draft, whatsappNumbers, ...reviewWithDoc(draft.event, draft.text, draft.values, draft.blocks),
    ...(channelEditable ? { channelOptions: channels.choices, defaultChannel: channels.defaultChannel } : {}),
    ...(isAdmin ? { templateOptions: options, ...editable, ...(types ? { messageTypes: types } : {}) } : {}) };
}
module.exports = { buildReview };
