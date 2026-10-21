import os from 'node:os';
import { randomBytes } from 'node:crypto';

// Only one running copy may hold the WhatsApp connection and send. Render briefly runs the old and the
// new copy together during a deploy; without this lease both would send and the 30-second gap breaks.
const LEASE_ID = 'sender';

export function createLease(Lock, { ttlMs = 90_000, renewEveryMs = 20_000, now = () => new Date() } = {}) {
  const owner = `${os.hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  let heldUntil = 0;
  let renewedAt = 0;

  async function ensure() {
    const time = now().getTime();
    if (heldUntil > time && time - renewedAt < renewEveryMs) return true;
    try {
      const doc = await Lock.findOneAndUpdate(
        { _id: LEASE_ID, $or: [{ owner }, { expiresAt: { $lt: new Date(time) } }] },
        { $set: { owner, expiresAt: new Date(time + ttlMs) } },
        { upsert: true, new: true },
      ).lean();
      const held = doc?.owner === owner;
      heldUntil = held ? time + ttlMs : 0;
      renewedAt = held ? time : 0;
      return held;
    } catch (error) {
      if (error?.code !== 11000) throw error; // 11000: another copy holds it, so the upsert collided
      heldUntil = 0;
      return false;
    }
  }

  async function release() {
    heldUntil = 0;
    await Lock.deleteOne({ _id: LEASE_ID, owner });
  }

  return { owner, ensure, release };
}
