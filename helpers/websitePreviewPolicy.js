const { createHash } = require('node:crypto');
const POLICY = Object.freeze({ version: 1, zipBytes: 50 * 1024 ** 2, totalBytes: 200 * 1024 ** 2,
  fileBytes: 10 * 1024 ** 2, fileCount: 500, pathBytes: 240, concurrency: 4,
  uploadMs: 30 * 60_000, tokenMs: 10 * 60_000, leaseMs: 10 * 60_000,
  permissionSeconds: 60, handoffSeconds: 15, renewMs: 40_000 });
const MIME = Object.freeze({ html: 'text/html', css: 'text/css', js: 'application/javascript', mjs: 'application/javascript',
  json: 'application/json', txt: 'text/plain', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' });
class PreviewError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const fail = (message, status) => { throw new PreviewError(message, status); };
function normalizedPath(value) {
  if (typeof value !== 'string') fail('Invalid website path');
  const path = value.normalize('NFC');
  if (!path || Buffer.byteLength(path) > POLICY.pathBytes || /[\\\x00-\x1f\x7f%?#:]/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) fail('Unsafe website path');
  const top = path.split('/')[0].toLowerCase();
  if (['api', 'admin', '_next', '__website-preview', 'sw.js', 'service-worker.js'].includes(top)) fail('Reserved website path');
  if (!MIME[path.split('.').pop().toLowerCase()]) fail('Unsupported website file');
  return path;
}
function manifestFor(files, projectId, versionId) {
  if (!Array.isArray(files) || !files.length || files.length > POLICY.fileCount) fail('Website must contain 1–500 files');
  const seen = new Set(); let total = 0;
  const manifest = files.map(file => {
    const path = normalizedPath(file.path);
    if (seen.has(path)) fail('Duplicate normalized website path'); seen.add(path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > POLICY.fileBytes) fail('A website file exceeds the size limit');
    total += file.size;
    return { path, key: `website-previews/${projectId}/${versionId}/${path}`, size: file.size, contentType: MIME[path.split('.').pop().toLowerCase()] };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!seen.has('index.html')) fail('Website requires a root index.html');
  if (total > POLICY.totalBytes) fail('Website exceeds the total size limit');
  return { manifest, hash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), total };
}
function previewHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?-preview\.merasoftware\.com$/.test(host)) fail('Use a project-specific name ending in -preview.merasoftware.com');
  return host;
}
module.exports = { POLICY, MIME, PreviewError, fail, normalizedPath, manifestFor, previewHost };
