import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { STATE_ID } from './models.js';
import { clearAuthState, useMongoAuthState } from './mongoAuthState.js';

// The live WhatsApp Web link. It only sends: incoming messages are ignored and never marked read.
// makeSocket / fetchVersion are Baileys' own; tests pass fakes to play WhatsApp's side.
export function createConnection({ Auth, State, logger, makeSocket = makeWASocket, fetchVersion = fetchLatestBaileysVersion }) {
  let sock = null;
  let connected = false;
  let running = false;
  let reconnectTimer = null;
  let failures = 0;
  // The login, loaded once and reused on every reconnect: Baileys updates these creds in place. Right after
  // a QR scan WhatsApp restarts the stream (515) and the next connection must carry the new login; reading
  // it back from the database instead raced the save and asked for a new QR ("Could not log in" on the phone).
  let auth = null;
  let saving = Promise.resolve(); // saves run one after another; a reconnect waits for them

  const setState = fields => State.updateOne({ _id: STATE_ID }, { $set: fields }, { upsert: true })
    .catch(error => logger.error({ err: error }, 'could not save WhatsApp status'));
  async function forgetLogin() {
    auth = null;
    await saving;
    await clearAuthState(Auth);
  }

  async function open() {
    if (!running) return;
    auth ??= await useMongoAuthState(Auth);
    const { state, saveCreds } = auth;
    // WhatsApp rejects old client versions; fall back to the version Baileys ships with if GitHub is unreachable.
    const latest = await fetchVersion().catch(() => null);
    await setState({ connection: 'connecting' });
    const socket = makeSocket({
      ...(latest?.version ? { version: latest.version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      // Baileys' default history filter stays: turning all sync off loses the LID mappings sending needs.
      syncFullHistory: false,
    });
    sock = socket;

    socket.ev.on('creds.update', () => {
      saving = saving.then(saveCreds).catch(error => logger.error({ err: error }, 'could not save the WhatsApp login'));
    });
    socket.ev.on('message-capping.update', cap => setState({ messageCap: cap }));
    socket.ev.on('connection.update', async update => {
      if (sock !== socket) return; // an older socket closing after a reconnect
      if (update.qr) {
        await setState({ connection: 'qr', qr: await QRCode.toDataURL(update.qr), qrAt: new Date() });
      }
      if (update.connection === 'open') {
        connected = true;
        failures = 0;
        await setState({ connection: 'connected', qr: null, phone: socket.user?.id?.split(/[:@]/)[0], lastError: null });
      }
      if (update.connection === 'close') {
        connected = false;
        sock = null;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          // Unlinked from the phone: the saved session is dead, so start over with a fresh QR.
          await forgetLogin();
          await setState({ connection: 'logged-out', qr: null, phone: null, lastError: 'The number was unlinked. Scan the new QR to link it again.' });
        } else {
          await saving; // the login must be in the database before reconnecting, so a server restart stays logged in
          await setState({ connection: 'disconnected', qr: null, lastError: update.lastDisconnect?.error?.message || null });
        }
        failures += 1;
        schedule(code === DisconnectReason.restartRequired ? 0 : Math.min(5_000 * failures, 60_000));
      }
    });
  }

  function schedule(delayMs) {
    clearTimeout(reconnectTimer);
    if (!running) return;
    reconnectTimer = setTimeout(() => open().catch(error => {
      logger.error({ err: error }, 'WhatsApp connect failed');
      failures += 1;
      schedule(Math.min(5_000 * failures, 60_000));
    }), delayMs);
  }

  return {
    get running() { return running; },
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    // Closes the link but keeps the saved session, so the next start reconnects without a QR.
    async stop() {
      running = false;
      connected = false;
      clearTimeout(reconnectTimer);
      const socket = sock;
      sock = null;
      socket?.end(undefined);
      await saving;
      auth = null; // another copy may take over and change the login; the next start reads it fresh
      await setState({ connection: 'disconnected', qr: null });
    },
    // Admin "unlink": removes this device from the phone and forgets the session; a new QR follows.
    async logout() {
      const socket = sock;
      sock = null;
      connected = false;
      await socket?.logout().catch(() => {});
      await forgetLogin();
      await setState({ connection: 'logged-out', qr: null, phone: null, logoutRequested: false });
      if (running) schedule(1_000);
    },
    transport: {
      isConnected: () => connected && !!sock,
      async resolve(to) {
        if (!sock) throw new Error('WhatsApp is not connected');
        const [result] = (await sock.onWhatsApp(to)) || [];
        return result?.exists ? result.jid : null;
      },
      async send(jid, text) {
        if (!sock) throw new Error('WhatsApp is not connected');
        const message = await sock.sendMessage(jid, { text });
        return message?.key?.id;
      },
    },
  };
}
