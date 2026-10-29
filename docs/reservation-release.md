# Cancelled/deleted project reservation release

Implemented 30 October 2026 in backend and portal.

`helpers/reservationRelease.js` owns release and historical-link repair. Cancellation saves the cancellation and releases the reservation in one Mongo transaction, after the existing refund operation. Deletion releases inside its existing transaction. The existing external refund workflow is not rolled back by a failed cancellation transaction.

Automatic reuse is limited to reservations without confirmed price lock, prior force-apply, wallet credit, pending/completed payment transactions, paid/part-paid project invoice evidence, or paid/completed order flags. Completed payments remain a review boundary even if refunded. These cases stay linked; the portal explains that financial review is needed and hides unusable extension/force buttons. This change does not add a paid-reservation transfer override.

Release archives the previous project ID, actor/time/reason and pricing resolution in `releases`, clears the current link on both sides, and clears the previous project's pricing processing state. The original reservation clock, saved price/terms and extensions are retained. Old project agreements, invoices and transactions are untouched. Reuse remains subject to existing customer/category/deadline checks; expired reservations require the existing supported extension/force protocol. Previously force-applied reservations remain ineligible for automatic reuse.

Historical cancelled/missing links are repaired on reservation listing and offer project pricing, using the same transactional guards. No bulk production data script is required. User writes serialize with project creation; reservation/order writes conflict with concurrent attachment/payment activity. Repair is idempotent. A replacement project can subsequently expire/reprice independently of the old project's closed resolution.

Admin reservation responses include release history and `reuseNeedsReview`. The portal displays the last release date and that the original deadline remains.

Validation: 136 tests passed using isolated in-memory replica sets:

    node --test tests/offerReservations.test.js tests/reservationRepricing.test.js tests/adminProjectTransactions.test.js tests/paymentFoundation.test.js tests/offerPaymentPolicy.test.js tests/salesPricing.test.js tests/projectCreateForm.test.js

Includes actual cancellation/deletion controllers, historical repair, unchanged snapshot/deadline, expiry/repricing on replacement, blocked payment/lock/force cases, concurrent repair/creation, deletion rollback and cancellation rollback. Portal JSX parser and targeted ESLint checks are separate. Deploy backend before portal. No production data or deployment was performed during implementation.
