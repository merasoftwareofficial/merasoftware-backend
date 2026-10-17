// Built-in templates: every action's wording, details and data mapping live in
// emailDefinitions.js. This file copies that wording once into the database as the action's
// editable system template ("Standard"), resets it, fills templates for one mail, and converts
// templates and reviews to and from the visual editor's documents.
const mongoose = require('mongoose');
const { EmailTemplate } = require('../models/emailControlModel');
const { byKey } = require('./emailCatalog');
const { definitions } = require('./emailDefinitions');
const { render, compose, placeholders, withRequiredLinks, asObject, has } = require('./emailMarkup');
const { markupToDoc, subjectToDoc, docToMarkup, docToSubject } = require('./emailDoc');

const SYSTEM_NAME = 'Standard';
// The name a mail reviewed before it was prepared carries (the lead form's popup).
const REVIEWED_NAME = 'Reviewed in popup';
const hasSystemTemplate = event => Object.prototype.hasOwnProperty.call(definitions, event);

function variablesFor(event) {
  return hasSystemTemplate(event) ? { variables: definitions[event].variables, blocks: definitions[event].blocks } : { variables: {}, blocks: {} };
}

/** What the template editors show per action: variables, blocks, and the kind of built-in. */
function catalogFor(events) {
  return Object.fromEntries(events.map(({ key }) => {
    const { variables, blocks } = variablesFor(key);
    return [key, {
      system: hasSystemTemplate(key),
      variables: Object.entries(variables).map(([name, { label, hint }]) => ({ key: name, label, ...(hint ? { hint } : {}) })),
      blocks: Object.entries(blocks).map(([name, { label, hint }]) => ({ key: name, label, ...(hint ? { hint } : {}) })),
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

/** The template a choice means. An id must belong to the action; no id means its system template. */
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
  return { templateName: template.name, subject: render(template.subject, values, {}, { plain: true }), text, html: mail.html, plain: mail.text };
}

// --- Visual editor (emailDoc.js) -------------------------------------------------------
const keysOf = event => {
  const { variables, blocks } = variablesFor(event);
  return { variables: Object.keys(variables), blocks: Object.keys(blocks) };
};
/** A template as the editor needs it: its text and subject as documents. */
function templateWithDocs(template) {
  const keys = keysOf(template.event);
  return { ...template, doc: markupToDoc(template.text, keys), subjectDoc: subjectToDoc(template.subject, keys) };
}
/** Template fields from the editor's documents; plain text from older clients is kept. */
function templateFromEditor(event, body) {
  const keys = keysOf(event);
  return {
    name: body.name,
    subject: body.subjectDoc ? docToSubject(body.subjectDoc, keys) : body.subject,
    text: body.doc ? docToMarkup(body.doc, keys) : body.text,
  };
}
/**
 * The chips a review offers: details this mail has values for, and its sections. A reviewed
 * text is filled with the same values (emailController.reviewedMail).
 */
function reviewFields(event, values, blocks) {
  const { variables, blocks: sections } = variablesFor(event);
  return {
    variables: Object.keys(asObject(values)).filter(key => has(variables, key)).map(key => ({ key, label: variables[key].label, ...(variables[key].hint ? { hint: variables[key].hint } : {}) })),
    blocks: Object.keys(asObject(blocks)).filter(key => has(sections, key)).map(key => ({ key, label: sections[key].label, ...(sections[key].hint ? { hint: sections[key].hint } : {}) })),
  };
}
const fieldKeys = fields => ({ variables: fields.variables.map(row => row.key), blocks: fields.blocks.map(row => row.key) });
/** A review as the editor needs it: its text as a document and the chips it may use. */
function reviewWithDoc(event, text, values, blocks) {
  const fields = reviewFields(event, values, blocks);
  return { doc: markupToDoc(text, fieldKeys(fields)), editorFields: fields };
}
/** Reviewed text from the editor's document; plain text from older clients is kept. */
function reviewTextFromEditor(event, body, values, blocks) {
  return body.doc ? docToMarkup(body.doc, fieldKeys(reviewFields(event, values, blocks))) : body.text;
}

/** The action's mail data ({ to, values, blocks, attachments }), or null without a recipient. */
function buildTemplatedMail(event, ...args) {
  if (typeof definitions[event]?.build !== 'function') throw new Error(`${event} has no mail builder`);
  return definitions[event].build(...args);
}

module.exports = {
  REVIEWED_NAME, hasSystemTemplate, catalogFor, sampleContext, validateTemplateVariables,
  systemTemplate, ensureSystemTemplates, resolveTemplate, resetSystemTemplate, composeTemplate, buildTemplatedMail,
  templateWithDocs, templateFromEditor, reviewWithDoc, reviewTextFromEditor,
};
