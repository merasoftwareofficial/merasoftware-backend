# Final-message Stop and outgoing identity corrections

Completed locally, 4 November 2026. No production database writes, deployment, recovery batch or real messages. This supersedes the outgoing-classification and in-progress-send descriptions in the earlier Stop countdown notes.

## Ownership and invariants

- `helpers/whatsappQueue.js` remains the only queue insertion path. It freezes manual/automated provenance while the originating email draft still exists. Lead-message templates and reviewed phone-only proposals retain their manual origin; the dedicated countdown message and closure are automated.
- `whatsapp/src/sender.js` remains the only queue consumer that calls the connection transport. Existing shared slot, ready order, gap/jitter, quiet hours, pause/offline, maximum queue age and attempt limits remain in force. Failures before handoff can retry under those limits. An uncertain failure after handoff is failed for review, never blindly retried.
- Queue status remains the delivery authority. A new `sendPhase` distinguishes preparing/typing from committed handoff without changing the queue status enum or scheduling rules. The connection forwards the preallocated ID through Baileys' supported messageId option.
- `WhatsappOutgoingAttempt` in `whatsapp/src/models.js` is sender identity bookkeeping, not another queue or sender. Each attempt gets an ID before transport is invoked, with source and optional cycle reference. No text is copied. This metadata has no TTL so delayed echoes cannot become falsely manual when queue/draft TTL runs. Indexes support phone/time/source lookup. A successful queue result can settle interrupted attempt bookkeeping using its exact attempt ID.
- `FinalMessage` remains authoritative for countdown state. `helpers/stopFinalMessage.js` owns Stop, outgoing classification, shared cycle guards and transactional handoff. Jobs use cycle/draft/status checks; stopped state cannot be overwritten by the stage-moved cancellation path. Lead preparation also uses compare-and-set rather than unconditional upsert over an existing cycle.
- Stop can cancel pending and explicitly preparing original/closure work. Stop and handoff write the same queue/cycle documents in a transaction. A committed handoff or legacy sending row with unknown phase cannot be recalled. Neither Stop nor classification rewrites lead/client Current status, promised hours or original deadlines.
- Deadline/dispatch claims require no unresolved outgoing checks. Sender eligibility is checked after typing, then handoff checks the current cycle again. Incoming reply, Stop and cycle replacement writes conflict with the same cycle claim. Existing phone/account/behaviour/template eligibility continues through the existing validator.
- Successful manual sends are recovered by the periodic job even without an echo or immediate sender callback. Unknown provenance and ambiguous manual delivery postpone automatic closure. Retained unknown checks remain unknown after old queue deletion; absence of a record is not later reinterpreted as proof of manual conversation. Legacy sending/failed/retried rows without a saved ID require reconciliation if they overlap outgoing evidence. Normal phone messages without such ambiguity stop the cycle.
- New cycles retain a precise cycleStartedAt. Previous manual attempts cannot stop an explicit later cycle. Historical cycles retain the original timestamp fallback; no existing cycle was migrated or reset.

## Verification

Before fixes, regressions reproduced lost-ack false Stop, background overwrite of Stop, lost manual-template provenance and inability to Stop during typing. An additional failure-injection case reproduced interrupted settlement after a successful manual queue result. These now pass.

Final command (isolated MongoDB fixtures and fake transports only):

```powershell
node --test tests/finalMessage.test.js tests/offerTargets.test.js tests/leadMessage.test.js tests/whatsappQueue.test.js tests/whatsappControl.test.js tests/broadcast.test.js tests/autoReply.test.js tests/emailControl.test.js tests/reviewDelivery.test.js whatsapp/tests/sender.test.js whatsapp/tests/connection.test.js whatsapp/tests/inbound.test.js
```

292/292 passed. Includes actual pre-send hook use for countdown fixtures, Stop before/after handoff, initial client Stop preserving Won, no-echo success/uncertainty, queue retention, delayed/duplicate echoes, explicit restart isolation, reply/deadline interleaving, pre-handoff retry identity and no automatic retry after uncertain handoff. Queue architecture static check excludes archived backup copies while still checking application sources. `git diff --check` passed. No frontend implementation changed in this correction set.

Originals: backend `backup/fix2`; website documentation `backup/fix6`. Test output: backend `backup/fix2/final-verification.txt`. Backups retain previously uncommitted work; do not restore whole files over subsequent unrelated edits without reviewing them.

## Rollout and recovery still pending

Use a transaction-capable database. Pause queue consumption and drain any actual handoff before replacing backend and worker together; do not leave old workers sending without the new intent/phase contract. Preserve queue settings, timestamps, pending work and existing cycle data. Verify the unique per-cycle closure queue index and attempt model availability without calling syncIndexes as a production migration. Resume with an owner's controlled test number and verify actual results before any historical recovery.

Historical recovery remains the separate plan at `E:/Allprojects/merasoftware/src/docs/FINAL_MESSAGE_LEGACY_RECOVERY_PLAN.md`. Its earlier 21-record snapshot is stale, predates outgoing checks and is not an apply list. Reaudit all old elapsed and unfinished cycles, preserve exact before-images and cycle IDs, exclude stopped/replied/changed/ambiguous records, and enroll only proven eligible cycles. Do not infer historical direct-phone conversation from missing database evidence. Recovery must only enroll the existing dispatcher; it must never send directly or restart the original countdown. No recovery script or batch was executed by these corrections.

Unresolved legacy delivery/provenance requires operator reconciliation; this implementation deliberately holds closure rather than guessing. Provider delivery and production configuration remain unverified by local tests. After handoff, external delivery cannot be atomically recalled or guaranteed exactly once.
