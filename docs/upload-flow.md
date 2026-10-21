# Upload request flow

## Current browser contract

Portal and external upload clients negotiate a mode before submission writes.
The existing form, confirmation screen and visual theme remain. The shared Modal
renders through a React portal into document.body so a transformed page ancestor
cannot clip or misplace its fixed backdrop. Its scroll body uses a dynamic
viewport height cap.

UploadProvider owns the browser operation above page navigation. First it reads
GET on the session root with no-store. The authenticated, read-only response is
{success:true,data:{protocol:1,mode:'legacy'|'staged'}}. Missing/invalid staging
configuration selects legacy; an older backend's 404 also selects legacy.
Other errors stop negotiation before any files are sent. The selected mode is
pinned to the attempt, including all retries; a lost staged response never
switches to legacy.

Legacy mode uses the existing keyed multipart submit and progress endpoints.
While the request body is sent it shows "Sending files to server — X%" (XHR
transferPercent). Total % = files saved to Drive (completedFiles / totalFiles
from GET upload-progress), labelled "Saving files — N of M", then "Finishing
upload…" in the finalizing phase. Total reaches 100% only with the last saved
file / success. Completion waits for the existing server response/status. It
cannot provide true per-file byte percentages or receipt-before-Drive completion.
Total % is file-count based (the server reports counts, not bytes).

Change 2026-10-18 (fix111, frontend src/context/UploadContext.js executeLegacy/
pollLegacy/label): before, the XHR transfer % was written to the Total bar, so it
hit 100% as soon as bytes reached the server while Drive saving was still
running file by file. No backend change.

In staged mode:
1. Preparing files: calculate each selected file's SHA-256 manifest.
2. Connecting: POST the immutable manifest with a stable uploadId.
3. Upload file 1 of N through N of N: one multipart XHR per file, with actual
   upload byte events, current-file %, individual file rows and a byte-weighted
   total %. A file is marked Uploaded only after durable acknowledgement.
4. Confirming upload: POST complete after every file is received.
5. Upload finished: the receipt transaction committed. Google Drive processing
   continues on the server and is not included in browser upload progress.

XHR progress includes multipart framing. A displayed 100% means the request body
was sent; a brief confirming stage still verifies receipt. No fabricated stages,
time estimates or simulated percentages are used. Minimize and portal navigation
retain the panel. Keep the browser open until Upload finished. Browser closure,
reload continuation, mobile suspension and OS status-bar uploads are excluded.
Staged retry retains the same identity and sends only files not acknowledged by status.
Legacy retry retains its original keyed submission identity.
Account changes hide the previous account's panel and suppress its callback;
navigation suppresses callbacks for the old route. Expanded progress reuses the
shared Modal with opt-in centered placement on desktop/mobile. Minimize moves
status to the corner and releases the dialog scroll lock. Escape/X minimize;
backdrop clicks do not discard uploads. Other modals keep their default layout.

## Endpoints and ownership

Portal (normal authenticated cookie):
- GET /api/upload-sessions (capability negotiation, no reservation/write)
- POST /api/upload-sessions?uploadId=UUID
- GET /api/upload-sessions/:uploadId
- POST /api/upload-sessions/:uploadId/files/:fileId
- POST /api/upload-sessions/:uploadId/complete

External scoped cookie: the same operations under /api/external-upload/uploads.
State-changing external requests retain the allowed-origin and live link/consent
checks. File identity and ownership are checked before multipart buffering. The
server derives the external order/customer from the scoped session. A consumed
single-use link may replay/read its own successful submission while its scoped
cookie remains valid; revocation is still enforced.

The manifest fixes filename, type, size and content hash; changed data under the
same identity is rejected. Shared file filtering and the 5 MiB/file cap remain.
Order access, file limits and allowance policy share uploadOrderPolicy.js.
Receipt acceptance rechecks policy and commits the UpdateRequest, allowance,
single-use link consumption, replay result and durable delivery job together in
one Mongo transaction. Projects spend no service allowance.

## Durable staging and delivery

UploadSubmission tracks receipt identity, immutable manifest and delivery state.
StagedUploadFile stores each file's bytes in a separate document. An explicit
UploadStorageBudget reserves the entire batch before accepting bytes.
Incomplete sessions expire after 25 minutes; cleanup releases their bytes and
matching external reservation. There is no TTL deletion of accepted payloads.

The receipt stores deliveryStatus=queued and metadata without Drive links.
Upload history says files will be available shortly. uploadWorker.js claims
durable jobs with a two-minute lease, refreshed every ten seconds. It processes
up to three files per job and shares the existing six-slot per-Node Drive gate.
Each file gets a preallocated Drive ID persisted before creation. Uncertain
creation retries reuse that ID; a 409 is accepted only when the remote hash and
size match. Completed per-file results survive worker retries.

The final fenced Mongo transaction publishes Drive links, sets deliveryStatus
to ready, deletes staged bytes and releases the byte budget together. After
eight failed attempts the job becomes needs_review; bytes and tracked IDs remain
available for recovery. Admin-only POST
/api/admin/upload-submissions/:submissionId/retry requeues such a job.
Removed parent records trigger cleanup; failed remote deletion retains its
references. Worker activity sends no email. Existing request-context notification
preparation runs at receipt acceptance and is skipped on replay.

GoogleDriveService retains its five-minute bounded client/folder caches and
per-file sharing calls. Live folder permission inheritance has not been verified.
The older multipart endpoint and keyed synchronous flow remain compatible for
already deployed clients; their existing concurrency and cleanup behavior remain.

## Rollout requirements

1. Use a Mongo replica set/Atlas deployment supporting transactions, as required
   by the existing keyed flow. Allow sufficient data and index capacity for the
   staging budget plus existing data and operational headroom.
2. Set ENABLE_UPLOAD_WORKER=true and UPLOAD_STAGING_MAX_BYTES to an explicit
   positive integer byte capacity chosen from available database storage.
   Neither is guessed or set by this implementation. Missing configuration
   makes negotiation select legacy. Direct staged creation still returns 503.
   Configuration is an opt-in, not a live Drive/worker health probe; verify
   actual delivery before enabling staging in production.
3. The API starts the worker after DB connection. Use an always-on API instance,
   or run node scripts/uploadWorker.js as an always-on background service with
   the same database, staging configuration and existing Drive credentials.
   A sleeping host cannot process jobs until it resumes. Multiple instances
   share Mongo leases and the storage budget; Drive slot limits are per process.
4. Deploy the backend correction before the frontend correction. Existing uploads
   remain available without staging settings. Before enabling staged mode, verify
   real worker readiness and Drive access.
   Check a test receipt followed by delivery=complete and staging budget release.
   Inspect [upload-worker] logs for retry/needs_review. Monitor budget, database
   capacity and jobs requiring review.
5. No mobile/browser permission is needed. Existing backend Drive credentials
   are still required. Production host availability, database free capacity and
   real Drive access have not been verified locally.

## Focused verification

Backend:
node --test tests/stagedUploads.test.js tests/uploadFlow.test.js tests/uploadTiming.test.js tests/externalUploadPhase21.test.js tests/externalUploadPhase3.test.js

Frontend:
node tests/upload-flow-browser.cjs

Tests use an isolated Mongo replica set, fake Drive responses and controlled HTTP
endpoints. Browser tests use real throttled XHR and actual existing portal CSS,
including the actual upload modal beneath the tall transformed page ancestor.
Coverage includes desktop/phone/landscape popup bounds, real file percentages,
weighted totals, exact centered expanded placement/corner minimize, disabled or
invalid settings, older backends, pinned-mode retries, offline/reconnect,
failed negotiation, lost session/file acknowledgements, receipt
replay, external revocation and worker restart. The browser harness bundles only
its focused components and reads existing CSS; it does not run npm run build.
