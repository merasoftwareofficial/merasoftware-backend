# Upload request flow

Implemented for the portal and external upload surfaces. No background jobs,
service workers or mobile status-bar uploads. The browser must remain open.

## Concurrency and storage

`helpers/uploadConcurrency.js` runs at most three files per submission and six
Drive upload/folder/cleanup pipelines per Node process. Multiple replicas each
have their own six-slot limit. Results preserve selection order. On failure,
workers stop taking new files, all in-flight work settles, and successfully
created files are cleaned up before reporting failure. An unconfirmed cleanup
marks a keyed submission `needs_review`; the UI does not offer an unsafe retry.

`GoogleDriveService` reuses SDK clients and folder lookup promises for five
minutes, bounded to 16 clients/32 folders and keyed by credential path/folder
name. Failed lookups are evicted. A Drive 404 invalidates the folder cache for
the next request. File creation is not blindly retried. Deleting an already
missing file is successful cleanup.

Per-file sharing requests are deliberately retained. Live folder inheritance
and equivalent access have not been verified because local Drive credentials
are unavailable. Do not remove these calls based only on a folder name/cache.
The helper is shared with client documents, proposals and follow-up attachments.

## Submission identity and consistency

New clients attach a stable random `uploadId` query parameter. The server hashes
the instructions/order/file metadata and file bytes. An owner/scope/id unique
index in `UploadSubmission` allows one active attempt. A changed payload with
the same id gets 409. Same-data retries replay a successful result or return 202
while the original request is processing. Known, cleaned failures can be retried
using the same id and a new fenced attempt token.

The final Mongo transaction saves the update request, spends the service/legacy
allowance, consumes the external link, and saves the successful replay result
together. Project uploads spend no allowance. A transaction touches the project
order's `uploadRevision` to conflict with concurrent order changes. Service
allowance is rechecked inside the transaction. Unknown commit results never
trigger automatic deletion of possibly committed Drive files.

These records track active HTTP requests; no process resumes work from them.
After five minutes without progress, the status response reports `needs_review`.
No automatic takeover/reupload occurs after a process crash. Successful records
are retained for replay and are not automatically expired.

Older clients without an id retain the prior response/allowance path and do not
gain the new retry guarantee. Deploy the backend before the new frontend.

## Progress and minimize

`UploadProvider` owns the active browser upload above the router's page outlet.
`XMLHttpRequest.upload` provides actual byte-transfer percentages. After those
bytes are sent, the panel shows acknowledged Drive file counts and then final
save status. It never treats 100% transfer as completed submission.

Authenticated `GET /api/upload-progress/:uploadId` is owner-scoped. External
`GET /api/external-upload/progress/:uploadId` requires the live scoped cookie,
client consent/account eligibility and the same link. A used single-use link
can read/replay its successful submission only; revoked/replaced links remain
rejected. New keyed success keeps the scoped cookie for its original 15-minute
lifetime so a lost response can be recovered. It grants no new submission after
the link is consumed.

Minimize keeps a compact status panel; portal navigation does not own the
request. Reload, browser closure and mobile suspension are not supported
continuation paths. A pending upload prompts before normal reload/closure.
There is one active upload per browser app instance. File bytes live in memory
until success/dismissal. The panel and completion callback are hidden from a
different signed-in portal account. Page-specific completion callbacks only run
on the original route, preventing stale page refreshes after navigation.
Network errors read status before offering
retry; unknown/review states expose a status check instead of a new submission.

## Verification and deployment

- `node --test tests/uploadFlow.test.js tests/uploadTiming.test.js tests/externalUploadPhase21.test.js tests/externalUploadPhase3.test.js`
- In the frontend: `node tests/upload-flow-browser.cjs` and `npm run build`.
- Transaction tests use an isolated local Mongo replica set; browser checks use
  controlled HTTP endpoints and real XHR, without client data or external writes.
- Production Mongo must support transactions (replica set, such as Atlas).
  There is no non-atomic fallback for keyed uploads. The submission unique index
  must be created successfully; Mongoose initialization checks it on first claim.
- Backend-first rollout, then frontend. Keep the existing timing flags enabled
  while collecting new evidence. The prior samples were 4.65 seconds for one
  file and 18.71 seconds for ten files. Repeat the same authorized uploads several
  times after deployment; concurrency tests are not a live speed claim.
- No hosting/database region changes were made: the 230–250 ms query samples
  warrant checking actual regions before changing database architecture.

Backups: `work106-upload-flow/` in each portal repository. Keep backups and
unrelated existing email-editor/template changes out of upload commits.

Local verification: 30 backend tests and four browser scenarios passed. The
browser scenarios cover byte/save progress with minimize and navigation, lost
responses, same-identity retry and account changes. No live before/after upload
comparison or live sharing-inheritance experiment has been performed.
