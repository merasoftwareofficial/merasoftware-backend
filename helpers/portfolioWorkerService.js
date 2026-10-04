const path = require('node:path');
const { fork } = require('node:child_process');

// Opt-in process supervisor for hosts that run the existing Node web service.
// The worker keeps its own Mongo connection and durable lease/outbox.
function startPortfolioWorkerService() {
  if (process.env.ENABLE_PORTFOLIO_WORKER !== 'true') return;
  if (!process.env.PORTFOLIO_WEBSITE_URL || (process.env.PORTFOLIO_INTEGRATION_SECRET || '').length < 32) {
    console.error('[portfolio] Worker disabled: configure website URL and integration secret.');
    return;
  }
  let worker, restart, stopping = false;
  function launch() {
    if (stopping) return;
    worker = fork(path.join(__dirname, '../scripts/portfolioWorker.js'), [], { cwd: path.join(__dirname, '..'), stdio: 'inherit', windowsHide: true });
    worker.once('error', error => console.error('[portfolio] Worker process error:', error.code || 'unknown'));
    worker.once('exit', () => {
      if (!stopping) restart = setTimeout(launch, 15_000);
    });
  }
  function stop() {
    stopping = true; clearTimeout(restart);
    if (worker && !worker.killed) worker.kill('SIGTERM');
  }
  // Preserve the backend's normal signal termination; a cleanup listener must
  // not accidentally keep the HTTP server alive after its host sends SIGTERM.
  process.once('SIGTERM', () => { stop(); process.exit(0); });
  process.once('SIGINT', () => { stop(); process.exit(0); });
  process.once('exit', stop);
  launch();
  console.log('[portfolio] Worker supervisor started.');
}
module.exports = { startPortfolioWorkerService };
