// Built-in templates. Each migrated action owns, in this one place: its variables with
// sample values, its original wording, and how its business data becomes those variables.
// The wording is copied once into the database as the action's editable system template;
// the copy here stays the original for "Reset to original". Actions not listed here still
// use their legacy code-built HTML (emailService.js) until they are migrated.
const mongoose = require('mongoose');
const { EmailTemplate } = require('../models/emailControlModel');
const { byKey } = require('./emailCatalog');
const { formatIndiaDateTime } = require('./dateTime');
const { getOrderDisplayName } = require('./orderPresentation');
const { render, compose, placeholders, tableBlock, withRequiredLinks } = require('./emailMarkup');

const SYSTEM_NAME = 'Standard';
const LEGACY_BUILT_IN = 'Built-in action template';
const money = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
const REFUND_METHODS = { wallet: 'Wallet', upi: 'UPI', cash: 'Cash', bank_transfer: 'Bank Transfer', cheque: 'Cheque', combined: 'Combined', demo: 'Demo Credit' };

function refundTable(refunds) {
  const rows = refunds.map(entry => [
    REFUND_METHODS[entry.method] || entry.method || 'Refund',
    money(entry.amount),
    entry.method === 'wallet' ? 'Credited to your wallet' : `Reference: ${entry.referenceId || 'N/A'}`,
  ]);
  const total = refunds.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  return tableBlock('Refund Details', rows, ['Total Refunded', money(total), '']);
}

const definitions = {
  sendProjectCreatedEmail: {
    subject: 'Your Project Has Started',
    text: [
      'Hello {{name}},', '',
      'We have created your project and work has begun. The details are below.', '',
      '## Project Details',
      '**Project:** {{project}}', '**Price:** {{price}}', '**Offer:** {{offer}}', '**Started On:** {{startedOn}}', '',
      '## Payment',
      '{{paymentPlan}}', '**Received so far:** {{receivedSoFar}}', '**Due now:** {{dueNow}}', '',
      "You can follow your project's progress from your account at any time.", '',
      'Best regards,', 'Mera Software Team',
    ].join('\n'),
    variables: {
      name: { label: 'Customer name', sample: 'Ravi Kumar' },
      project: { label: 'Project name', sample: 'Business Website' },
      price: { label: 'Price (or FREE)', sample: '₹25,000' },
      offer: { label: 'Offer title (empty when none)', sample: 'Diwali Offer' },
      startedOn: { label: 'Start date and time', sample: '17 Oct 2026, 11:30 am' },
      paymentPlan: { label: 'Payment plan sentence', sample: 'Payable in 2 installments: ₹12,500 + ₹12,500.' },
      receivedSoFar: { label: 'Amount received (empty when nothing paid)', sample: '' },
      dueNow: { label: 'Amount due now with invoice (empty when free or paid)', sample: '₹12,500 (invoice INV-1001)' },
    },
    blocks: {},
    build(user, order, invoice) {
      if (!user?.email) return null;
      const total = Number(order.totalAmount || order.price || 0);
      const isFree = total === 0;
      const installments = Array.isArray(order.installments) ? order.installments : [];
      const paidNow = Number(order.paidAmount || 0);
      let paymentPlan = `One-time payment of ${money(total)}.`;
      if (isFree) paymentPlan = 'This project is FREE — nothing is due.';
      else if (order.isPartialPayment && installments.length) paymentPlan = `Payable in ${installments.length} installments: ${installments.map(item => money(item.amount)).join(' + ')}.`;
      const due = `${money(invoice?.amount ?? total)}${invoice?.invoiceNumber ? ` (invoice ${invoice.invoiceNumber})` : ''}`;
      return { to: [user.email], values: {
        name: user.name || 'Customer', project: getOrderDisplayName(order), price: isFree ? 'FREE' : money(total),
        offer: order.projectSnapshot?.offer?.title || '', startedOn: formatIndiaDateTime(Date.now()), paymentPlan,
        receivedSoFar: !isFree && paidNow > 0 ? money(paidNow) : '', dueNow: !isFree && paidNow <= 0 ? due : '',
      } };
    },
  },
  sendProjectCancellationEmail: {
    subject: 'Project Cancelled',
    text: [
      'Hello {{name}},', '',
      'Your project has been cancelled. The details are below.', '',
      '## Project Details',
      '**Project:** {{project}}', '**Cancelled On:** {{cancelledOn}}', '**Reason:** {{reason}}', '',
      '{{refundTable}}', '',
      'If you have any questions about this cancellation or the refund, please contact our support team.', '',
      'Best regards,', 'Mera Software Team',
    ].join('\n'),
    variables: {
      name: { label: 'Customer name', sample: 'Ravi Kumar' },
      project: { label: 'Project name', sample: 'Business Website' },
      cancelledOn: { label: 'Cancellation date and time', sample: '17 Oct 2026, 11:30 am' },
      reason: { label: 'Cancellation reason (empty when none)', sample: 'Requirements changed' },
    },
    blocks: {
      refundTable: { label: 'Refund details table (empty when nothing refunded)', sample: () => refundTable([{ method: 'wallet', amount: 5000 }, { method: 'upi', amount: 2500, referenceId: 'UPI123456' }]) },
    },
    build(user, order, refunds = [], cancellationReason = '') {
      if (!user?.email) return null;
      return {
        to: [user.email],
        values: { name: user.name || 'Customer', project: getOrderDisplayName(order), cancelledOn: formatIndiaDateTime(Date.now()), reason: cancellationReason || '' },
        blocks: { refundTable: refundTable(refunds) },
      };
    },
  },
};

const LEGACY_VARIABLES = {
  subject: { label: 'Original subject', sample: 'Sample subject' },
  message: { label: 'Original message', sample: 'Sample action message' },
};
const LEAD_VARIABLES = { name: { label: 'Lead name', sample: 'Sample customer' } };
const hasSystemTemplate = event => Object.prototype.hasOwnProperty.call(definitions, event);

function variablesFor(event) {
  if (hasSystemTemplate(event)) return { variables: definitions[event].variables, blocks: definitions[event].blocks };
  return { variables: { ...LEGACY_VARIABLES, ...(event === 'lead.created' ? LEAD_VARIABLES : {}) }, blocks: {} };
}

/** What the template editors show per action: variables, blocks, and the kind of built-in. */
function catalogFor(events) {
  return Object.fromEntries(events.map(({ key }) => {
    const { variables, blocks } = variablesFor(key);
    return [key, {
      system: hasSystemTemplate(key),
      variables: Object.entries(variables).map(([name, { label }]) => ({ key: name, label })),
      blocks: Object.entries(blocks).map(([name, { label }]) => ({ key: name, label })),
    }];
  }));
}

function sampleContext(event) {
  const { variables, blocks } = variablesFor(event);
  return {
    values: Object.fromEntries(Object.entries(variables).map(([key, { sample }]) => [key, sample])),
    blocks: Object.fromEntries(Object.entries(blocks).map(([key, { sample }]) => [key, sample()])),
  };
}

function validateTemplateVariables(event, subject, text) {
  const { variables, blocks } = variablesFor(event);
  const unknown = placeholders(`${subject}\n${text}`).filter(key => !Object.prototype.hasOwnProperty.call(variables, key) && !Object.prototype.hasOwnProperty.call(blocks, key));
  if (unknown.length) throw new Error(`Unknown variable for this action: ${unknown.map(key => `{{${key}}}`).join(', ')}`);
  for (const key of Object.keys(blocks)) {
    if (placeholders(subject).includes(key)) throw new Error(`{{${key}}} is a section and cannot be used in the subject`);
    const misplaced = String(text).split(/\r?\n/).some(line => placeholders(line).includes(key) && !new RegExp(`^\\s*\\{\\{\\s*${key}\\s*\\}\\}\\s*$`).test(line));
    if (misplaced) throw new Error(`{{${key}}} is a section; put it on its own line`);
  }
}

/** The action's editable built-in template, created from the original on first use. */
async function systemTemplate(event) {
  if (!hasSystemTemplate(event)) return null;
  const filter = { event, system: true };
  const { subject, text } = definitions[event];
  try {
    return await EmailTemplate.findOneAndUpdate(filter, { $setOnInsert: { name: SYSTEM_NAME, subject, text } }, { upsert: true, new: true }).lean();
  } catch (error) {
    // Two first uses at once: the unique index lets one insert win.
    if (error.code === 11000) return EmailTemplate.findOne(filter).lean();
    throw error;
  }
}

const ensureSystemTemplates = application => Promise.all(Object.keys(definitions)
  .filter(event => byKey.get(event)?.application === application).map(systemTemplate));

/**
 * The template a choice means. An id must belong to the action; no id means the action's
 * built-in: its system template, or null for an action still on legacy code-built HTML.
 */
async function resolveTemplate(event, templateId) {
  if (!templateId) return systemTemplate(event);
  const template = mongoose.isValidObjectId(templateId) && await EmailTemplate.findOne({ _id: templateId, event }).lean();
  if (!template) throw new Error('Choose a template for this action');
  return template;
}

async function resetSystemTemplate(id) {
  const current = mongoose.isValidObjectId(id) && await EmailTemplate.findById(id).lean();
  if (!current) throw new Error('Template not found');
  if (!current.system) throw new Error('Only built-in templates can be reset');
  const { subject, text } = definitions[current.event];
  return EmailTemplate.findByIdAndUpdate(current._id, { $set: { subject, text } }, { new: true }).lean();
}

/** Fills a template for one mail: the reviewable text plus the HTML and plain parts sent. */
function composeTemplate(template, values, blocks, requiredLinks = []) {
  const text = withRequiredLinks(render(template.text, values, blocks), requiredLinks);
  const mail = compose(text, blocks);
  return { templateName: template.name, subject: render(template.subject, values), text, html: mail.html, plain: mail.text };
}

function buildTemplatedMail(event, ...args) {
  return definitions[event].build(...args);
}

module.exports = {
  LEGACY_BUILT_IN, hasSystemTemplate, catalogFor, sampleContext, validateTemplateVariables,
  systemTemplate, ensureSystemTemplates, resolveTemplate, resetSystemTemplate, composeTemplate, buildTemplatedMail,
};
