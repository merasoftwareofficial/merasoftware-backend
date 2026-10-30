// The one list of lead statuses. The portal's copy for display is frontend/src/helpers/leadStatuses.js.
// Contacted, Proposal Sent and Won are set by what happens to the lead; only these three are chosen by hand.
const CONTACTED = "Contacted";
const PROPOSAL_SENT = "Proposal Sent"; // set by adding a proposal (controller/lead/uploadProposal.js)
const POSITIVE = "Positive";
const NEGATIVE = "Negative";
const WON = "Won"; // set only by a lead becoming a client (controller/lead/convertLead.js, helpers/wonLead.js)

const LEAD_STATUSES = [CONTACTED, PROPOSAL_SENT, POSITIVE, NEGATIVE, WON];
const SELECTABLE_LEAD_STATUSES = [CONTACTED, POSITIVE, NEGATIVE];
const DEFAULT_LEAD_STATUS = CONTACTED;
// A new request is added to a lead in one of these instead of creating another lead.
const OPEN_LEAD_STATUSES = [CONTACTED];

/** The status after any proposal is added: it moves forward, never back from Positive or Won. */
function statusAfterProposal(status) {
  return status === WON || status === POSITIVE ? status : PROPOSAL_SENT;
}

module.exports = {
  CONTACTED, PROPOSAL_SENT, POSITIVE, NEGATIVE, WON,
  LEAD_STATUSES, SELECTABLE_LEAD_STATUSES, DEFAULT_LEAD_STATUS, OPEN_LEAD_STATUSES,
  statusAfterProposal,
};
