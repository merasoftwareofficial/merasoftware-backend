// The one renderer for reusable email templates and reviewed drafts.
// Templates are stored as plain text with a small markup — **bold**, "## " headings,
// "- " list items and bare https:// links — that admins never see: the visual editor's
// document is converted to and from it by emailDoc.js. A backslash makes the next of
// \ * # - { a literal character, so typed text and filled values can never turn into
// formatting. A block variable such as {{refundTable}} on its own line inserts a section the
// action builds itself (tables of refunds, items). Every mail shares the branded layout below.
const { indiaYear } = require('./dateTime');

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const BLOCK_LINE = /^\{\{\s*(\w+)\s*\}\}$/;
// Found in unescaped text, so quotes and brackets around a link stay outside it.
const URL_PATTERN = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g;
// Website logo palette (merasoftware/src/app/brand-colors.css).
const COLORS = { navy: '#00243d', teal: '#007f99', link: '#006b80', paper: '#f4f8fc', line: '#ccdce8', muted: '#4c6475', ink: '#1f2d3a' };

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Lean drafts carry Maps as objects; hydrated documents carry real Maps.
const asObject = value => (value instanceof Map ? Object.fromEntries(value) : value || {});
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// While parsing, an escaped character is held as a private-use character so no markup rule
// can match it; restore() turns it back into the literal character (or its escape).
const ESCAPABLE = '\\*#-{';
const protect = text => String(text).replace(/\\([\\*#{-])/g, (_, c) => String.fromCharCode(0xE000 + ESCAPABLE.indexOf(c)));
const restore = (text, keepEscapes = false) => text.replace(/[\uE000-\uE004]/g, c => (keepEscapes ? '\\' : '') + ESCAPABLE[c.charCodeAt(0) - 0xE000]);
/** Makes any text literal inside markup. */
const escapeMarkup = value => String(value).replace(/[\\*{]/g, '\\$&').replace(/^[#-]/gm, '\\$&');

function placeholders(template) {
  return [...new Set([...protect(template).matchAll(PLACEHOLDER)].map(match => match[1]))];
}

/**
 * Fills {{variables}}. Values are inserted literally (escaped for markup; as is with `plain`,
 * which subjects use). A block variable keeps its token for compose(); a message line whose
 * every placeholder is empty is removed, so optional details need no logic. A subject is one
 * line and is never removed: its empty details are simply left out.
 */
function render(template, values = {}, blocks = {}, { plain = false } = {}) {
  const text = asObject(values); const sections = asObject(blocks);
  const lines = protect(template).split(/\r?\n/).flatMap(line => {
    let found = 0; let filled = 0;
    const output = line.replace(PLACEHOLDER, (_, key) => {
      found += 1;
      if (has(sections, key)) {
        if (!sections[key]?.html) return '';
        filled += 1; return `{{${key}}}`;
      }
      const value = has(text, key) ? String(text[key] ?? '') : '';
      if (value) filled += 1;
      return plain ? value : escapeMarkup(value);
    });
    return found && !filled && !plain ? [] : [output];
  });
  return restore(lines.join('\n'), !plain);
}

function withRequiredLinks(text, links = []) {
  const missing = links.filter(link => !text.includes(link));
  return missing.length ? `${text}\n\n${missing.join('\n')}` : text;
}

function linkedHtml(text) {
  let html = ''; let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = escapeHtml(restore(match[0]));
    html += `${escapeHtml(text.slice(last, match.index))}<a href="${url}" style="color:${COLORS.link}">${url}</a>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}
// Both take a protected line.
const inlineHtml = line => restore(line.split(/\*\*(.+?)\*\*/g).map((part, index) => (index % 2 ? `<strong>${linkedHtml(part)}</strong>` : linkedHtml(part))).join(''));
const inlineText = line => restore(line.replace(/\*\*(.+?)\*\*/g, '$1'));

function layout(content) {
  return `<div style="margin:0;padding:24px 12px;background:${COLORS.paper};font-family:Arial,Helvetica,sans-serif;color:${COLORS.ink}">`
    + `<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid ${COLORS.line};border-radius:12px;overflow:hidden">`
    + `<div style="background:${COLORS.navy};color:#ffffff;padding:18px 24px;font-size:20px;font-weight:bold">Mera Software</div>`
    + `<div style="padding:24px;font-size:15px;line-height:1.6">${content}</div>`
    + `<div style="padding:14px 24px;border-top:1px solid ${COLORS.line};text-align:center;font-size:12px;color:${COLORS.muted}">© ${indiaYear(Date.now())} Mera Software. All rights reserved.</div>`
    + '</div></div>';
}

/**
 * Splits filled template text into its structure: paragraphs (lines), "## " headings,
 * "- " list items and own-line section blocks. Lines stay protected for inline parsing.
 * compose() and emailDoc.markupToDoc() read the same structure.
 */
function parseBlocks(source, isSection) {
  const blocks = []; let paragraph = []; let list = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', lines: paragraph });
    if (list.length) blocks.push({ type: 'list', items: list });
    paragraph = []; list = [];
  };
  for (const raw of protect(source).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const block = line.trim().match(BLOCK_LINE);
    if (!line.trim()) { flush(); continue; }
    if (block && isSection(block[1])) { flush(); blocks.push({ type: 'section', key: block[1] }); continue; }
    if (line.startsWith('## ')) { flush(); blocks.push({ type: 'heading', line: line.slice(3) }); continue; }
    if (line.startsWith('- ')) {
      if (paragraph.length) flush();
      list.push(line.slice(2)); continue;
    }
    if (list.length) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Turns filled template text into the final mail: branded HTML and its plain-text part. */
function compose(source, blocks = {}) {
  const sections = asObject(blocks);
  const html = []; const text = [];
  for (const block of parseBlocks(source, key => has(sections, key))) {
    if (block.type === 'section') {
      if (sections[block.key]?.html) { html.push(sections[block.key].html); text.push(sections[block.key].text || ''); }
    } else if (block.type === 'heading') {
      html.push(`<h2 style="margin:22px 0 10px;font-size:17px;color:${COLORS.teal}">${inlineHtml(block.line)}</h2>`);
      text.push(inlineText(block.line));
    } else if (block.type === 'list') {
      html.push(`<ul style="margin:0 0 14px;padding-left:22px">${block.items.map(item => `<li>${inlineHtml(item)}</li>`).join('')}</ul>`);
      text.push(block.items.map(item => `- ${inlineText(item)}`).join('\n'));
    } else {
      html.push(`<p style="margin:0 0 14px">${block.lines.map(inlineHtml).join('<br>')}</p>`);
      text.push(block.lines.map(inlineText).join('\n'));
    }
  }
  return { html: layout(html.join('')), text: text.join('\n\n') };
}

/** A section for list data; every cell is escaped here. Empty rows give an empty block. */
function tableBlock(title, rows, totalRow) {
  if (!rows.length) return { html: '', text: '' };
  const cell = (value, index, strong) => `<td style="padding:8px 0;border-bottom:1px solid ${COLORS.line};${index ? 'text-align:right;' : ''}${index === 2 ? `color:${COLORS.muted};font-size:13px;` : ''}">${strong ? `<strong>${escapeHtml(value)}</strong>` : escapeHtml(value)}</td>`;
  const body = [...rows.map(row => row.map((value, index) => cell(value, index, index === 0))), ...(totalRow ? [totalRow.map((value, index) => cell(value, index, true))] : [])];
  return {
    html: `<h2 style="margin:22px 0 10px;font-size:17px;color:${COLORS.teal}">${escapeHtml(title)}</h2>`
      + `<table style="width:100%;border-collapse:collapse;margin:0 0 14px">${body.map(cells => `<tr>${cells.join('')}</tr>`).join('')}</table>`,
    text: [title, ...rows.map(row => row.filter(Boolean).join(' — ')), ...(totalRow ? [totalRow.filter(Boolean).join(': ')] : [])].join('\n'),
  };
}

/** A section for a list the action collects (instructions); every item is escaped here. */
function listBlock(title, items) {
  if (!items.length) return { html: '', text: '' };
  return {
    html: `<h2 style="margin:22px 0 10px;font-size:17px;color:${COLORS.teal}">${escapeHtml(title)}</h2>`
      + `<ul style="margin:0 0 14px;padding-left:22px">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`,
    text: [title, ...items.map(item => `- ${item}`)].join('\n'),
  };
}

module.exports = { render, compose, parseBlocks, layout, placeholders, tableBlock, listBlock, withRequiredLinks, escapeHtml, escapeMarkup, protect, restore, URL_PATTERN, PLACEHOLDER, asObject, has };
