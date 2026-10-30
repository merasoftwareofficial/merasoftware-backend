const WORKER_SILENT_MS = 90_000;
const workerAlive = (state, now) => !!state?.heartbeatAt && now - state.heartbeatAt < WORKER_SILENT_MS;
function stoppedReason(state, now = new Date()) {
  return process.env.ENABLE_WHATSAPP !== 'true' ? 'off' : !workerAlive(state, now) ? 'not-running'
    : state?.paused ? 'paused' : state?.connection !== 'connected' ? 'offline' : null;
}
module.exports = { WORKER_SILENT_MS, workerAlive, stoppedReason };
