// The visual email editor (TipTap on the website and in the portal) edits a document; the
// backend stores template text (emailMarkup.js). Only this file converts between the two,
// so both apps share one conversion and stored templates never need migrating.
//
// Allowed document: paragraphs with line breaks, level-2 headings, bullet lists, bold and
// link marks, `emailVariable` (inline chip, attrs.key) and `emailSection` (block chip,
// attrs.key). Anything else is refused instead of being dropped silently.
const { parseBlocks, protect, restore, URL_PATTERN, PLACEHOLDER } = require('./emailMarkup');

const VARIABLE = 'emailVariable';
const SECTION = 'emailSection';
const TOKEN = new RegExp(`${PLACEHOLDER.source}|(${URL_PATTERN.source})`, 'g');

/** Inline nodes of one protected line: text with bold/link marks and variable chips. */
function inlineNodes(line, variables) {
  const nodes = [];
  const text = (value, marks) => { if (value) nodes.push({ type: 'text', text: restore(value), ...(marks.length ? { marks } : {}) }); };
  line.split(/\*\*(.+?)\*\*/g).forEach((part, index) => {
    const marks = index % 2 ? [{ type: 'bold' }] : [];
    let last = 0;
    for (const match of part.matchAll(TOKEN)) {
      text(part.slice(last, match.index), marks);
      if (match[1] && variables.has(match[1])) nodes.push({ type: VARIABLE, attrs: { key: match[1] }, ...(marks.length ? { marks } : {}) });
      else if (match[2]) { const url = restore(match[2]); nodes.push({ type: 'text', text: url, marks: [...marks, { type: 'link', attrs: { href: url } }] }); }
      else text(match[0], marks);
      last = match.index + match[0].length;
    }
    text(part.slice(last), marks);
  });
  return nodes;
}

const paragraph = content => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });

/** Template text → editor document. `variables`/`blocks` are the keys this text may use. */
function markupToDoc(source, { variables = [], blocks = [] } = {}) {
  const known = new Set(variables); const sections = new Set(blocks);
  const content = parseBlocks(source, key => sections.has(key)).map(block => {
    if (block.type === 'section') return { type: SECTION, attrs: { key: block.key } };
    if (block.type === 'heading') {
      const nodes = inlineNodes(block.line, known);
      return { type: 'heading', attrs: { level: 2 }, ...(nodes.length ? { content: nodes } : {}) };
    }
    if (block.type === 'list') return { type: 'bulletList', content: block.items.map(item => ({ type: 'listItem', content: [paragraph(inlineNodes(item, known))] })) };
    return paragraph(block.lines.flatMap((line, index) => [...(index ? [{ type: 'hardBreak' }] : []), ...inlineNodes(line, known)]));
  });
  return { type: 'doc', content: content.length ? content : [paragraph([])] };
}

/** Subject text (plain, may hold variables) → a one-paragraph document. */
function subjectToDoc(subject, { variables = [] } = {}) {
  const known = new Set(variables); const nodes = []; let last = 0;
  const line = protect(subject);
  const text = value => { if (value) nodes.push({ type: 'text', text: restore(value) }); };
  for (const match of line.matchAll(PLACEHOLDER)) {
    text(line.slice(last, match.index));
    if (known.has(match[1])) nodes.push({ type: VARIABLE, attrs: { key: match[1] } }); else text(match[0]);
    last = match.index + match[0].length;
  }
  text(line.slice(last));
  return { type: 'doc', content: [paragraph(nodes)] };
}

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const children = node => (Array.isArray(node?.content) ? node.content : []);
const escapeText = value => String(value).replace(/[\\*{]/g, '\\$&');
// "#" and "-" only mean something at the start of a line.
const escapeLineStarts = text => text.replace(/(^|\n)([#-])/g, '$1\\$2');

function inlineMarkup(nodes, variables, { lineBreak = '\n' } = {}) {
  return nodes.map(node => {
    const bold = (node.marks || []).some(mark => mark.type === 'bold');
    const wrap = value => (bold && value.trim() ? `**${value}**` : value);
    if (node.type === 'hardBreak') return lineBreak;
    if (node.type === VARIABLE) {
      if (!variables.has(node.attrs?.key)) fail(`This email cannot use the detail "${node.attrs?.key}"`);
      return wrap(`{{${node.attrs.key}}}`);
    }
    if (node.type !== 'text' || typeof node.text !== 'string') fail(`Unsupported content in the email: ${node.type}`);
    const link = (node.marks || []).find(mark => mark.type === 'link')?.attrs?.href;
    const text = link && link !== node.text ? `${node.text} (${link})` : node.text;
    return wrap(escapeText(text));
  }).join('');
}

/** Editor document → template text; refuses anything the renderer cannot show. */
function docToMarkup(doc, { variables = [], blocks = [] } = {}) {
  if (doc?.type !== 'doc' || !Array.isArray(doc.content)) fail('Email content is not a valid document');
  const known = new Set(variables); const sections = new Set(blocks);
  const listItems = list => children(list).flatMap(item => children(item).flatMap(child => (child.type === 'bulletList'
    ? listItems(child) // a nested list is flattened into the one level the renderer has
    : [escapeLineStarts(inlineMarkup(children(child), known, { lineBreak: ' ' }))])));
  return doc.content.map(node => {
    if (node.type === 'paragraph') return escapeLineStarts(inlineMarkup(children(node), known));
    if (node.type === 'heading') return `## ${inlineMarkup(children(node), known, { lineBreak: ' ' })}`;
    if (node.type === 'bulletList') return listItems(node).map(item => `- ${item}`).join('\n');
    if (node.type === SECTION) {
      if (!sections.has(node.attrs?.key)) fail(`This email has no section "${node.attrs?.key}"`);
      return `{{${node.attrs.key}}}`;
    }
    return fail(`Unsupported content in the email: ${node.type}`);
  }).filter(block => block.trim()).join('\n\n');
}

/** Subject document → subject text (one line; formatting is ignored). */
function docToSubject(doc, { variables = [] } = {}) {
  if (doc?.type !== 'doc' || !Array.isArray(doc.content)) fail('Subject is not a valid document');
  const known = new Set(variables);
  return doc.content.map(node => children(node).map(child => {
    if (child.type === 'hardBreak') return ' ';
    if (child.type === VARIABLE) {
      if (!known.has(child.attrs?.key)) fail(`The subject cannot use the detail "${child.attrs?.key}"`);
      return `{{${child.attrs.key}}}`;
    }
    if (child.type !== 'text' || typeof child.text !== 'string') fail(`Unsupported content in the subject: ${child.type}`);
    return child.text.replace(/[\\{]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  }).join('')).join(' ').trim();
}

module.exports = { markupToDoc, subjectToDoc, docToMarkup, docToSubject };
