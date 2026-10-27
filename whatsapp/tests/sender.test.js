import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { Auth, Lock, Queue, State, STATE_ID } from '../src/models.js';
import { createSender, dayKey } from '../src/sender.js';
import { createLease } from '../src/lease.js';
import { useMongoAuthState } from '../src/mongoAuthState.js';
import { RECOMMENDED, effectiveSettings, inQuietHours, quietEnd, settingsWarnings, typingTime, validateSettings } from '../src/settings.js';
import { estimateQueue } from '../src/schedule.js';

const config = { timeZone: 'Asia/Kolkata' };
// The admin's sending rules for these tests: no typing wait and no quiet hours unless a test turns them on.
const rules = { ...RECOMMENDED, typing: false, quietHours: false };
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

  it('has no daily limit: 120 messages all go, oldest first, each one the full gap after the last', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now, random: () => 0 });
    await setRules({ dailyLimit: 3 }); // a limit saved before 27 Oct 2026 is ignored
    for (let i = 0; i < 120; i += 1) { await enqueue(`9198765${String(i).padStart(5, '0')}`, `m${i}`); advance(1); }
    const sentAt = [];
    for (let guard = 0; wa.sent.length < 120 && guard < 5000; guard += 1) {
      const before = wa.sent.length;
      await sender.step();
      if (wa.sent.length > before) sentAt.push(clock);
      advance(1_000);
    }
    assert.equal(wa.sent.length, 120);
    assert.deepEqual(wa.sent.map(m => m.text), Array.from({ length: 120 }, (_, i) => `m${i}`));
    for (let i = 1; i < sentAt.length; i += 1) assert.ok(sentAt[i] - sentAt[i - 1] >= 30_000, `gap before message ${i}`);
    assert.equal((await State.findById(STATE_ID).lean()).sentToday, 120, 'counted for the page, never a limit');
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
    await setRules({ minGapSec: 120 });
    advance(60_000);
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
    assert.throws(() => validateSettings({ ...RECOMMENDED, jitterSec: 121 }), /Random extra gap must be a whole number from 0 to 120/);
    assert.equal('dailyLimit' in validateSettings({ ...RECOMMENDED, dailyLimit: 50 }), false, 'there is no daily limit any more');
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
    assert.deepEqual(effectiveSettings({ dailyLimit: 100, jitterSec: 20, minGapSec: 5 }), { ...RECOMMENDED, jitterSec: 20 });
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


// Owner rule (27 Oct 2026): never two messages out at the same time, whatever happens to the running copies.
describe('one message at a time', () => {
  // A WhatsApp double that records which copies are mid-send when another one starts.
  function sharedWhatsApp() {
    const inFlight = new Set();
    const log = [];
    return {
      log,
      transport(name, { hang = false } = {}) {
        let release;
        return {
          release: () => release?.(),
          isConnected: () => true,
          resolve: async to => `${to}@s.whatsapp.net`,
          async send(jid, text) {
            log.push({ name, text, others: [...inFlight] });
            inFlight.add(name);
            if (hang) await new Promise(resolve => { release = resolve; });
            else await new Promise(resolve => setTimeout(resolve, 5));
            inFlight.delete(name);
            return `${name}-id`;
          },
        };
      },
    };
  }

  it('a copy whose lease ran out mid-send still blocks every other copy until its message is out', async () => {
    const wa = sharedWhatsApp();
    const a = wa.transport('A', { hang: true });
    const senderA = createSender({ Queue, State, transport: a, config, now, random: () => 0, owner: 'A', renewEveryMs: 10 });
    const senderB = createSender({ Queue, State, transport: wa.transport('B'), config, now, random: () => 0, owner: 'B' });
    await enqueue('919000000001', 'first');
    await enqueue('919000000002', 'second');
    const stepA = senderA.step(); // A starts "first" and hangs
    await new Promise(resolve => setTimeout(resolve, 50));
    advance(95_000); // longer than the 90-second lease; A keeps renewing the slot
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await senderB.step()).reason, 'busy');
    a.release();
    await stepA;
    advance(30_000);
    assert.equal((await senderB.step()).reason, 'sent');
    assert.deepEqual(wa.log.map(entry => [entry.name, entry.text, entry.others]), [['A', 'first', []], ['B', 'second', []]]);
  });

  it('twenty copies stepping at the same moment send exactly one message', async () => {
    const wa = sharedWhatsApp();
    for (let i = 0; i < 5; i += 1) await enqueue(`91900000000${i}`, `m${i}`);
    const senders = Array.from({ length: 20 }, (_, i) => createSender({ Queue, State, transport: wa.transport(`C${i}`), config, now, random: () => 0, owner: `C${i}` }));
    const reasons = await Promise.all(senders.map(sender => sender.step()));
    assert.equal(reasons.filter(result => result.reason === 'sent').length, 1);
    assert.equal(wa.log.length, 1);
    assert.equal(await Queue.countDocuments({ status: 'pending' }), 4);
  });

  it('the slot of a copy that died lapses after a minute; its half-sent message is marked, never resent', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now, random: () => 0, owner: 'B' });
    await State.updateOne({ _id: STATE_ID }, { $set: { sendingBy: 'dead copy', sendingUntil: new Date(clock + 60_000) } });
    await Queue.create({ to: '919000000001', text: 'cut off', status: 'sending', attempts: 1, createdAt: now() });
    await enqueue('919000000002', 'next');
    advance(30_000);
    assert.equal((await sender.step()).reason, 'busy');
    assert.equal(await sender.recoverInterrupted(), 0, 'a live slot means that copy may still be sending');
    assert.equal((await Queue.findOne({ text: 'cut off' }).lean()).status, 'sending');
    advance(31_000);
    assert.equal((await sender.step()).reason, 'sent');
    assert.deepEqual(wa.sent.map(m => m.text), ['next']);
    const cut = await Queue.findOne({ text: 'cut off' }).lean();
    assert.equal(cut.status, 'failed');
    assert.match(cut.lastError, /may or may not have arrived/);
    const state = await State.findById(STATE_ID).lean();
    assert.equal(state.sendingBy, undefined, 'the slot is free again');
    assert.equal(state.sendingUntil, null);
  });

  it('the gap is booked before the message goes, so a lost final write still keeps it', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now, random: () => 0, owner: 'A' });
    await enqueue('919000000001', 'x');
    const original = State.updateOne.bind(State);
    State.updateOne = async (filter, update, ...rest) => {
      if (update?.$unset?.sendingBy) return { modifiedCount: 0 }; // the write that frees the slot is lost
      return original(filter, update, ...rest);
    };
    try { await sender.step(); } finally { State.updateOne = original; }
    const state = await State.findById(STATE_ID).lean();
    assert.ok(state.nextSendAt.getTime() >= clock + 30_000);
  });
});

describe('queue estimate', () => {
  const at = text => new Date(`2026-10-20T${text}+05:30`);
  const row = (text, createdAt, extra = {}) => ({ _id: text, text, status: 'pending', createdAt, nextAttemptAt: createdAt, ...extra });
  const base = { ...RECOMMENDED, typing: false, quietHours: false, jitterSec: 0 };
  const seconds = (list, from) => list.map(item => item.eta && (item.eta - from) / 1000);

  it('the typing time is the one the sender uses', () => {
    assert.equal(typingTime({ ...RECOMMENDED }, 250, 0.5), 2000 + 2000 + 500);
    assert.equal(typingTime({ ...RECOMMENDED }, 5000, 0), 8000);
    assert.equal(typingTime({ ...RECOMMENDED, typing: false }, 5000, 0.9), 0);
  });

  it('quiet hours end at the start of their last hour, in India time', () => {
    const night = { ...RECOMMENDED, quietFrom: 22, quietTo: 8 };
    assert.equal(quietEnd(night, at('22:30:00'), 'Asia/Kolkata').getTime(), new Date('2026-10-21T08:00:00+05:30').getTime());
    assert.equal(quietEnd(night, at('07:59:30'), 'Asia/Kolkata').getTime(), at('08:00:00').getTime());
    assert.equal(quietEnd(night, at('12:00:00'), 'Asia/Kolkata').getTime(), at('12:00:00').getTime());
  });

  it('one after another, oldest first, each one the gap after the last', () => {
    const now = at('10:00:00');
    const rows = [row('b', at('09:59:00')), row('a', at('09:58:00')), row('c', at('09:59:30'))];
    const result = estimateQueue({ rows, rules: base, now, timeZone: 'Asia/Kolkata' });
    assert.deepEqual(result.map(item => item.text), ['a', 'b', 'c']);
    assert.deepEqual(seconds(result, now), [2.5, 35, 67.5]); // 1.5 s check + 1 s send, then 30 s gap each time
  });

  it('waits out the current gap and a message being sent now', () => {
    const now = at('10:00:00');
    const rows = [row('now', at('09:59:00'), { status: 'sending' }), row('next', at('09:59:10'))];
    const result = estimateQueue({ rows, nextSendAt: at('10:00:20'), rules: base, now, timeZone: 'Asia/Kolkata' });
    assert.deepEqual(result.map(item => [item.text, (item.eta - now) / 1000]), [['now', 0], ['next', 33.5]]);
  });

  it('a message waiting for its retry goes once its time comes, after the ones already due', () => {
    const now = at('10:00:00');
    const rows = [row('retry', at('09:50:00'), { nextAttemptAt: at('10:05:00'), attempts: 1 }), row('fresh', at('09:59:00'))];
    const result = estimateQueue({ rows, rules: base, now, timeZone: 'Asia/Kolkata' });
    assert.deepEqual(result.map(item => [item.text, (item.eta - now) / 1000]), [['fresh', 2.5], ['retry', 302.5]]);
  });

  it('night messages go from 8 in the morning; one that would wait past a day is shown as expiring', () => {
    const now = at('22:30:00');
    const rules = { ...base, quietHours: true, quietFrom: 22, quietTo: 8 };
    const rows = [row('old', new Date(at('22:30:00').getTime() - 20 * 3_600_000)), row('new', at('22:20:00'))];
    const result = estimateQueue({ rows, rules, now, timeZone: 'Asia/Kolkata' });
    assert.deepEqual(result.map(item => [item.text, item.willExpire]), [['old', true], ['new', false]]);
    assert.equal(result[1].eta.getTime(), new Date('2026-10-21T08:00:02.500+05:30').getTime());
  });

  it('while sending is stopped there are no times', () => {
    const result = estimateQueue({ rows: [row('a', at('09:00:00'))], rules: base, now: at('10:00:00'), timeZone: 'Asia/Kolkata', stopped: true });
    assert.deepEqual(result.map(item => [item.text, item.eta]), [['a', null]]);
  });
});
