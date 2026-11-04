const Lead = require('../models/leadModel');
const { setBehaviour } = require('./offerTargets');
const { prepareFor } = require('./finalMessage');
const { clientStartReadiness } = require('./clientFinalMessageReadiness');

// Both admin entry points share preparation, including recovery of an already-Negative client.
async function changeClientStatus(leadId, value, actor) {
  const result = await setBehaviour(leadId, value, actor);
  if (value !== 'Negative') return result;
  try {
    const lead = await Lead.findById(leadId).lean();
    const readiness = await clientStartReadiness(lead);
    if (!readiness.ready) return { ...result, finalMessage: 'client-ineligible', finalMessageReadiness: readiness };
    const finalMessage = await prepareFor(lead);
    return { ...result, finalMessage, finalMessageReadiness: finalMessage === 'client-ineligible' ? await clientStartReadiness(await Lead.findById(leadId).lean()) : readiness };
  } catch (error) {
    console.error('Client status saved; final message preparation can be retried:', error.message);
    return { ...result, finalMessage: 'unavailable' };
  }
}
module.exports = { changeClientStatus };
