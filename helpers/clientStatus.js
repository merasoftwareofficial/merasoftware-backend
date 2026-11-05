const Lead = require('../models/leadModel');
const { setBehaviour } = require('./offerTargets');
const { prepareFor } = require('./finalMessage');
const { clientStartReadiness } = require('./clientFinalMessageReadiness');
const { reconcileCycle } = require('./finalMessageCycle');
const { DEFAULT_CLIENT_BEHAVIOUR, NEGATIVE } = require('./leadStatuses');

// The one client status change, for the portal's follow-up form and the website's offer page; it works as a lead's stage does.
// Entering Negative is checked before anything is saved, so a client never sits in Negative with no final message possible.
async function changeClientStatus(leadId, value, actor, { note, attachment } = {}) {
  const lead = await Lead.findOne({ _id: leadId, deletedAt: null }).lean();
  const entering = value === NEGATIVE && Boolean(lead) && (lead.clientBehaviour || DEFAULT_CLIENT_BEHAVIOUR) !== NEGATIVE;
  if (entering) {
    const readiness = await clientStartReadiness({ ...lead, clientBehaviour: NEGATIVE });
    if (!readiness.ready) throw Object.assign(new Error(readiness.message), { status: 409, finalMessageReadiness: readiness });
  }
  const result = await setBehaviour(leadId, value, actor, { note, attachment });
  // Leaving Negative (or Dead with its closure still waiting) ends the cycle now, not at its deadline.
  await reconcileCycle(leadId, { actor });
  if (!entering) return result;
  try {
    return { ...result, finalMessage: await prepareFor(await Lead.findById(leadId).lean()) };
  } catch (error) {
    console.error('Client status saved; its final message can be started from the lead page:', error.message);
    return { ...result, finalMessage: 'unavailable' };
  }
}
module.exports = { changeClientStatus };
