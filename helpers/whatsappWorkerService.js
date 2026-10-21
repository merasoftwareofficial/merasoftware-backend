const path = require('node:path');
const { fork } = require('node:child_process');

// Opt-in supervisor for the WhatsApp sender (whatsapp/, ESM). It runs as its own process so a
// WhatsApp crash restarts only the sender, never the API. Same pattern as portfolioWorkerService.
// Default OFF: a missing or unset ENABLE_WHATSAPP never connects a number or sends a message.
function startWhatsappWorkerService() {
  if (process.env.ENABLE_WHATSAPP !== 'true') return;
  let worker, restart, stopping = false;
  function launch() {
    if (stopping) return;
    worker = fork(path.join(__dirname, '../whatsapp/src/index.js'), [], {
      cwd: path.join(__dirname, '..'), stdio: 'inherit', windowsHide: true,
      env: { ...process.env, ENABLE_SENDER: 'true', WHATSAPP_EMBEDDED: 'true' },
    });
    worker.once('error', error => console.error('[whatsapp] Worker process error:', error.code || 'unknown'));
    worker.once('exit', () => {
      if (!stopping) restart = setTimeout(launch, 15_000);
    });
  }
  function stop() {
    stopping = true; clearTimeout(restart);
    if (worker && !worker.killed) worker.kill('SIGTERM');
  }
  process.once('SIGTERM', () => { stop(); process.exit(0); });
  process.once('SIGINT', () => { stop(); process.exit(0); });
  process.once('exit', stop);
  // Render's free plan shows no memory graph; the worker logs its own memory, this logs the API's.
  setInterval(() => console.log(`[whatsapp] backend memory rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`), 10 * 60_000).unref();
  launch();
  console.log('[whatsapp] Worker supervisor started.');
}
module.exports = { startWhatsappWorkerService };
