// The one list of lead statuses. The portal's copy for display is frontend/src/helpers/leadStatuses.js.
// A lead is added once it has been contacted, so "Contacted" is where every lead starts.
const CONTACTED = "Contacted";
const PROPOSAL_SENT = "Proposal Sent";
const POSITIVE = "Positive";
const NEGATIVE = "Negative";
const WON = "Won"; // set only by converting a lead into a client (controller/lead/convertLead.js)

const LEAD_STATUSES = [CONTACTED, PROPOSAL_SENT, POSITIVE, NEGATIVE, WON];
const SELECTABLE_LEAD_STATUSES = [CONTACTED, PROPOSAL_SENT, POSITIVE, NEGATIVE];
const DEFAULT_LEAD_STATUS = CONTACTED;
// A new request is added to a lead in one of these instead of creating another lead.
const OPEN_LEAD_STATUSES = [CONTACTED];

/** The status after a lead's first proposal: it moves forward, never back from Positive or Won. */
function statusAfterFirstProposal(status) {
  return status === WON || status === POSITIVE ? status : PROPOSAL_SENT;
}

module.exports = {
  CONTACTED, PROPOSAL_SENT, POSITIVE, NEGATIVE, WON,
  LEAD_STATUSES, SELECTABLE_LEAD_STATUSES, DEFAULT_LEAD_STATUS, OPEN_LEAD_STATUSES,
  statusAfterFirstProposal,
};
