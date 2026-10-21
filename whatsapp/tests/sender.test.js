import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { Auth, Lock, Queue, State, STATE_ID } from '../src/models.js';
import { createSender, dayKey } from '../src/sender.js';
import { createLease } from '../src/lease.js';
import { useMongoAuthState } from '../src/mongoAuthState.js';
import { RECOMMENDED, effectiveSettings, inQuietHours, settingsWarnings, validateSettings } from '../src/settings.js';

const config = { timeZone: 'Asia/Kolkata' };
// The admin's sending rules for these tests: a small daily limit, no typing wait and no quiet hours unless a test turns them on.
const rules = { ...RECOMMENDED, dailyLimit: 3, typing: false, quietHours: false };
const setRules = changes => State.updateOne({ _id: STATE_ID }, { $set: { settings: { ...rules, ...changes } } }, { upsert: true });
let mongo;
let clock;
const now = () => new Date(clock);
const advance = ms => { clock += ms; };

function fakeWhatsApp({ missing = [], failWith = null } = {}) {
  const sent = [];
  return {
    sent,
    connected: true,
    isConnected() { return this.connected; },
    async resolve(to) { return missing.includes(to) ? null : `${to}@s.whatsapp.net`; },
    async send(jid, text, typingMs) {
      if (failWith) throw new Error(failWith);
      sent.push({ jid, text, typingMs });
      return `id-${sent.length}`;
    },
  };
}
const enqueue = (to, text) => Queue.create({ to, text, event: 'portal.project.created', application: 'portal', createdAt: now(), nextAttemptAt: now() });

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Queue.init(), State.init(), Auth.init(), Lock.init()]);
});
after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  clock = Date.parse('2026-10-20T06:00:00Z');
  await Promise.all([Queue.deleteMany({}), State.deleteMany({}), Auth.deleteMany({}), Lock.deleteMany({})]);
  await setRules({});
});

describe('sender', () => {
  it('sends one message, then waits at least 30 seconds before the next', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now, random: () => 0 });
    await enqueue('919876543210', 'first');
    await enqueue('919876543211', 'second');

    assert.equal((await sender.step()).reason, 'sent');
    assert.deepEqual(wa.sent, [{ jid: '919876543210@s.whatsapp.net', text: 'first', typingMs: 0 }]);

    advance(29_999);
    assert.equal((await sender.step()).reason, 'gap');
    assert.equal(wa.sent.length, 1);

    advance(1);
    assert.equal((await sender.step()).reason, 'sent');
    assert.equal(wa.sent[1].text, 'second');
    const first = await Queue.findOne({ text: 'first' }).lean();
    assert.equal(first.status, 'sent');
    assert.equal(first.messageId, 'id-1');
    assert.ok(first.expiresAt > now());
  });

  it('adds the random extra wait on top of 30 seconds', async () => {
    const sender = createSender({ Queue, State, transport: fakeWhatsApp(), config, now, random: () => 0.999999 });
    await enqueue('919876543210', 'x');
    await sender.step();
    const state = await State.findById(STATE_ID).lean();
    assert.equal(state.nextSendAt.getTime() - clock, 45_000);
  });

  it('keeps the gap across a restart (a new sender reads it from the database)', async () => {
    await enqueue('919876543210', 'a');
    await enqueue('919876543211', 'b');
    await createSender({ Queue, State, transport: fakeWhatsApp(), config, now, random: () => 0 }).step();
    const restarted = fakeWhatsApp();
    advance(10_000);
    assert.equal((await createSender({ Queue, State, transport: restarted, config, now }).step()).reason, 'gap');
    assert.equal(restarted.sent.length, 0);
  });

  it('stops at the daily limit and starts again the next India day', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now, random: () => 0 });
    for (let i = 0; i < 4; i += 1) await enqueue(`91987654321${i}`, `m${i}`);
    for (let i = 0; i < 3; i += 1) { await sender.step(); advance(30_000); }
    assert.equal((await sender.step()).reason, 'daily-limit');
    assert.equal(wa.sent.length, 3);

    clock = Date.parse('2026-10-20T18:31:00Z'); // 00:01 on 21 Oct in India
    assert.equal((await sender.step()).reason, 'sent');
    assert.equal(wa.sent.length, 4);
  });

  it('does nothing while paused or offline', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now });
    await enqueue('919876543210', 'x');
    await State.updateOne({ _id: STATE_ID }, { paused: true });
    assert.equal((await sender.step()).reason, 'paused');
    await State.updateOne({ _id: STATE_ID }, { paused: false });
    wa.connected = false;
    assert.equal((await sender.step()).reason, 'offline');
    assert.equal((await Queue.findOne().lean()).status, 'pending');
  });

  it('fails a number that is not on WhatsApp without sending', async () => {
    const wa = fakeWhatsApp({ missing: ['919876543210'] });
    const sender = createSender({ Queue, State, transport: wa, config, now });
    await enqueue('919876543210', 'x');
    await sender.step();
    const item = await Queue.findOne().lean();
    assert.equal(item.status, 'failed');
    assert.match(item.lastError, /not on WhatsApp/);
    assert.equal(wa.sent.length, 0);
    assert.equal((await State.findById(STATE_ID).lean()).sentToday, 0);
  });

  it('retries a failed send later, and gives up after the last attempt', async () => {
    const sender = createSender({ Queue, State, transport: fakeWhatsApp({ failWith: 'socket closed' }), config, now, random: () => 0 });
    await enqueue('919876543210', 'x');
    await sender.step();
    let item = await Queue.findOne().lean();
    assert.equal(item.status, 'pending');
    assert.equal(item.nextAttemptAt.getTime(), clock + 300_000);

    advance(60_000);
    assert.equal((await sender.step()).reason, 'empty'); // retry time not reached yet
    for (let i = 0; i < 2; i += 1) { advance(300_000); await sender.step(); }
    item = await Queue.findOne().lean();
    assert.equal(item.status, 'failed');
    assert.equal(item.attempts, 3);
    assert.equal(item.lastError, 'socket closed');
  });

  it('never resends a message that was mid-send when the service stopped', async () => {
    await Queue.create({ to: '919876543210', text: 'x', status: 'sending', attempts: 1 });
    const sender = createSender({ Queue, State, transport: fakeWhatsApp(), config, now });
    assert.equal(await sender.recoverInterrupted(), 1);
    const item = await Queue.findOne().lean();
    assert.equal(item.status, 'failed');
    assert.match(item.lastError, /not sent again/i);
  });

  it('allows one queue row per email recipient, and several recipients per email', async () => {
    const emailDraftId = new mongoose.Types.ObjectId();
    await Queue.create({ to: '919876543210', text: 'x', emailDraftId, email: 'a@x.com' });
    await Queue.create({ to: '919876543211', text: 'x', emailDraftId, email: 'b@x.com' });
    await assert.rejects(Queue.create({ to: '919876543210', text: 'x', emailDraftId, email: 'A@x.com' }), { code: 11000 });
  });

  it('expires a message that waited more than a day, even while offline, and never sends it', async () => {
    const wa = fakeWhatsApp();
    wa.connected = false;
    const sender = createSender({ Queue, State, transport: wa, config, now });
    await Queue.create({ to: '919876543210', text: 'old', createdAt: new Date(clock - 24 * 60 * 60_000 - 1), nextAttemptAt: now() });
    await Queue.create({ to: '919876543211', text: 'fresh', createdAt: new Date(clock - 60_000), nextAttemptAt: now() });
    await sender.step();
    assert.equal((await Queue.findOne({ text: 'old' }).lean()).status, 'expired');
    wa.connected = true;
    await sender.step();
    assert.deepEqual(wa.sent.map(m => m.text), ['fresh']);
  });

  it('never picks a skipped row', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now });
    await Queue.create({ status: 'skipped', text: 'x', lastError: 'No phone', email: 'a@x.com' });
    assert.equal((await sender.step()).reason, 'empty');
    assert.equal(wa.sent.length, 0);
  });

  it('stops for quiet hours at night (India time) and sends again in the morning', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now });
    await setRules({ quietHours: true, quietFrom: 22, quietTo: 8 });
    clock = Date.parse('2026-10-20T17:00:00Z'); // 22:30 in India
    await enqueue('919876543210', 'night');
    assert.equal((await sender.step()).reason, 'quiet-hours');
    clock = Date.parse('2026-10-21T02:29:00Z'); // 07:59
    assert.equal((await sender.step()).reason, 'quiet-hours');
    clock = Date.parse('2026-10-21T02:30:00Z'); // 08:00
    assert.equal((await sender.step()).reason, 'sent');
    assert.equal(wa.sent.length, 1);
  });

  it('types for longer on longer messages, never past the longest typing time', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now, random: () => 0.5 });
    await setRules({ typing: true, typingMinSec: 2, typingMaxSec: 8 });
    await enqueue('919876543210', 'x'.repeat(250));
    await enqueue('919876543211', 'x'.repeat(5000));
    await sender.step();
    advance(60_000);
    await sender.step();
    assert.deepEqual(wa.sent.map(m => m.typingMs), [2000 + 2000 + 500, 8000]);
  });

  it('a rule saved on the admin page applies to the very next message, without a restart', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now, random: () => 0 });
    await enqueue('919876543210', 'a');
    await enqueue('919876543211', 'b');
    await sender.step();
    await setRules({ dailyLimit: 1 });
    advance(60_000);
    assert.equal((await sender.step()).reason, 'daily-limit');
    await setRules({ dailyLimit: 5, minGapSec: 120 });
    await sender.step(); // sends b
    await enqueue('919876543212', 'c');
    advance(119_000);
    assert.equal((await sender.step()).reason, 'gap');
  });

  it('with nothing saved, the recommended rules apply', async () => {
    await State.updateOne({ _id: STATE_ID }, { $unset: { settings: 1 } });
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now, random: () => 0 });
    await enqueue('919876543210', 'a');
    await sender.step();
    assert.equal(wa.sent[0].typingMs, RECOMMENDED.typingMinSec * 1000);
    const state = await State.findById(STATE_ID).lean();
    assert.equal(state.nextSendAt.getTime() - clock, RECOMMENDED.minGapSec * 1000);
  });

  it('counts the day in India time', () => {
    assert.equal(dayKey(new Date('2026-10-20T18:29:00Z'), 'Asia/Kolkata'), '2026-10-20');
    assert.equal(dayKey(new Date('2026-10-20T18:30:00Z'), 'Asia/Kolkata'), '2026-10-21');
  });
});

describe('lease', () => {
  it('lets only one copy send, and hands over when the holder stops or goes silent', async () => {
    let time = Date.parse('2026-10-20T06:00:00Z');
    const clockNow = () => new Date(time);
    const a = createLease(Lock, { now: clockNow });
    const b = createLease(Lock, { now: clockNow });
    assert.equal(await a.ensure(), true);
    assert.equal(await b.ensure(), false);
    time += 30_000;
    assert.equal(await a.ensure(), true); // renewed
    time += 89_000;
    assert.equal(await b.ensure(), false);
    time += 2_000; // a silent for more than 90 seconds
    assert.equal(await b.ensure(), true);
    await b.release();
    assert.equal(await a.ensure(), true);
  });
});

describe('session stored in MongoDB', () => {
  it('keeps login keys and credentials across a restart', async () => {
    const first = await useMongoAuthState(Auth);
    const key = { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) };
    await first.state.keys.set({ 'pre-key': { 7: key } });
    first.state.creds.me = { id: '919876543210:1@s.whatsapp.net' };
    await first.saveCreds();

    const restarted = await useMongoAuthState(Auth);
    assert.equal(restarted.state.creds.me.id, '919876543210:1@s.whatsapp.net');
    assert.deepEqual(restarted.state.creds.noiseKey, JSON.parse(JSON.stringify(first.state.creds.noiseKey, BufferJSON.replacer), BufferJSON.reviver));
    const { 7: loaded, 8: missing } = await restarted.state.keys.get('pre-key', ['7', '8']);
    assert.ok(Buffer.isBuffer(loaded.public));
    assert.deepEqual([...loaded.private], [4, 5, 6]);
    assert.equal(missing, null);

    await restarted.state.keys.set({ 'pre-key': { 7: null } });
    assert.equal((await restarted.state.keys.get('pre-key', ['7']))[7], null);
    assert.ok(initAuthCreds().noiseKey); // fresh login creds still come from Baileys
  });
});

describe('settings', () => {
  it('accepts the recommended rules and refuses anything outside the safe limits, in plain words', () => {
    assert.deepEqual(validateSettings({ ...RECOMMENDED, extra: 'ignored' }), { ...RECOMMENDED });
    assert.throws(() => validateSettings({ ...RECOMMENDED, minGapSec: 29 }), /Gap between messages must be a whole number from 30 to 600/);
    assert.throws(() => validateSettings({ ...RECOMMENDED, dailyLimit: 301 }), /from 1 to 300/);
    assert.throws(() => validateSettings({ ...RECOMMENDED, jitterSec: 1.5 }), /whole number/);
    assert.throws(() => validateSettings({ ...RECOMMENDED, typing: 'yes' }), /on or off/);
    assert.throws(() => validateSettings({ ...RECOMMENDED, maxAttempts: undefined }), /Tries per message/);
    assert.throws(() => validateSettings({ ...RECOMMENDED, typingMinSec: 9, typingMaxSec: 8 }), /cannot be more than/);
    assert.throws(() => validateSettings({ ...RECOMMENDED, quietFrom: 8, quietTo: 8 }), /same hour/);
    assert.doesNotThrow(() => validateSettings({ ...RECOMMENDED, quietHours: false, quietFrom: 8, quietTo: 8 }));
    assert.throws(() => validateSettings(null), /all the sending rules/);
  });

  it('fills anything missing or broken in the saved rules with the recommended value', () => {
    assert.deepEqual(effectiveSettings(undefined), RECOMMENDED);
    assert.deepEqual(effectiveSettings({ dailyLimit: 100, minGapSec: 5 }), { ...RECOMMENDED, dailyLimit: 100 });
  });

  it('warns when quiet hours are as long as the time a message may wait', () => {
    assert.deepEqual(settingsWarnings(RECOMMENDED), []);
    assert.match(settingsWarnings({ ...RECOMMENDED, quietFrom: 20, quietTo: 12, maxAgeHours: 16 })[0], /Quiet hours last 16 hours/);
    assert.deepEqual(settingsWarnings({ ...RECOMMENDED, quietHours: false, maxAgeHours: 1 }), []);
  });

  it('quiet hours work across midnight and within one day', () => {
    const at = hhmm => new Date(`2026-10-20T${hhmm}:00+05:30`);
    const night = { ...RECOMMENDED, quietFrom: 22, quietTo: 8 };
    assert.deepEqual(['21:59', '22:00', '03:00', '07:59', '08:00'].map(t => inQuietHours(night, at(t), 'Asia/Kolkata')), [false, true, true, true, false]);
    const afternoon = { ...RECOMMENDED, quietFrom: 13, quietTo: 15 };
    assert.deepEqual(['12:59', '13:00', '14:59', '15:00'].map(t => inQuietHours(afternoon, at(t), 'Asia/Kolkata')), [false, true, true, false]);
    assert.equal(inQuietHours({ ...night, quietHours: false }, at('03:00'), 'Asia/Kolkata'), false);
  });
});
