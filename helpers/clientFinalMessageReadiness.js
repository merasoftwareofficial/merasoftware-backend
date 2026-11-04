const Lead = require('../models/leadModel');
const User = require('../models/userModel');
const { normalizePhone } = require('./whatsappQueue');

const messages = {
  'automation-disabled': 'Client final-message automation is disabled on the server. Enable it after setup verification; no countdown has started.',
  'lead-unavailable': 'The linked lead is missing or in Trash. Restore or review the client link first.',
  'client-link-missing': 'This record is not linked to a client account. Review its client link first.',
  'client-state': 'The linked client must have Current status Negative before starting a final message.',
  'cycle-changed': 'The client status or tracked cycle has changed. Refresh before continuing.',
  'account-unavailable': 'The linked account is missing, deleted, a guest or no longer a customer. Review the client account.',
  'duplicate-links': 'More than one active lead links to this client. Review the duplicate links first.',
  'invalid-phone': 'The client lead has no valid WhatsApp number. Correct its phone before starting the message.',
  'phone-mismatch': 'The client account and lead have different or invalid phone numbers. Review both phone records.',
  'shared-phone': 'Multiple client accounts share this WhatsApp number. Review the accounts before messaging.',
  'template-disabled': 'The Final message action is Off in Email Templates. Turn it on before retrying; no new countdown can start.',
};
const issue = code => ({ ready: false, code, message: messages[code] });

async function clientReadiness(lead, row) {
  if (!lead || lead.deletedAt) return issue('lead-unavailable');
  if (!lead.convertedToUserId) return issue('client-link-missing');
  if (lead.status !== 'Won' || lead.clientBehaviour !== 'Negative') return issue('client-state');
  if (process.env.CLIENT_FINAL_MESSAGE_ENABLED !== 'true') return issue('automation-disabled');
  if (row && (String(row.clientId) !== String(lead.convertedToUserId) || (row.behaviourRevision || 0) !== (lead.clientBehaviourRevision || 0) || (row.phone && normalizePhone(lead.phone) !== row.phone))) return issue('cycle-changed');
  const [account, links] = await Promise.all([
    User.findOne({ _id: lead.convertedToUserId, roles: 'customer', deletedAt: null, isGuest: { $ne: true } }).select('phone').lean(),
    Lead.countDocuments({ convertedToUserId: lead.convertedToUserId, deletedAt: null }),
  ]);
  if (!account) return issue('account-unavailable');
  if (links !== 1) return issue('duplicate-links');
  const phone = normalizePhone(lead.phone);
  if (!phone) return issue('invalid-phone');
  if (normalizePhone(account.phone) !== phone) return issue('phone-mismatch');
  const accounts = await User.find({ roles: 'customer', deletedAt: null, isGuest: { $ne: true }, phone: { $nin: ['', null] } }).select('phone').lean();
  if (accounts.filter(user => normalizePhone(user.phone) === phone).length !== 1) return issue('shared-phone');
  return { ready: true, code: 'ready', message: '' };
}
async function clientStartReadiness(lead) {
  const result = await clientReadiness(lead);
  if (!result.ready) return result;
  const policy = await require('../models/emailControlModel').EmailPolicy.findOne({ event: 'lead.finalMessage' }).select('mode').lean();
  return policy?.mode === 'off' ? issue('template-disabled') : result;
}
module.exports = { clientReadiness, clientStartReadiness };
