import { isLidUser, isPnUser, jidDecode, normalizeMessageContent } from '@whiskeysockets/baileys';
import { matchesAdMessage } from './autoReplyRules.js';
import { AUTO_REPLY_EVENT, OUR_SIDE_REPLIED, STATE_ID, finishedExpiry } from './models.js';
import { effectiveSettings } from './settings.js';

const MAX_SAVED_TEXT = 2_000;

export function incomingText(message) {
  const content = normalizeMessageContent(message.message);
  return content?.conversation || content?.extendedTextMessage?.text || '';
}

/** What WhatsApp says about the ad this chat came from, if anything. Only what is needed to decide later. */
function adMarker(message) {
  const context = normalizeMessageContent(message.message)?.extendedTextMessage?.contextInfo;
  return {
    externalAdReply: !!context?.externalAdReply,
    ctwaClid: !!context?.externalAdReply?.ctwaClid,
    conversionSource: context?.conversionSource || null,
  };
}

/** The message's time, or null. WhatsApp gives seconds as a number or a Long. */
export function messageTime(message) {
  const raw = message.messageTimestamp;
  const seconds = Number(typeof raw?.toNumber === 'function' ? raw.toNumber() : raw);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

const phoneFrom = jid => {
  const digits = isPnUser(jid) ? jidDecode(jid)?.user : null;
  return digits && /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
};

/**
 * The sender's real number. A LID chat is identified by an id that is not a phone number, so its digits
 * are never used: the number comes from the message or from Baileys' LID map, or stays unknown.
 */
export async function senderPhone(key, socket) {
  const direct = phoneFrom(key.remoteJid) || phoneFrom(key.remoteJidAlt);
  if (direct || !isLidUser(key.remoteJid)) return direct;
  const mapped = await socket?.signalRepository?.lidMapping?.getPNForLID(key.remoteJid);
  return phoneFrom(mapped);
}

/**
 * The other person's number in a chat, for a message we sent. In a LID chat WhatsApp's alternate id on our own
 * message can be our own number, so the LID map comes first and our own number is never taken for theirs.
 */
export async function chatPhone(key, socket) {
  const direct = phoneFrom(key.remoteJid);
  if (direct) return direct;
  const mapped = isLidUser(key.remoteJid) ? phoneFrom(await socket?.signalRepository?.lidMapping?.getPNForLID(key.remoteJid)) : null;
  if (mapped) return mapped;
  const alternate = phoneFrom(key.remoteJidAlt);
  const ours = phoneFrom(socket?.user?.id);
  return alternate && alternate !== ours ? alternate : null;
}

// Only a person's text in a normal phone or LID chat. Groups, status, newsletters, bots and our own messages are not.
const isCandidate = message => !!message.key && !message.key.fromMe && !!message.message
  && (isPnUser(message.key.remoteJid) || isLidUser(message.key.remoteJid)) && !!incomingText(message);

// A real message from our side (our phone or the queue), not a reaction or a delete.
const isOurMessage = message => {
  if (!message.key?.fromMe || !(isPnUser(message.key.remoteJid) || isLidUser(message.key.remoteJid))) return false;
  const content = normalizeMessageContent(message.message);
  return !!content && !content.protocolMessage && !content.reactionMessage;
};

/**
 * Auto Reply's way in. A message that doesn't match is never saved: this number also carries other chats.
 * A match becomes one inbox row, unique on WhatsApp's message id. Nothing here is sent or marked read.
 * Our own messages are read for one thing: an auto reply that hasn't gone yet is not sent. Nothing about them is saved.
 */
export function createInbound({ Inbox, Queue, Rule, State, logger, now = () => new Date() }) {
  async function ourSideReplied(message, socket) {
    const phone = await chatPhone(message.key, socket);
    const at = messageTime(message);
    if (!phone || !at) return;
    // Only what came before this message: an old message of ours arriving after a restart cancels nothing newer.
    const rows = await Inbox.find({ phone, sentAt: { $lte: at }, $or: [{ status: 'new' }, { replyStatus: 'pending' }] }).select('_id status').lean();
    for (const row of rows) {
      if (row.status === 'new') {
        await Inbox.updateOne({ _id: row._id, status: 'new' }, { $set: { ourSideReplied: true } });
        continue;
      }
      // Compare-and-set: the auto reply's own send is already 'sending' here, so it can't cancel itself.
      const { modifiedCount } = await Queue.updateOne({ _id: row._id, event: AUTO_REPLY_EVENT, status: 'pending' },
        { $set: { status: 'cancelled', lastError: OUR_SIDE_REPLIED, expiresAt: finishedExpiry(now()) } });
      if (modifiedCount) await Inbox.updateOne({ _id: row._id }, { $set: { ourSideReplied: true, replyStatus: 'cancelled' } });
    }
  }

  async function handle({ messages = [], type }, socket) {
    const candidates = messages.filter(isCandidate);
    const ours = messages.filter(isOurMessage);
    if (!candidates.length && !ours.length) return;
    const state = await State.findById(STATE_ID).select('autoReply settings').lean();
    if (!state?.autoReply?.recognise) return;
    for (const message of ours) {
      await ourSideReplied(message, socket).catch(error => logger.error({ err: error }, 'Auto Reply could not check our own message'));
    }
    if (!candidates.length) return;
    const rules = await Rule.find().sort({ createdAt: 1 }).lean();
    const oldest = now().getTime() - effectiveSettings(state.settings).maxAgeHours * 3_600_000;
    for (const message of candidates) {
      try {
        const sentAt = messageTime(message);
        // `append` is also how a message that came while the worker was offline arrives, so old ones are dropped by age.
        if (sentAt ? sentAt.getTime() < oldest : type !== 'notify') continue;
        const text = incomingText(message);
        const rule = rules.find(row => matchesAdMessage(text, row.message));
        if (!rule) continue;
        const phone = await senderPhone(message.key, socket).catch(() => null);
        await Inbox.create({
          messageId: message.key.id, ruleId: rule._id, chat: message.key.remoteJid, phone,
          text: text.slice(0, MAX_SAVED_TEXT), profileName: message.pushName || null, deliveredAs: type, sentAt: sentAt || now(),
          adMarker: adMarker(message), status: phone ? 'new' : 'needs-attention',
        });
        if (!phone) logger.warn('Auto Reply: a matching message arrived but its phone number could not be found.');
      } catch (error) {
        if (error.code !== 11000) logger.error({ err: error }, 'Auto Reply could not save a matching message'); // 11000: delivered twice
      }
    }
  }
  return { handle };
}
