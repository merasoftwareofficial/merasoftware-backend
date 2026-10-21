import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { Auth, Lock, Queue, State, STATE_ID } from '../src/models.js';
import { createSender, dayKey } from '../src/sender.js';
import { createLease } from '../src/lease.js';
import { useMongoAuthState } from '../src/mongoAuthState.js';

const config = { minGapMs: 30_000, jitterMs: 15_000, dailyLimit: 3, maxAttempts: 3, retryDelayMs: 300_000, maxAgeMs: 24 * 60 * 60_000, timeZone: 'Asia/Kolkata' };
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
    async send(jid, text) {
      if (failWith) throw new Error(failWith);
      sent.push({ jid, text });
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
});

describe('sender', () => {
  it('sends one message, then waits at least 30 seconds before the next', async () => {
    const wa = fakeWhatsApp();
    const sender = createSender({ Queue, State, transport: wa, config, now, random: () => 0 });
    await enqueue('919876543210', 'first');
    await enqueue('919876543211', 'second');

    assert.equal((await sender.step()).reason, 'sent');
    assert.deepEqual(wa.sent, [{ jid: '919876543210@s.whatsapp.net', text: 'first' }]);

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
    await State.create({ _id: STATE_ID, paused: true });
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
