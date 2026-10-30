// The one list of lead statuses. The portal's copy for display is frontend/src/helpers/leadStatuses.js.
// A lead has one status, chosen by the admin; only Won is set by the system. Whether a proposal has
// gone out is not a status: it is the lead's permanent proposalSentAt, which no status change touches.
const CONTACTED = "Contacted";
const POSITIVE = "Positive";
const NEGATIVE = "Negative";
const WON = "Won"; // set only by a lead becoming a client (controller/lead/convertLead.js, helpers/wonLead.js)
const INQUIRY = "Inquiry"; // set only by WhatsApp Auto Reply (helpers/autoReplyJobs.js): a number, not yet a real lead
const PROPOSAL_SENT = "Proposal Sent"; // history only: old follow-ups keep this badge

const LEAD_STATUSES = [INQUIRY, CONTACTED, POSITIVE, NEGATIVE, WON];
const SELECTABLE_LEAD_STATUSES = [CONTACTED, POSITIVE, NEGATIVE];
const FOLLOW_UP_BADGES = [...LEAD_STATUSES, PROPOSAL_SENT];
const DEFAULT_LEAD_STATUS = CONTACTED;
// A new request is added to a lead in one of these instead of creating another lead.
const OPEN_LEAD_STATUSES = [CONTACTED];
// A lead may have no name only here: an Inquiry has just a number, and the admin can drop one as Negative without finding its name.
const NAME_OPTIONAL_STATUSES = [INQUIRY, NEGATIVE];

module.exports = {
  INQUIRY, CONTACTED, POSITIVE, NEGATIVE, WON, PROPOSAL_SENT,
  LEAD_STATUSES, SELECTABLE_LEAD_STATUSES, FOLLOW_UP_BADGES, DEFAULT_LEAD_STATUS, OPEN_LEAD_STATUSES, NAME_OPTIONAL_STATUSES,
};
