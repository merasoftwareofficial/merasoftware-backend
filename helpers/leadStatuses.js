// The one list of lead statuses. The portal's copy for display is frontend/src/helpers/leadStatuses.js.
// A lead has one status, chosen by the admin; only Won is set by the system. Whether a proposal has
// gone out is not a status: it is the lead's permanent proposalSentAt, which no status change touches.
const CONTACTED = "Contacted"; // shown as Neutral; the stored value stays, as Won is shown as Matured
const POSITIVE = "Positive";
const ACTIVE = "Active";
const LAZY = "Lazy";
const TOUGH = "Tough";
const NOT_NOW = "NotNow";
const NEGATIVE = "Negative";
const UNHAPPY = "Unhappy";
const WON = "Won"; // set only by a lead becoming a client (controller/lead/convertLead.js, helpers/wonLead.js)
// Set only by the system: WhatsApp Auto Reply (helpers/autoReplyJobs.js), a number not yet a real lead; or a Dead
// lead with no name who wrote after the closure message (helpers/finalMessageComeback.js; a named one is Neutral)
const INQUIRY = "Inquiry";
// Set only by the system while the person's offer reservation runs (helpers/reservationStage.js); on expiry the lead is Not Now.
const RESERVATION = "Reservation";
const DEAD = "Dead"; // below Negative, kept for later: no reply to the final message (helpers/finalMessageJobs.js), or the admin's choice. Not a Broadcast group
const WRONG = "Wrong"; // someone who can't be sold to at all. Leads only: a client has already been filtered in
const PROPOSAL_SENT = "Proposal Sent"; // history only: old follow-ups keep this badge

// Active, Lazy and Tough stay valid for stored data and old follow-up badges, but can't be chosen (Active is now Positive).
const LEAD_STATUSES = [INQUIRY, CONTACTED, POSITIVE, RESERVATION, ACTIVE, LAZY, TOUGH, NOT_NOW, NEGATIVE, UNHAPPY, DEAD, WRONG, WON];
const SELECTABLE_LEAD_STATUSES = [CONTACTED, POSITIVE, NOT_NOW, NEGATIVE, UNHAPPY, DEAD, WRONG];
const LEAD_CATEGORIES = [INQUIRY, CONTACTED, POSITIVE, RESERVATION, ...SELECTABLE_LEAD_STATUSES.filter(value => value !== CONTACTED && value !== POSITIVE)];
const FOLLOW_UP_BADGES = [...LEAD_STATUSES, PROPOSAL_SENT];
const DEFAULT_LEAD_STATUS = CONTACTED;
// A new request is added to a lead in one of these instead of creating another lead.
const OPEN_LEAD_STATUSES = [CONTACTED, POSITIVE, ACTIVE, LAZY, TOUGH, NOT_NOW, UNHAPPY];
// A lead may have no name only here: an Inquiry has just a number, the admin can drop one as Negative or Wrong without finding its name, and such a lead can then go Dead.
// A Reservation lead is a website account's, whose name may be empty (models/userModel.js).
const NAME_OPTIONAL_STATUSES = [INQUIRY, RESERVATION, NOT_NOW, NEGATIVE, DEAD, WRONG];
// Broadcast's Proposal Sent group: the badge plus one of these.
const PROPOSAL_GROUP_STATUSES = [CONTACTED, POSITIVE, ACTIVE, LAZY, TOUGH];
// Never marketed to (helpers/leadContactBlock.js).
const NO_MARKETING_STATUSES = [DEAD, WRONG];

// How a client generally behaves, kept apart from the client's Won status (lead.clientBehaviour). No value means Neutral.
// It only says whether the client may be marketed to (owner, 8 Nov 2026): Neutral = yes; Not Now and Unhappy = no
// Broadcast; Negative = the final message; Dead = never. Selling one offer to a client is that offer's stage.
const CLIENT_BEHAVIOURS = [CONTACTED, NOT_NOW, NEGATIVE, UNHAPPY, DEAD];
// Older values stay valid on stored clients until the admin changes them; none of them can be chosen.
const STORED_CLIENT_BEHAVIOURS = [INQUIRY, POSITIVE, ACTIVE, LAZY, TOUGH, ...CLIENT_BEHAVIOURS];
const DEFAULT_CLIENT_BEHAVIOUR = CONTACTED;
/** The behaviour a lead starts with on becoming a client: Not Now, Unhappy and Negative carry over, everything else is Neutral. */
const behaviourFromStatus = (status) => ([LAZY, TOUGH].includes(status) ? NOT_NOW : [NOT_NOW, UNHAPPY, NEGATIVE].includes(status) ? status : DEFAULT_CLIENT_BEHAVIOUR);
/** A Broadcast may reach this client: Neutral only (no saved value counts as Neutral). */
const MARKETABLE_CLIENT_BEHAVIOURS = [null, DEFAULT_CLIENT_BEHAVIOUR];

// A person's stage in one offer (models/offerTargetModel.js). Won is set only by Bought this offer, or a project made on
// the person's reservation. Reservation and Not Now are set only by the reservation (helpers/reservationStage.js).
const OFFER_STAGES = [CONTACTED, POSITIVE, RESERVATION, NOT_NOW, NEGATIVE, WON];
const SELECTABLE_OFFER_STAGES = [CONTACTED, POSITIVE, NEGATIVE];

const leadStatusLabel = (status) => (status === CONTACTED ? "Neutral" : status === WON ? "Matured" : status === NOT_NOW ? "Not Now" : status);
const toOption = (value) => ({ value, label: leadStatusLabel(value) });
/** The choices the website's offer people panel shows, from these lists (merasoftware offer-targets-panel.tsx).
 *  stages can be chosen, allStages are every stage a person can be in (filter and counts);
 *  behaviours are both what a client can be set to and the client filter; leadCategories filter leads; labels name
 *  every stored value, older ones included. */
const offerPanelOptions = () => ({
  labels: Object.fromEntries(FOLLOW_UP_BADGES.map(value => [value, leadStatusLabel(value)])),
  stages: SELECTABLE_OFFER_STAGES.map(toOption),
  allStages: OFFER_STAGES.map(toOption),
  behaviours: CLIENT_BEHAVIOURS.map(toOption),
  leadCategories: LEAD_CATEGORIES.map(toOption),
});

/** What a client who referred this lead may see. Our categories for a person stay inside the team. */
const referredLeadStatus = (status) => (status === WON ? "Matured" : [NEGATIVE, DEAD, WRONG].includes(status) ? "Closed" : "In progress");

module.exports = {
  INQUIRY, RESERVATION, CONTACTED, POSITIVE, ACTIVE, LAZY, TOUGH, NOT_NOW, NEGATIVE, UNHAPPY, DEAD, WRONG, WON, PROPOSAL_SENT,
  LEAD_CATEGORIES, LEAD_STATUSES, SELECTABLE_LEAD_STATUSES, FOLLOW_UP_BADGES, DEFAULT_LEAD_STATUS, OPEN_LEAD_STATUSES, NAME_OPTIONAL_STATUSES,
  PROPOSAL_GROUP_STATUSES, NO_MARKETING_STATUSES, CLIENT_BEHAVIOURS, STORED_CLIENT_BEHAVIOURS, DEFAULT_CLIENT_BEHAVIOUR, behaviourFromStatus,
  MARKETABLE_CLIENT_BEHAVIOURS, OFFER_STAGES, SELECTABLE_OFFER_STAGES, leadStatusLabel, offerPanelOptions, referredLeadStatus,
};
