# Reservation final corrections — rollout

Local source corrections are separate from production activation. No production database, deployment, message delivery or flags were changed by this working.

## Changed behavior

- Project payment settlement repeats reservation price preparation if the deadline crosses while submitting money. Catalogue reads remain outside the Mongo transaction; the financial callback validates the decision and actual submission time. Existing on-time UPI submissions still qualify when approved later.
- Force-apply requires a 15-minute, actor-bound, single-use preview token. Price, payment ledger, reservation deadline/history and order state must match the reviewed state.
- Expiry jobs lease bounded batches and schedule the next check. Later due projects get a turn; previously processed unpaid projects can still adopt a later same-offer extension.
- Revisions keep base scope terms separately from current offer terms. Normal-price fallback retains the reservation's stable offer identity and saved package-extra input for a future extension. PDFs use the updated printable terms.
- New-period website re-reservation is allowed only for an expired, unpaid, unattached reservation; original history is preserved.
- Surplus above the revised project total is credited through the existing wallet-refund ledger, in the revision transaction. Excess on installment 1 is carried to later installments with paired `allocation` payment/refund legs; this does not move wallet money. Original receipts remain unchanged. Each credit/allocation has a stable revision key and original receipt reference. Combined rejection refunds only the remaining amount from that receipt, including carried amounts.
- Deadline-extension delivery has a durable outbox row in the extension transaction. The existing email pipeline/WhatsApp mirror handles delivery; lease, retry and dedupe survive failure/restart. Superseded deadline notices are skipped.

## Preview-first migration

Use a controlled maintenance window with new reservations/repricing disabled on both apps while inspecting and applying indexes. Pause offer-project creation and payment operations during that window; resume after the deployed versions and migration are verified. Do not start global renewal crons for this work.

Set the following in the migration process, using the actual intended application database:

- `RESERVATION_MIGRATION_URI`: the target connection secret.
- `RESERVATION_MIGRATION_DB`: the explicit target database name.

Preview (read-only):

```powershell
node scripts/migrateReservationIndexes.js
```

Review the database name, invalid/duplicate rows, backfill count and obsolete index names. If the report is blocked, resolve the listed records explicitly; the script will not merge/delete financial data.

Apply the reviewed migration:

```powershell
node scripts/migrateReservationIndexes.js --apply
```

The script fills only existing reservations' missing `periodEndsAt` from their immutable offer snapshot. It creates the replacement unique `(userId, offerSlug, periodEndsAt)` constraint before dropping the obsolete unique `(userId, offerSlug)` constraint. It also ensures the lead identity, preview TTL, notice dedupe/retry and scheduler indexes. It does not backfill projects, rewrite prices or call `syncIndexes`. Reruns are safe. Run preview again and inspect final indexes.

## Deployment and activation order

1. Deploy backend, portal and website code from this working. Old force-apply clients safely fail until the new portal sends a preview token.
2. Verify indexes with the migration procedure above. Verify new model collections are writable before enabling actions.
3. Enable `OFFER_RESERVATIONS_ENABLED=true` on the backend and website. Verify member reservation → linked lead → both My Offers surfaces with the same deadline/history.
4. Enable `OFFER_RESERVATION_CONFIRMATIONS_ENABLED=true` on the backend after checking existing Email Control policy and provider configuration. Check one approved test account's email and existing WhatsApp mirror. Phone absence/channel failure must not be reported as successful delivery.
5. Enable `OFFER_RESERVATION_REPRICING_ENABLED=true` on the backend only after reviewing representative real reservation/invoice data and payment/force-apply previews. Verify a controlled expiry, partial receipt/credit, on-time pending submission, extension and invoice/PDF consistency.
6. Enable `OFFER_RESERVATION_JOBS_ENABLED=true` for background recovery/reconciliation. `ENABLE_CRONS` remains independently managed; do not enable it just for reservation jobs.
7. Inspect failed outbox/draft entries, stale leases and `needs_review` resolutions. Check that queued retries do not duplicate wallet credits or accepted messages.

Public offer expiry, personal reservation deadline and invoice due date remain separate. Upload policy/counters remain frozen. No legacy-project repricing, service-plan repricing, centralized daily/manual/stage reminders or signup WhatsApp OTP is activated here.

## Verification

Disposable Mongo replica-set suites cover normal settlement, boundary crossing, rollback, concurrency, wallet credit, receipt reallocation/rejection, preview protection, scheduler fairness, delivery retry and migration. Website/portal browser checks use real components with fixture transport; these do not prove production provider delivery or environment settings. See `docs/CODE_AUDIT.md` for the final local run.
