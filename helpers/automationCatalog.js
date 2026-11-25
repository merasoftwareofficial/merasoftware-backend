const { SELECTABLE_LEAD_STATUSES, leadStatusLabel } = require('./leadStatuses');

/**
 * Single Source of Truth (SSOT) catalog for Automated Message System Conditions & System Actions.
 * Served live via GET /api/auto-reply/actions (both `view=catalog` and full view) so the admin
 * form and backend rule compiler/worker always share one authoritative definition.
 */

const leadStageOptions = () =>
  SELECTABLE_LEAD_STATUSES.map(value => ({ value, label: leadStatusLabel(value) }));

const CONDITION_CATALOG = [
  {
    key: 'any',
    ruleKey: 'anytime',
    label: 'No extra condition (always run)',
    group: 'General',
    description: 'Runs unconditionally whenever the trigger fires.',
    entityTypes: ['*'],
    usableIn: ['reminder', 'escalation'],
  },
  {
    key: 'not_stopped',
    ruleKey: 'not_stopped',
    label: 'Still not stopped by any Stop trigger',
    group: 'General',
    description: 'True if none of the configured Stop triggers occurred before the wait period ended.',
    entityTypes: ['*'],
    usableIn: ['escalation'],
  },
  {
    key: 'unpaid',
    ruleKey: 'unpaid',
    label: 'Payment is still unpaid',
    group: 'Payments & Invoices',
    description: 'True when the invoice or order still has an unpaid balance (and no UPI approval is pending).',
    entityTypes: ['invoice', 'order'],
    usableIn: ['reminder', 'escalation'],
  },
  {
    key: 'pending_approval',
    ruleKey: 'pending_approval',
    label: 'UPI submitted — waiting for admin approval',
    group: 'Payments & Invoices',
    description: 'True when a client-submitted payment is waiting for admin verification.',
    entityTypes: ['invoice', 'order'],
    usableIn: ['reminder', 'escalation'],
  },
  {
    key: 'paid',
    ruleKey: 'paid',
    label: 'Payment is already paid',
    group: 'Payments & Invoices',
    description: 'True when the linked invoice or order is fully paid.',
    entityTypes: ['invoice', 'order'],
    usableIn: ['reminder', 'escalation'],
  },
  {
    key: 'installment_due',
    ruleKey: 'installment_due',
    label: 'Installment is due (unpaid)',
    group: 'Payments & Invoices',
    description: 'True when the current milestone installment is due and unpaid.',
    entityTypes: ['invoice', 'order'],
    usableIn: ['reminder', 'escalation'],
  },
  {
    key: 'upload_pending',
    ruleKey: 'upload_pending',
    label: 'Client data upload is pending',
    group: 'Data Uploads & Plans',
    description: 'True when the client has not uploaded any data/files in the current plan cycle.',
    entityTypes: ['invoice', 'order'],
    usableIn: ['reminder', 'escalation'],
  },
  {
    key: 'progress_min',
    ruleKey: 'anytime',
    label: 'Project progress is at least (%)',
    group: 'Projects',
    description: 'True when project completion percentage is greater than or equal to the threshold.',
    entityTypes: ['order'],
    requiresFeature: 'progress',
    usableIn: ['reminder', 'escalation'],
    valueConfig: { min: 0, max: 100, defaultVal: 50, unit: '%' },
  },
  {
    key: 'progress_max',
    ruleKey: 'anytime',
    label: 'Project progress is at most (%)',
    group: 'Projects',
    description: 'True when project completion percentage is less than or equal to the threshold.',
    entityTypes: ['order'],
    requiresFeature: 'progress',
    usableIn: ['reminder', 'escalation'],
    valueConfig: { min: 0, max: 100, defaultVal: 50, unit: '%' },
  },
  {
    key: 'limit_min',
    ruleKey: 'anytime',
    label: 'Portal upload limit remaining is at least',
    group: 'Data Uploads & Plans',
    description: 'True when remaining portal upload allowance is at least the specified count.',
    entityTypes: ['invoice', 'order'],
    requiresFeature: 'limit',
    usableIn: ['reminder', 'escalation'],
    valueConfig: { min: 0, max: 1000, defaultVal: 1 },
  },
  {
    key: 'limit_max',
    ruleKey: 'anytime',
    label: 'Portal upload limit remaining is at most',
    group: 'Data Uploads & Plans',
    description: 'True when remaining portal upload allowance is at most the specified count.',
    entityTypes: ['invoice', 'order'],
    requiresFeature: 'limit',
    usableIn: ['reminder', 'escalation'],
    valueConfig: { min: 0, max: 1000, defaultVal: 2 },
  },
];

function buildSystemActionCatalog() {
  const stages = leadStageOptions();
  const defaultStage = stages[0]?.value || 'Contacted';

  return [
    {
      key: 'stage.continue',
      label: 'Continue to Next Trail Stage (Template & Reminder)',
      group: 'Trail Flow',
      description: 'Hands off to the next stage in this trail so you can send follow-up templates, reminders, and another action.',
      entityTypes: ['*'],
      usableIn: ['escalation'],
      controls: [],
    },
    {
      key: 'plan.deactivation_countdown',
      label: 'Start Plan Deactivation Countdown (Grace Days)',
      group: 'Plans & Services',
      description: 'Starts a visible deactivation countdown on the client portal and applies the final status when grace days end.',
      entityTypes: ['invoice', 'order'],
      emitsTrigger: 'plan.expired',
      usableIn: ['escalation', 'stage_start'],
      controls: [
        { key: 'graceDays', label: 'Deactivation grace days', type: 'number', min: 1, max: 90, defaultVal: 3, unit: 'days' },
        {
          key: 'finalStatus',
          label: 'After countdown ends',
          type: 'select',
          defaultVal: 'expired',
          options: [
            { value: 'expired', label: 'Expire / Deactivate Plan (shows Expired)' },
            { value: 'paused', label: 'Pause Plan (blocks uploads until resumed)' },
          ],
        },
        { key: 'showPortalBanner', label: 'Show days remaining on client portal', type: 'boolean', defaultVal: true },
        { key: 'autoRecoverOnStop', label: 'Auto-cancel countdown if stop trigger happens', type: 'boolean', defaultVal: true },
      ],
    },
    {
      key: 'plan.pause',
      label: 'Pause Service / Monthly Plan',
      group: 'Plans & Services',
      description: 'Sets servicePlanStatus to paused (blocks portal data uploads via existing upload policy).',
      entityTypes: ['invoice', 'order'],
      usableIn: ['escalation', 'stage_start'],
      controls: [
        { key: 'autoRecoverOnStop', label: 'Auto-resume plan if stop trigger happens', type: 'boolean', defaultVal: true },
      ],
    },
    {
      key: 'plan.expire',
      label: 'Expire / Deactivate Service Plan',
      group: 'Plans & Services',
      description: 'Marks the service plan expired, shows Expired on the client portal, blocks uploads, and fires plan.expired.',
      entityTypes: ['invoice', 'order'],
      emitsTrigger: 'plan.expired',
      usableIn: ['escalation', 'stage_start'],
      controls: [
        { key: 'autoRecoverOnStop', label: 'Auto-reactivate if stop trigger happens', type: 'boolean', defaultVal: false },
      ],
    },
    {
      key: 'plan.stop_renewal',
      label: 'Stop Plan Auto-Renewal',
      group: 'Plans & Services',
      description: 'Stops future automatic renewal cycles using existing stopServiceRenewal lifecycle logic.',
      entityTypes: ['invoice', 'order'],
      usableIn: ['escalation', 'stage_start'],
      controls: [],
    },
    {
      key: 'lead.create',
      label: 'Create New Lead (if not existing)',
      group: 'Leads & CRM',
      description: 'Creates a lead for this contact if no active lead exists yet.',
      entityTypes: ['*'],
      usableIn: ['escalation', 'stage_start'],
      controls: [
        { key: 'stage', label: 'Initial lead stage', type: 'select', defaultVal: defaultStage, options: stages },
        { key: 'note', label: 'Initial note', type: 'text', defaultVal: '', maxLength: 300, placeholder: 'Optional follow-up note…' },
      ],
    },
    {
      key: 'lead.change_stage',
      label: 'Change Lead Stage',
      group: 'Leads & CRM',
      description: 'Updates the linked lead stage and records an automatic follow-up entry.',
      entityTypes: ['*'],
      usableIn: ['escalation', 'stage_start'],
      controls: [
        { key: 'stage', label: 'Target lead stage', type: 'select', defaultVal: defaultStage, options: stages },
      ],
    },
    {
      key: 'lead.add_note',
      label: 'Add Lead Follow-up Note',
      group: 'Leads & CRM',
      description: 'Appends a rendered follow-up note on the linked lead record.',
      entityTypes: ['*'],
      usableIn: ['escalation', 'stage_start'],
      controls: [
        { key: 'note', label: 'Follow-up note', type: 'text', defaultVal: '', maxLength: 500, placeholder: 'Write note (supports {{name}}, {{planName}}…)…' },
      ],
    },
    {
      key: 'reminders.stop_all',
      label: 'Stop All Other Scheduled Reminders',
      group: 'Trail Flow',
      description: 'Cancels other pending scheduled reminders for this client/lead.',
      entityTypes: ['*'],
      usableIn: ['escalation', 'stage_start'],
      controls: [],
    },
  ];
}

const CONDITION_KEYS = new Set(CONDITION_CATALOG.map(c => c.key));
const SYSTEM_ACTION_CATALOG = buildSystemActionCatalog();
const SYSTEM_ACTION_KEYS = new Set(SYSTEM_ACTION_CATALOG.map(a => a.key));

function getAutomationCatalog() {
  return {
    conditions: CONDITION_CATALOG,
    systemActions: buildSystemActionCatalog(),
  };
}

module.exports = {
  CONDITION_CATALOG,
  CONDITION_KEYS,
  SYSTEM_ACTION_CATALOG,
  SYSTEM_ACTION_KEYS,
  buildSystemActionCatalog,
  getAutomationCatalog,
};
