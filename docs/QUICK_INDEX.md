# Backend work index

## Current reservation/payment work — 25 October 2026

- Read `docs/CODE_AUDIT.md` for completed corrections and remaining transaction risks.
- Invoice uniqueness: `models/invoiceModel.js`.
- Transactional project UPI approval/rejection and wallet payments: `helpers/projectPaymentSettlement.js`, called by `controller/user/transactionApprovalController.js` and `controller/user/walletPayInstant.js`.
- Admin create: `helpers/adminProjectCreation.js` orchestrates the financial transaction; `controller/order/adminCreateProjectOrder.js` validates the quote before it and queues review mail afterwards.
- Manual pending-project approve/reject: `controller/order/approveProjectOrder.js` delegates to `helpers/projectPaymentSettlement.js`. Tests: `tests/adminProjectTransactions.test.js`.
- Reservation state, lead linkage, extension and first-payment qualification: `helpers/offerReservations.js`, `models/offerReservationModel.js`.
- Expiry/force pricing revisions, fair reconciliation batches and payment decision guards: `helpers/reservationRepricing.js`.
- Receipt allocation and surplus wallet credit use the existing transaction ledger: `helpers/projectReceiptReallocation.js`; paired internal entries use paymentMethod `allocation` and never move wallet money.
- Force preview token: `models/reservationActionPreviewModel.js`. API: `routes/offerReservations.js`. Actor/state/expiry/single-use checks happen in the apply transaction.
- Durable extension notice outbox: `models/reservationNoticeModel.js`, `helpers/offerReservationConfirmation.js`; existing Email Control and WhatsApp mirror deliver it.
- Received money: `helpers/orderPaymentTotals.js`; invoice settlement: `helpers/paymentRecording.js`.
- Due invoice/upload filtering: `helpers/projectDuePayment.js`.
- Reproduce/verify: `tests/paymentFoundation.test.js`; isolated replica-set MongoDB, no app/env startup or real deliveries.
- Reservation/reminder plan and owner decisions: `E:/Allprojects/merasoftware/src/docs/OFFER_RESERVATION_REMINDER_PLAN.md`.
- Final local tests: 175 main-suite cases plus 2 durability/migration cases passed; 4 browser checks passed. Logs under `E:/Allprojects/backup/backend/work14-reservation-final/`.
- Rollout/index migration: `docs/RESERVATION_ROLLOUT.md`, `scripts/migrateReservationIndexes.js` (preview default; no implicit .env). Live rollout/delivery remain unverified. Central daily/manual/stage reminders and signup OTP remain deferred.
