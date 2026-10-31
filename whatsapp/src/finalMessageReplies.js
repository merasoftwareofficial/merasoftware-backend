// Which replies to the final message don't count, shared by the worker (inbound.js) and the admin routes (routes/autoReply.js).
import { cleanText } from './autoReplyRules.js';

export const DEFAULT_IGNORED_REPLIES = ['ok', 'thik a', 'thik hai', 'thik hai ji', 'kardo ji', 'krdo', 'karde', 'kardo'];
export const MAX_IGNORED_REPLIES = 200;
export const MAX_IGNORED_LENGTH = 100;

/** cleanText keeps \p{M}, which also holds what emojis are joined with (the one inside ❤️), so those go here. cleanText stays as Auto Reply needs it. */
export function replyWords(text) {
  return cleanText(text).replace(/[︎️‍⃣]/gu, '').replace(/\s+/g, ' ').trim();
}

/** true for a message that is only emojis or punctuation, or that is exactly one of the listed words. "ok details bhejo" is not. */
export function isIgnoredReply(text, list) {
  const words = replyWords(text);
  return !words || list.some(entry => replyWords(entry) === words);
}
