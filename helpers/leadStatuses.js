// The one list of lead statuses. The portal's copy for display is frontend/src/helpers/leadStatuses.js.
// A lead has one status, chosen by the admin; only Won is set by the system. Whether a proposal has
// gone out is not a status: it is the lead's permanent proposalSentAt, which no status change touches.
const CONTACTED = "Contacted"; // shown as Neutral; the stored value stays, as Won is shown as Matured
const POSITIVE = "Positive";
const ACTIVE = "Active";
const LAZY = "Lazy";
const TOUGH = "Tough";
const NEGATIVE = "Negative";
const UNHAPPY = "Unhappy";
const WON = "Won"; // set only by a lead becoming a client (controller/lead/convertLead.js, helpers/wonLead.js)
const INQUIRY = "Inquiry"; // set only by WhatsApp Auto Reply (helpers/autoReplyJobs.js): a number, not yet a real lead
const DEAD = "Dead"; // below Negative, kept for later: no reply to the final message (helpers/finalMessageJobs.js), or the admin's choice. Not a Broadcast group
const WRONG = "Wrong"; // someone who can't be sold to at all. Leads only: a client has already been filtered in
const PROPOSAL_SENT = "Proposal Sent"; // history only: old follow-ups keep this badge

const LEAD_STATUSES = [INQUIRY, CONTACTED, POSITIVE, ACTIVE, LAZY, TOUGH, NEGATIVE, UNHAPPY, DEAD, WRONG, WON];
const SELECTABLE_LEAD_STATUSES = [CONTACTED, POSITIVE, ACTIVE, LAZY, TOUGH, NEGATIVE, UNHAPPY, DEAD, WRONG];
const FOLLOW_UP_BADGES = [...LEAD_STATUSES, PROPOSAL_SENT];
const DEFAULT_LEAD_STATUS = CONTACTED;
// A new request is added to a lead in one of these instead of creating another lead.
const OPEN_LEAD_STATUSES = [CONTACTED, POSITIVE, ACTIVE, LAZY, TOUGH, UNHAPPY];
// A lead may have no name only here: an Inquiry has just a number, the admin can drop one as Negative or Wrong without finding its name, and such a lead can then go Dead.
const NAME_OPTIONAL_STATUSES = [INQUIRY, NEGATIVE, DEAD, WRONG];
// Broadcast's Proposal Sent group: the badge plus one of these.
const PROPOSAL_GROUP_STATUSES = [CONTACTED, POSITIVE, ACTIVE, LAZY, TOUGH];
// Never marketed to (helpers/leadContactBlock.js).
const NO_MARKETING_STATUSES = [DEAD, WRONG];

// How a client generally behaves, kept apart from the client's Won status (lead.clientBehaviour). No value means Neutral.
const CLIENT_BEHAVIOURS = SELECTABLE_LEAD_STATUSES.filter((status) => status !== WRONG);
const DEFAULT_CLIENT_BEHAVIOUR = CONTACTED;
/** The behaviour a lead starts with on becoming a client: its category, unless that is one a client can't keep. */
const behaviourFromStatus = (status) => (CLIENT_BEHAVIOURS.includes(status) && status !== DEAD ? status : DEFAULT_CLIENT_BEHAVIOUR);

// A person's stage in one offer (models/offerTargetModel.js). Won is set only by Bought this offer.
const OFFER_STAGES = [CONTACTED, POSITIVE, NEGATIVE, WON];
const SELECTABLE_OFFER_STAGES = [CONTACTED, POSITIVE, NEGATIVE];

const leadStatusLabel = (status) => (status === CONTACTED ? "Neutral" : status === WON ? "Matured" : status);

/** What a client who referred this lead may see. Our categories for a person stay inside the team. */
const referredLeadStatus = (status) => (status === WON ? "Matured" : [NEGATIVE, DEAD, WRONG].includes(status) ? "Closed" : "In progress");

module.exports = {
  INQUIRY, CONTACTED, POSITIVE, ACTIVE, LAZY, TOUGH, NEGATIVE, UNHAPPY, DEAD, WRONG, WON, PROPOSAL_SENT,
  LEAD_STATUSES, SELECTABLE_LEAD_STATUSES, FOLLOW_UP_BADGES, DEFAULT_LEAD_STATUS, OPEN_LEAD_STATUSES, NAME_OPTIONAL_STATUSES,
  PROPOSAL_GROUP_STATUSES, NO_MARKETING_STATUSES, CLIENT_BEHAVIOURS, DEFAULT_CLIENT_BEHAVIOUR, behaviourFromStatus,
  OFFER_STAGES, SELECTABLE_OFFER_STAGES, leadStatusLabel, referredLeadStatus,
};
