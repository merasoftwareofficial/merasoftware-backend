const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');

function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}
function captureUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Only public HTTP(S) websites on ports 80/443 can be captured.');
  return url;
}
async function resolvePublic(host, lookup = dns.lookup) {
  host = host.replace(/^\[|\]$/g, '');
  let timeout;
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('DNS lookup timed out.')), 10_000); }),
    ]);
  } finally { clearTimeout(timeout); }
  if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) throw new Error('Private or reserved network destinations cannot be captured.');
  return addresses[0].address;
}

// All browser traffic passes through this proxy. Validate EVERY destination,
// including redirects/subresources, then dial the checked IP (no second DNS lookup).
async function createCaptureProxy() {
  const sockets = new Set();
  let connections = 0, transferred = 0;
  const track = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (++connections > 500) socket.destroy();
    socket.on('data', bytes => { transferred += bytes.length; if (transferred > 100 * 1024 * 1024) for (const active of sockets) active.destroy(); });
    return socket;
  };
  const proxy = http.createServer(async (req, res) => {
    try {
      const url = captureUrl(req.url);
      if (url.protocol !== 'http:') throw new Error('Use CONNECT for HTTPS.');
      const address = await resolvePublic(url.hostname);
      if (req.destroyed || res.destroyed) return;
      if (!['GET', 'HEAD'].includes(req.method)) throw new Error('Capture is read-only.');
      const headers = { ...req.headers, host: url.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = http.request({ hostname: address, port: Number(url.port || 80), path: `${url.pathname}${url.search}`, method: req.method,
        headers, timeout: 15_000,
      }, incoming => { res.writeHead(incoming.statusCode || 502, incoming.headers); incoming.pipe(res); });
      upstream.on('socket', track);
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    } catch { res.writeHead(403); res.end('Capture destination blocked'); }
  });
  proxy.on('connection', track);
  proxy.on('connect', async (req, socket, head) => {
    try {
      const target = new URL(`https://${req.url}`);
      if (Number(target.port || 443) !== 443 || target.username || target.password) throw new Error('Blocked port');
      const address = await resolvePublic(target.hostname);
      if (socket.destroyed) return;
      const upstream = track(net.connect({ host: address, port: 443 }));
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${proxy.address().port}`,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); },
  };
}
async function captureWebsite(value) {
  const url = captureUrl(value);
  await resolvePublic(url.hostname);
  const { chromium } = require('playwright');
  const proxy = await createCaptureProxy();
  let browser;
  let deadline;
  try {
    browser = await chromium.launch({ headless: true, proxy: { server: proxy.url, bypass: '<-loopback>' },
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
    deadline = setTimeout(() => browser.close().catch(() => undefined), 90_000);
    const images = {};
    for (const [mode, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mode === 'mobile', hasTouch: mode === 'mobile', serviceWorkers: 'block', acceptDownloads: false });
      await context.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
      await context.routeWebSocket('**/*', socket => socket.close());
      const page = await context.newPage();
      page.on('dialog', dialog => dialog.dismiss());
      page.on('popup', popup => popup.close());
      const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
      if (!response || response.status() >= 400) throw new Error('Website did not load successfully.');
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      images[mode] = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false, animations: 'disabled', timeout: 10_000 });
      if (images[mode].length > 1_800_000) throw new Error('Screenshot too large.');
      await context.close();
    }
    return images;
  } finally {
    clearTimeout(deadline);
    if (browser) await browser.close().catch(() => undefined);
    await proxy.close();
  }
}
module.exports = { isPublicAddress, captureUrl, resolvePublic, createCaptureProxy, captureWebsite };
