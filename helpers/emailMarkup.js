// The one renderer for reusable email templates and reviewed drafts.
// Templates are plain text with a small markup, so admins never write HTML and every
// value stays escaped: **bold**, "## " headings, "- " list items and bare https:// links.
// A block variable such as {{refundTable}} on its own line inserts a section the action
// builds itself (tables of refunds, items). Every mail shares the branded layout below.
const { indiaYear } = require('./dateTime');

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const BLOCK_LINE = /^\{\{\s*(\w+)\s*\}\}$/;
const URL_PATTERN = /https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g;
// Website logo palette (merasoftware/src/app/brand-colors.css).
const COLORS = { navy: '#00243d', teal: '#007f99', link: '#006b80', paper: '#f4f8fc', line: '#ccdce8', muted: '#4c6475', ink: '#1f2d3a' };

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Lean drafts carry Maps as objects; hydrated documents carry real Maps.
const asObject = value => (value instanceof Map ? Object.fromEntries(value) : value || {});
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function placeholders(template) {
  return [...new Set([...String(template).matchAll(PLACEHOLDER)].map(match => match[1]))];
}

/**
 * Fills {{variables}} with literal values. A block variable keeps its token for compose();
 * a line whose every placeholder is empty is removed, so optional details need no logic.
 */
function render(template, values = {}, blocks = {}) {
  const text = asObject(values); const sections = asObject(blocks);
  return String(template).split(/\r?\n/).flatMap(line => {
    let found = 0; let filled = 0;
    const output = line.replace(PLACEHOLDER, (_, key) => {
      found += 1;
      if (has(sections, key)) {
        if (!sections[key]?.html) return '';
        filled += 1; return `{{${key}}}`;
      }
      const value = has(text, key) ? String(text[key] ?? '') : '';
      if (value) filled += 1;
      return value;
    });
    return found && !filled ? [] : [output];
  }).join('\n');
}

function withRequiredLinks(text, links = []) {
  const missing = links.filter(link => !text.includes(link));
  return missing.length ? `${text}\n\n${missing.join('\n')}` : text;
}

const inlineText = text => text.replace(/\*\*(.+?)\*\*/g, '$1');
const inlineHtml = text => escapeHtml(text)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(URL_PATTERN, url => `<a href="${url}" style="color:${COLORS.link}">${url}</a>`);

function layout(content) {
  return `<div style="margin:0;padding:24px 12px;background:${COLORS.paper};font-family:Arial,Helvetica,sans-serif;color:${COLORS.ink}">`
    + `<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid ${COLORS.line};border-radius:12px;overflow:hidden">`
    + `<div style="background:${COLORS.navy};color:#ffffff;padding:18px 24px;font-size:20px;font-weight:bold">Mera Software</div>`
    + `<div style="padding:24px;font-size:15px;line-height:1.6">${content}</div>`
    + `<div style="padding:14px 24px;border-top:1px solid ${COLORS.line};text-align:center;font-size:12px;color:${COLORS.muted}">© ${indiaYear(Date.now())} Mera Software. All rights reserved.</div>`
    + '</div></div>';
}

/** Turns filled template text into the final mail: branded HTML and its plain-text part. */
function compose(source, blocks = {}) {
  const sections = asObject(blocks);
  const html = []; const text = [];
  let paragraph = []; let list = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p style="margin:0 0 14px">${paragraph.map(inlineHtml).join('<br>')}</p>`);
    text.push(paragraph.map(inlineText).join('\n')); paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    html.push(`<ul style="margin:0 0 14px;padding-left:22px">${list.map(item => `<li>${inlineHtml(item)}</li>`).join('')}</ul>`);
    text.push(list.map(item => `- ${inlineText(item)}`).join('\n')); list = [];
  };
  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const block = line.trim().match(BLOCK_LINE);
    if (!line.trim() || (block && has(sections, block[1])) || line.startsWith('## ')) { flushParagraph(); flushList(); }
    if (!line.trim()) continue;
    if (block && has(sections, block[1])) {
      if (sections[block[1]]?.html) { html.push(sections[block[1]].html); text.push(sections[block[1]].text || ''); }
    } else if (line.startsWith('## ')) {
      html.push(`<h2 style="margin:22px 0 10px;font-size:17px;color:${COLORS.teal}">${inlineHtml(line.slice(3))}</h2>`);
      text.push(inlineText(line.slice(3)));
    } else if (line.startsWith('- ')) {
      flushParagraph(); list.push(line.slice(2));
    } else {
      flushList(); paragraph.push(line);
    }
  }
  flushParagraph(); flushList();
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

module.exports = { render, compose, layout, placeholders, tableBlock, withRequiredLinks, escapeHtml };
