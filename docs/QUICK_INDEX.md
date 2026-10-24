# Backend work index

## Payment foundation — 24 October 2026

- Read `docs/CODE_AUDIT.md` for completed corrections and remaining transaction risks.
- Invoice uniqueness: `models/invoiceModel.js`.
- Transactional project UPI approval/rejection and wallet payments: `helpers/projectPaymentSettlement.js`, called by `controller/user/transactionApprovalController.js` and `controller/user/walletPayInstant.js`.
- Admin create: `helpers/adminProjectCreation.js` orchestrates the financial transaction; `controller/order/adminCreateProjectOrder.js` validates the quote before it and queues review mail afterwards.
- Manual pending-project approve/reject: `controller/order/approveProjectOrder.js` delegates to `helpers/projectPaymentSettlement.js`. Tests: `tests/adminProjectTransactions.test.js`.
- Customer self-creation, reservation and price-revision orchestration remain separate pending work; do not assume every historical writer is migrated.
- Received money: `helpers/orderPaymentTotals.js`; invoice settlement: `helpers/paymentRecording.js`.
- Due invoice/upload filtering: `helpers/projectDuePayment.js`.
- Reproduce/verify: `tests/paymentFoundation.test.js`; isolated replica-set MongoDB, no app/env startup or real deliveries.
- Reservation/reminder plan and owner decisions: `E:/Allprojects/merasoftware/src/docs/OFFER_RESERVATION_REMINDER_PLAN.md`.
