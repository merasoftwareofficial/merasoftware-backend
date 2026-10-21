import { after, afterEach, before, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Auth, State, STATE_ID } from '../src/models.js';
import { createConnection } from '../src/whatsapp.js';
import { useMongoAuthState } from '../src/mongoAuthState.js';

// Plays WhatsApp's side of linking a number: after the QR scan WhatsApp hands over the login
// (creds.update) and at once closes the stream with 515 "restart required"; the next connection
// must log in with those creds. Production saves to Atlas over the network, so writes are slowed here.
const SAVE_DELAY_MS = 300;
const silent = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, child() { return silent; }, level: 'silent' };
let mongo;
const open = []; // every connection a test starts; stopped after each test even when an assertion fails
const slowAuth = () => new Proxy(Auth, {
  get(target, name) {
    if (name === 'updateOne' || name === 'bulkWrite') return async (...args) => { await sleep(SAVE_DELAY_MS); return target[name](...args); };
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
function fakeWhatsApp() {
  const sockets = [];
  const makeSocket = config => {
    const listeners = {};
    const socket = {
      config,
      ev: { on: (name, fn) => { (listeners[name] ||= []).push(fn); } },
      emit: async (name, data) => { for (const fn of listeners[name] || []) await fn(data); },
      end() {}, logout: async () => {},
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, makeSocket, fetchVersion: async () => null };
}
async function until(check, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (await check()) return true;
  return false;
}
async function scanQr(socket) {
  // What Baileys does on pair-success: update its creds object in place, announce it, then WhatsApp restarts the stream.
  Object.assign(socket.config.auth.creds, { me: { id: '919876543210:7@s.whatsapp.net' }, registered: true });
  socket.emit('creds.update', { me: socket.config.auth.creds.me, registered: true });
  await socket.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await Promise.all(open.splice(0).map(connection => connection.stop())); });
beforeEach(async () => { await Promise.all([Auth.deleteMany({}), State.deleteMany({})]); });

it('after the QR scan and WhatsApp\'s restart, reconnects with the new login instead of asking for a new QR', async () => {
  const wa = fakeWhatsApp();
  const connection = createConnection({ Auth: slowAuth(), State, logger: silent, makeSocket: wa.makeSocket, fetchVersion: wa.fetchVersion });
  open.push(connection);
  connection.start();
  assert.ok(await until(() => wa.sockets.length === 1), 'first connection made');
  await scanQr(wa.sockets[0]);
  assert.ok(await until(() => wa.sockets.length === 2), 'reconnected after 515');
  assert.equal(wa.sockets[1].config.auth.creds.me?.id, '919876543210:7@s.whatsapp.net', 'second connection must carry the login from the scan');
});

it('the login is in the database by the time it reconnects, so a later restart of the server stays logged in', async () => {
  const wa = fakeWhatsApp();
  const connection = createConnection({ Auth: slowAuth(), State, logger: silent, makeSocket: wa.makeSocket, fetchVersion: wa.fetchVersion });
  open.push(connection);
  connection.start();
  await until(() => wa.sockets.length === 1);
  await scanQr(wa.sockets[0]);
  await until(() => wa.sockets.length === 2);
  const saved = await useMongoAuthState(Auth);
  assert.equal(saved.state.creds.me?.id, '919876543210:7@s.whatsapp.net');
});

it('after the number is unlinked from the phone, the old login is forgotten and a fresh one starts', async () => {
  const wa = fakeWhatsApp();
  const connection = createConnection({ Auth: slowAuth(), State, logger: silent, makeSocket: wa.makeSocket, fetchVersion: wa.fetchVersion });
  open.push(connection);
  connection.start();
  await until(() => wa.sockets.length === 1);
  await scanQr(wa.sockets[0]);
  await until(() => wa.sockets.length === 2);
  await wa.sockets[1].emit('connection.update', { connection: 'open' });
  await wa.sockets[1].emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.ok(await until(() => wa.sockets.length === 3, 8000), 'reconnects for a new QR');
  assert.equal(wa.sockets[2].config.auth.creds.me, undefined, 'no leftover login');
  assert.equal((await State.findById(STATE_ID).lean()).connection, 'connecting');
});
