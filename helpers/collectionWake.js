const mongoose = require('mongoose');

const RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000];

function isReplicaSetUnsupported(error) {
  if (!error) return false;
  return error.code === 40573
    || error.codeName === 'Location40573'
    || /only supported on replica sets/i.test(String(error.message || ''));
}

/**
 * Shared SSOT event-driven wake primitive backed by MongoDB Change Streams.
 * - On Atlas replica sets: zero idle polling (maxAwaitTimeMS=60s) with <50ms wake on matching writes.
 * - On standalone MongoDB (tests/local): automatically falls back to bounded timer waits.
 * - Monotonic version() prevents mid-step missed-wakeup races.
 */
function createCollectionWake({
  connection = mongoose.connection,
  collections = [],
  operations = ['insert', 'update', 'replace', 'delete'],
  filter = null,
  onChange = null,
  onReconnect = null,
  maxAwaitTimeMS = 60_000,
  fallbackMs = 15_000,
  keepAlive = false,
  onError = null,
} = {}) {
  const names = [...new Set((collections || []).filter(Boolean))];
  let currentVersion = 0;
  let stream = null;
  let live = false;
  let hasConnectedOnce = false;
  let unsupported = false;
  let closed = false;
  let starting = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const waiters = new Set();

  function wakeAll(bump = true) {
    if (bump) currentVersion += 1;
    for (const resolve of [...waiters]) {
      waiters.delete(resolve);
      resolve();
    }
  }

  function scheduleReconnect() {
    if (closed || unsupported || reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void start();
    }, delay);
    if (!keepAlive) reconnectTimer.unref?.();
  }

  async function start() {
    if (closed || unsupported || stream || starting || !names.length) return;
    if (!connection?.db) {
      scheduleReconnect();
      return;
    }
    starting = true;
    let cursor = null;
    try {
      const pipeline = [
        { $match: { 'ns.coll': { $in: names }, operationType: { $in: operations } } },
        { $project: { _id: 1, ns: 1, operationType: 1, documentKey: 1, updateDescription: 1 } },
      ];
      cursor = connection.db.watch(pipeline, { maxAwaitTimeMS });
      stream = cursor;
      const first = await cursor.tryNext();
      if (closed) {
        stream = null;
        await cursor.close().catch(() => {});
        return;
      }
      live = true;
      reconnectAttempts = 0;
      if (hasConnectedOnce && onReconnect) onReconnect();
      hasConnectedOnce = true;
      if (first && (!filter || filter(first))) {
        if (onChange) onChange(first);
        wakeAll(true);
      }

      void (async () => {
        try {
          for await (const change of cursor) {
            if (closed || stream !== cursor) break;
            if (!filter || filter(change)) {
              if (onChange) onChange(change);
              wakeAll(true);
            }
          }
        } catch (error) {
          if (!closed && isReplicaSetUnsupported(error)) {
            unsupported = true;
          } else if (!closed && onError) {
            onError(error);
          }
        } finally {
          if (stream === cursor) {
            stream = null;
            live = false;
            if (!closed) {
              wakeAll(true);
              scheduleReconnect();
            }
          }
          await cursor.close().catch(() => {});
        }
      })();
    } catch (error) {
      stream = null;
      live = false;
      if (cursor) await cursor.close().catch(() => {});
      if (isReplicaSetUnsupported(error)) {
        unsupported = true;
      } else {
        if (onError) onError(error);
        scheduleReconnect();
      }
    } finally {
      starting = false;
    }
  }

  function wait(maxMs = 60_000, sinceVersion = undefined) {
    if (closed) return Promise.resolve();
    if (sinceVersion !== undefined && currentVersion !== sinceVersion) return Promise.resolve();
    const bounded = Math.max(0, Number(maxMs) || 0);
    const delayMs = live ? bounded : Math.min(bounded, fallbackMs);
    if (delayMs === 0) return Promise.resolve();

    return new Promise(resolve => {
      let timer = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      waiters.add(done);
      timer = setTimeout(done, delayMs);
      if (!keepAlive) timer.unref?.();
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    live = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const active = stream;
    stream = null;
    wakeAll(false);
    if (active) await active.close().catch(() => {});
  }

  return {
    start,
    wait,
    close,
    trigger: () => wakeAll(true),
    version: () => currentVersion,
    isLive: () => live,
  };
}

module.exports = { createCollectionWake };
