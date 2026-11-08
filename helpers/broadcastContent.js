// One canonical document and one renderer for both preview and WhatsApp queue text.
const FIELDS = [{ key: 'name', label: 'Recipient name', sample: 'Sandeep Singh' }];
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
function marksFor(value) {
  return (value.marks || []).map(mark => {
    if (!['bold', 'italic', 'link'].includes(mark.type)) fail('Unsupported message formatting.');
    if (mark.type === 'link') {
      const href = mark.attrs?.href;
      if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) fail('Use an http or https link.');
      return { type: 'link', attrs: { href } };
    }
    return { type: mark.type };
  });
}
function content(input, { fields = FIELDS, allowEmpty = false } = {}) {
  let size = 0;
  function node(value, depth = 0) {
    if (!value || depth > 12 || ++size > 4000) fail('Message is too large.');
    const { type } = value;
    if (type === 'text') {
      if (typeof value.text !== 'string' || value.text.length > 10000) fail('Invalid message text.');
      const marks = marksFor(value);
      return { type, text: value.text, ...(marks.length ? { marks } : {}) };
    }
    if (type === 'emailVariable') {
      if (!fields.some(field => field.key === value.attrs?.key)) fail('Unknown message detail.');
      const marks = marksFor(value);
      return { type, attrs: { key: value.attrs.key }, ...(marks.length ? { marks } : {}) };
    }
    if (type === 'hardBreak') return { type };
    const allowedChildren = { doc: ['paragraph', 'bulletList'], paragraph: ['text', 'emailVariable', 'hardBreak'], bulletList: ['listItem'], listItem: ['paragraph', 'bulletList'] };
    if (!allowedChildren[type] || !Array.isArray(value.content)) fail('Invalid message document.');
    const children = value.content.map(child => {
      if (!allowedChildren[type].includes(child.type)) fail('Unsupported message structure.');
      return node(child, depth + 1);
    });
    return { type, content: children };
  }
  if (input?.type !== 'doc') fail('Write a message first.');
  // Tiptap omits empty paragraph content.
  const expand = value => value && typeof value === 'object' ? { ...value, ...(['doc', 'paragraph', 'bulletList', 'listItem'].includes(value.type) ? { content: (value.content || []).map(expand) } : {}) } : value;
  const doc = node(expand(input));
  const plain = render(doc, { name: 'Recipient' });
  if (!plain.trim() && !allowEmpty) fail('Write a message first.');
  if (plain.length > 20000 || JSON.stringify(doc).length > 100000) fail('Message is too long.');
  return doc;
}
// In recipient values, break WhatsApp's formatting delimiters without interpreting values as tokens.
const literal = value => String(value || '').replace(/[\r\n]+/g, ' ').replace(/([*_~`])/g, '$1\u200b');
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function render(doc, values = {}, { html = false } = {}) {
  function visit(node) {
    if (node.type === 'hardBreak') return html ? '<br>' : '\n';
    if (node.type === 'text' || node.type === 'emailVariable') {
      const raw = node.type === 'emailVariable' ? values[node.attrs.key] || '' : node.text;
      let text = html ? escapeHtml(raw) : node.type === 'emailVariable' ? literal(raw) : raw;
      for (const mark of node.marks || []) {
        if (mark.type === 'link' && mark.attrs.href !== raw) text += ` (${html ? escapeHtml(mark.attrs.href) : mark.attrs.href})`;
        if (mark.type === 'bold' && text.trim()) text = html ? `<strong>${text}</strong>` : `*${text}*`;
        if (mark.type === 'italic' && text.trim()) text = html ? `<em>${text}</em>` : `_${text}_`;
      }
      return text;
    }
    const children = node.content || [];
    if (html) {
      const tags = { doc: 'div', paragraph: 'p', bulletList: 'ul', listItem: 'li' };
      const tag = tags[node.type];
      return `<${tag}>${children.map(visit).join('')}</${tag}>`;
    }
    if (node.type === 'bulletList') return children.map(child => `- ${visit(child)}`).join('\n');
    return children.map(visit).join(node.type === 'doc' ? '\n\n' : node.type === 'listItem' ? '\n' : '');
  }
  return visit(doc).trim();
}
const encode = (doc, options) => JSON.stringify(content(doc, options));
const decode = (message, options) => content(JSON.parse(message), options);
const title = doc => render(doc, { name: 'Recipient' }).split('\n')[0].replace(/[*_]/g, '').slice(0, 100) || 'Message';
/** Does this message greet the recipient by name? A lead with no name can't receive such a message. */
const usesName = node => node.type === 'emailVariable' ? node.attrs?.key === 'name' : (node.content || []).some(usesName);
/** Plain text as a message document: a blank line starts a paragraph, a line break stays inside it. */
const textToDoc = text => ({ type: 'doc', content: String(text).split(/\n{2,}/).map(paragraph => ({
  type: 'paragraph',
  content: paragraph.split('\n').flatMap((line, index) => [...(index ? [{ type: 'hardBreak' }] : []), { type: 'text', text: line }]),
})) });
// A versioned composition wraps the existing text codec; Auto Reply keeps its text-only contract.
function composition(input) {
  const empty = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  const optional = doc => content(doc || empty, { allowEmpty: true });
  const doc = optional(input.doc), caption = optional(input.caption);
  const media = input.media ? require('./broadcastMedia').validateMedia(input.media) : null;
  const position = input.position || 'after';
  if (!['before', 'after'].includes(position)) fail('Choose text before or after media.');
  const subject = String(input.subject || '').trim();
  if (subject.length > 300 || /[\r\n]/.test(subject)) fail('Use an email subject on one line, up to 300 characters.');
  if (!media && render(caption, { name: 'Recipient' })) fail('A caption needs media.');
  if (!media && !render(doc, { name: 'Recipient' })) fail('Write a message or choose media.');
  if (render(caption, { name: 'Recipient' }).length > 1024) fail('Keep the caption within 1024 characters.');
  return { version: 2, doc, caption, media, position, subject };
}
function readComposition(message) {
  const value = JSON.parse(message);
  return value.version === 2 ? composition(value) : { version: 1, doc: content(value), caption: null, media: null, position: 'after', subject: '' };
}
function compositionParts(value, values) {
  const text = render(value.doc, values), caption = value.caption ? render(value.caption, values) : '';
  if (text.length > 60000) fail('Personalized text exceeds 60000 characters.');
  if (caption.length > 1024) fail('Personalized caption exceeds 1024 characters.');
  const parts = value.media ? [{ text: caption, media: value.media }] : [];
  if (text) value.position === 'before' ? parts.unshift({ text }) : parts.push({ text });
  return parts;
}
function compositionHtml(value, values) {
  return compositionParts(value, values).map(part => part.media
    ? `<div>${part.media.kind === 'video' ? `<a href="${escapeHtml(part.media.url)}"><img src="${escapeHtml(part.media.url.replace(/\.mp4(?:\?.*)?$/, '.jpg'))}" alt="Open video" style="max-width:100%">Open video</a>` : `<img src="${escapeHtml(part.media.url)}" alt="" style="max-width:100%">`}${part.text ? render(value.caption, values, { html: true }) : ''}</div>`
    : render(value.doc, values, { html: true })).join('');
}
const compositionUsesName = value => usesName(value.doc) || (value.caption && usesName(value.caption));
const compositionTitle = value => (value.subject || render(value.doc, { name: 'Recipient' }) || (value.caption && render(value.caption, { name: 'Recipient' })) || 'Media message').slice(0, 100);
module.exports = { FIELDS, content, encode, decode, render, title, usesName, textToDoc, fail, composition, readComposition, compositionParts, compositionHtml, compositionUsesName, compositionTitle };
