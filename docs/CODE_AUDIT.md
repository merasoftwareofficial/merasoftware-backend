# Payment foundation audit

Verified 24 October 2026. Scope: baseline paid-state corrections, project UPI/wallet settlement and admin creation/manual approval transactions.

## Corrected locally

- `models/invoiceModel.js`: service statement uniqueness now uses a distinct compound key order and explicit index name; the original project_final index remains unchanged. Same-order project/service summaries coexist; duplicates per type are rejected.
- `controller/user/transactionApprovalController.js`: UPI installment completion follows its settled invoice, not the existence of any approved partial payment. Partial full-project payment no longer marks the project complete or newly approves work.
- `controller/user/walletPayInstant.js`: order-mode partial wallet/combined payments do not mark full-project paymentComplete; non-installment amount sufficiency is checked before approving work.
- `helpers/projectDuePayment.js`: includes partially_paid invoices and explicitly selects project payment bills, excluding final statements.
- Existing offer-policy fixture now supplies required installment percentages.

## Validation

107 tests passed across adminProjectTransactions, paymentFoundation, offerPaymentPolicy, salesPricing, projectCreateForm, projectCategories and emailControl. Full output: `E:/Allprojects/backup/backend/work8-admin-project-transactions/validation.txt`. Syntax checks and `git diff --check` passed.

New regressions exercise real controllers/storage with a disposable replica set. Before correction six of seven initial tests failed for the recorded index/payment/upload defects; the sequential installment success case already passed. Two subsequent failure-injection tests reproduced invoice-paid/payment-pending and lost wallet-debit states. Twenty foundation tests now cover success, rollback, concurrency, replay, combined rejection and invoice ownership/type/balance validation. No production database, deployment or real email/WhatsApp was used. Backups: work6-payment-foundation and work7-transactional-project-payments under `E:/Allprojects/backup/backend/`.

## Transactional project payments

- Existing project wallet and UPI approval/rejection handlers delegate to `helpers/projectPaymentSettlement.js`. Service/legacy accounting stays on its existing paths.
- Explicit sessions propagate through existing invoice settlement, wallet debit/refund, received-money totals, invoice-number read and final-summary save. Wallet, transaction, invoice, installment, project totals and summary commit/abort together on the routed project paths.
- Only a current unpaid installment and a payable invoice for the same customer/project may be paid. Work-progress gates, amount precision and balance are checked in the transaction. Concurrent attempts reread after write conflict; order writes share the uploadRevision boundary.
- A combined-wallet retry verifies identity/context/amount before reusing its original completed payment. Rejection records invoice-linked refunds, then derives remaining money from completed transactions/refunds; it never manually erases receipts.
- Required first-payment price-lock and saved-base-price fallback are owner decisions only; no pricing revision/reservation behavior is activated by this work.

## Remaining plan work

- Admin project creation now commits the initial project/timeline, first payable invoice, optional recorded first payment, totals/summary and creation-complete marker together in `helpers/adminProjectCreation.js`. Creation-key retries preserve the original project and payment. Request-scoped project-created email review stays outside the retryable financial callback.
- Manual approve/reject of a pending project now rechecks role/lifecycle/payment inside the transaction. The payment path reuses shared invoice settlement and derived totals. A competing rejection cannot overwrite a committed approved/paid project.
- Failure injection reproduced stranded project data on creation failure and a paid invoice on manual-approval failure. Both are now covered, along with simultaneous approve/approve, approve/reject and keyed creation races.
- Creation/category integration tests now use disposable replica sets. The category backfill fixture obtains its database-specific URI through getUri(name), preserving replica-set connection parameters.
- Customer self-creation and other unintegrated payment entry points still need transaction/revision orchestration before repricing is activated. Optional-session helpers do not automatically make those callers atomic. Reservation/price revisions still have no active financial writer.
- Invoice numbering still reads the last number. Concurrent creation on different projects may safely abort on its unique index and need retry; no global sequence migration was included. Standalone MongoDB is not supported for the new transactional project-payment paths; verification uses a replica set.
- Pending external-payment verification and insufficient/older invoice payment attempts still require their agreed commercial handling before repricing.
- Existing deployments may have differing index specs or duplicate legacy summaries. Inspect indexes/data explicitly before rollout; do not call syncIndexes against live data as an implicit migration.
- Reservation, lead conversion, client conversion, price revisions, stage due dates, durable communication and central reminder controls are not implemented by this change set.
- No database backfill of previously incorrect paid flags was performed. Historical repair requires a preview/report and explicit migration scope.
