import { after, before, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DEFAULT_AD_MESSAGE, RULE_KEY, cleanText, matchesAdMessage } from '../src/autoReplyRules.js';
import { createInbound, messageTime, senderPhone } from '../src/inbound.js';
import { Inbox, Queue, Rule, State, STATE_ID } from '../src/models.js';
import { RECOMMENDED } from '../src/settings.js';

const silent = { error() {}, warn() {}, info() {} };
const NOW = new Date('2026-10-30T12:00:00Z');
const PHONE = '919876543210';
let mongo, serial = 0;
const inbound = createInbound({ Inbox, Queue, Rule, State, logger: silent, now: () => NOW });
const seconds = date => Math.floor(date.getTime() / 1000);
const message = (fields = {}) => ({
  key: { id: `msg-${++serial}`, remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false },
  message: { conversation: DEFAULT_AD_MESSAGE },
  messageTimestamp: seconds(NOW),
  ...fields,
});
const inChat = (jid, fields = {}) => message({ key: { id: `msg-${++serial}`, remoteJid: jid, fromMe: false }, ...fields });
const deliver = (messages, type = 'notify', socket) => inbound.handle({ messages, type }, socket);
const turnOn = () => State.updateOne({ _id: STATE_ID }, { $set: { 'autoReply.recognise': true } }, { upsert: true });

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Inbox.init(), Rule.init()]);
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([Inbox.deleteMany({}), Rule.deleteMany({}), State.deleteMany({})]);
  await Rule.create({ key: RULE_KEY, message: DEFAULT_AD_MESSAGE });
  await turnOn();
});

it('matches only the whole ad message, whatever the case, spacing or punctuation', () => {
  for (const text of [DEFAULT_AD_MESSAGE, 'hello can i get more info on this', '  HELLO!!  can i get  more info, on this ',
    'Hello! Can I get more info on this? Price kya hai', 'Hi. Hello! Can I get more info on this?']) {
    assert.equal(matchesAdMessage(text, DEFAULT_AD_MESSAGE), true, text);
  }
  for (const text of ['Hello', 'Can I get more info', 'Hello! Can I get more info on that?', 'Website banwani hai', '', 'Hello! Can I get more info on thisssss']) {
    assert.equal(matchesAdMessage(text, DEFAULT_AD_MESSAGE), false, text);
  }
  assert.equal(matchesAdMessage('anything', ''), false, 'an empty rule matches nothing');
  assert.equal(cleanText('ਧੰਨਵਾਦ! Hello'), 'ਧੰਨਵਾਦ hello', 'other scripts stay');
});

it('saves a matching message with its number, name and details', async () => {
  await deliver([message({ pushName: 'Ravi', message: { extendedTextMessage: { text: DEFAULT_AD_MESSAGE, contextInfo: { conversionSource: 'FB_Ads', externalAdReply: { ctwaClid: 'abc' } } } } })]);
  const [row] = await Inbox.find().lean();
  assert.equal(row.phone, PHONE);
  assert.equal(row.text, DEFAULT_AD_MESSAGE);
  assert.equal(row.profileName, 'Ravi');
  assert.equal(row.status, 'new');
  assert.equal(row.deliveredAs, 'notify');
  assert.deepEqual(row.adMarker, { externalAdReply: true, ctwaClid: true, conversionSource: 'FB_Ads' });
});

it('finds the text inside a disappearing-message wrapper', async () => {
  await deliver([message({ message: { ephemeralMessage: { message: { extendedTextMessage: { text: DEFAULT_AD_MESSAGE } } } } })]);
  assert.equal(await Inbox.countDocuments(), 1);
});

it('never saves a message that does not match', async () => {
  await deliver([message({ message: { conversation: 'Hello' } }), message({ message: { conversation: 'personal chat text' } })]);
  assert.equal(await Inbox.countDocuments(), 0);
});

it('ignores groups, status, newsletters, bots, our own messages and non-text messages', async () => {
  await deliver([
    inChat('120363000000000000@g.us'), inChat('status@broadcast'), inChat('120363000000000000@newsletter'),
    inChat('13135550000@bot'), inChat('1234567890@broadcast'),
    message({ key: { id: 'own', remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true } }),
    message({ message: { imageMessage: { caption: DEFAULT_AD_MESSAGE } } }),
    message({ message: null }),
  ]);
  assert.equal(await Inbox.countDocuments(), 0);
});

it('with the switch Off, or never set, nothing is read or saved', async () => {
  await State.updateOne({ _id: STATE_ID }, { $set: { 'autoReply.recognise': false } });
  await deliver([message()]);
  await State.deleteMany({});
  await deliver([message()]);
  assert.equal(await Inbox.countDocuments(), 0);
});

it('a message that came while offline is saved; an old one is dropped; a repeat counts once', async () => {
  const repeat = message({ messageTimestamp: seconds(new Date(NOW.getTime() - 3_600_000)) });
  await deliver([repeat], 'append');
  await deliver([repeat], 'notify');
  assert.equal(await Inbox.countDocuments(), 1);
  assert.equal((await Inbox.findOne().lean()).deliveredAs, 'append');
  const tooOld = new Date(NOW.getTime() - (RECOMMENDED.maxAgeHours + 1) * 3_600_000);
  await deliver([message({ messageTimestamp: seconds(tooOld) })], 'append');
  await deliver([message({ messageTimestamp: undefined })], 'append');
  assert.equal(await Inbox.countDocuments(), 1);
});

it('reads a time given as a number or a Long', () => {
  assert.equal(messageTime({ messageTimestamp: 1_700_000_000 }).getTime(), 1_700_000_000_000);
  assert.equal(messageTime({ messageTimestamp: { toNumber: () => 1_700_000_000 } }).getTime(), 1_700_000_000_000);
  assert.equal(messageTime({ messageTimestamp: null }), null);
});

it('finds the real number of a LID chat, and never uses the LID\'s digits as a phone', async () => {
  const lid = '123456789012345@lid';
  assert.equal(await senderPhone({ remoteJid: `${PHONE}:12@s.whatsapp.net` }), PHONE, 'a device suffix is dropped');
  assert.equal(await senderPhone({ remoteJid: lid, remoteJidAlt: `${PHONE}@s.whatsapp.net` }), PHONE);
  const socket = { signalRepository: { lidMapping: { getPNForLID: async () => `${PHONE}:0@s.whatsapp.net` } } };
  assert.equal(await senderPhone({ remoteJid: lid }, socket), PHONE);
  assert.equal(await senderPhone({ remoteJid: lid }, { signalRepository: { lidMapping: { getPNForLID: async () => null } } }), null);
  assert.equal(await senderPhone({ remoteJid: lid }), null);
});

it('a match with no real number is kept as needing attention, without a number', async () => {
  await deliver([inChat('123456789012345@lid')]);
  const [row] = await Inbox.find().lean();
  assert.equal(row.phone, null);
  assert.equal(row.status, 'needs-attention');
});

it('a failed number lookup or a bad row does not lose the other messages', async () => {
  const socket = { signalRepository: { lidMapping: { getPNForLID: async () => { throw new Error('lookup failed'); } } } };
  await deliver([inChat('123456789012345@lid'), message()], 'notify', socket);
  assert.deepEqual((await Inbox.find().sort({ createdAt: 1 }).lean()).map(row => row.status).sort(), ['needs-attention', 'new']);
});

it('uses the message saved by the admin', async () => {
  await Rule.updateOne({ key: RULE_KEY }, { $set: { message: 'I saw your website design advert today' } });
  await deliver([message(), message({ message: { conversation: 'i saw your website design advert today!' } })]);
  assert.equal((await Inbox.find().lean()).length, 1);
});
