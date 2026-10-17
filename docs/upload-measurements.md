# Upload measurements

Timing diagnostics cover the upload flow. Background jobs/mobile background
operation are excluded by the owner's instruction. The optimized request flow,
retry contract and deployment checks are documented in `upload-flow.md`.

Enable `UPLOAD_TIMING_ENABLED=true` in the backend process and build the portal
with `REACT_APP_UPLOAD_TIMING_ENABLED=true`. Both switches default to off.
Backend logs contain one `[upload-timing]` JSON record per upload response or
aborted connection. Browser console records use the same prefix. Match the
browser's `serverTimingId` to the backend's `id` (exposed through the existing
CORS policy as `X-Upload-Timing-Id`). Do not enable diagnostics on unrelated apps.

## Reading the measurements

- Browser file preparation includes validation and JPG compression; submit
  timing starts separately, after file selection. External uploads do not
  compress images in the current flow.
- Browser `request_started` to `response_headers_received` includes network,
  hosting/proxy wait and server work. It is **not** pure upload transfer time.
- Server `request_body_received` is an offset since Express received the
  request, including any time spent waiting for auth while data arrives.
- `controller_entered` is after auth/access checks and multipart buffering.
  These early offsets overlap; do not add them as separate stage durations.
- Measured spans separate order/access/settings queries, Drive folder lookup
  (and creation/permission if needed), each file upload and permission call,
  allowance writes, request save and notification preparation.
  With bounded parallel uploads, file-operation spans overlap: do not sum their
  durations to calculate wall time. Cache hits may omit folder lookup spans.
- `controller_response_ready` to response finish includes response middleware
  such as email-draft finalization and external-link successful-use recording.
  Actual email delivery starts after the response and is outside this total.
- Server total ends at response finish, not client receipt. Browser total also
  includes response JSON parsing. Their difference is not a precise network
  transfer measurement (different start/end boundaries).
- Failed spans have `ok:false`; a closed connection is logged once. Timings
  contain generated correlation IDs, counts/bytes and stage names, no file
  names, notes, credentials or account IDs. Existing legacy logs are unchanged.

## Controlled verification

Run `node --test tests/uploadTiming.test.js` for a real loopback HTTP/multipart
request through the upload controller and Drive service. External database,
Drive and email operations are stubbed: this verifies instrumentation and
failure cleanup, **not production speed**. Run the existing external-upload
tests as the access-policy regression check.

The local checkout has no default/configured Google Drive credential file.
No live client data, Drive files, allowance or emails were changed during these
checks. Live timing evidence requires deploying/enabling these diagnostics and
capturing an ordinary authorized upload. Compare a single KB-size file and a
batch on the same connection, then repeat to distinguish first-request latency.
Disable both switches after collecting sufficient evidence.

## Evidence collected on 17 Oct 2026

- Combined timing and external-upload checks: 23 tests passed, 0 failed.
- Frontend production build with diagnostics enabled passed (existing lint,
  Browserslist and bundle-size warnings). Browser-helper opt-in, correlation
  and single-emission checks passed; this was not a physical-mobile test.
- Read-only live `HEAD https://api.merasoftware.com/ping` from the development
  machine: HTTP 200 in 529 ms, 929 ms and 386 ms (three sequential requests).
  This endpoint skips file handling, Drive and database queries. These samples
  show only HTTP response latency from this machine at that time; they do not
  establish a file-upload bottleneck, client-mobile latency or a speed limit.
- Local default and configured Drive credential paths are unavailable, so no
  real Drive upload duration or end-to-end production-upload total was measured.

Backups before this change: `work105-upload-measurements/` in each portal repo;
keep these folders out of commits.
