// Auto Reply's message matching, shared by the worker (inbound.js) and the admin routes (routes/autoReply.js).
export const RULE_KEY = 'main'; // the screen offers one rule for now
export const DEFAULT_AD_MESSAGE = 'Hello! Can I get more info on this?';
export const MIN_AD_MESSAGE = 20; // this number also carries other chats, so a short or general message is refused

/** Lower case, words only: "Hello!  Can I" and "hello can i" are the same text. \p{M} keeps Punjabi and Hindi vowel signs. */
export function cleanText(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

/** true when the incoming text holds the whole ad message, as whole words. */
export function matchesAdMessage(text, adMessage) {
  const wanted = cleanText(adMessage);
  return !!wanted && ` ${cleanText(text)} `.includes(` ${wanted} `);
}
