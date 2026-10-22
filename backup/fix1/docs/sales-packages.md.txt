# Showcase packages and project offers

Approved scope: packages are a website showcase and an admin project-creation shortcut. There is no package checkout. Existing service-plan purchase and renewal flows remain independent. Related service IDs are references; selecting a package never buys or activates them.

## Ownership and API

- Portal `SalesCatalogue` stores package configuration: permanent ID, status, project category, complete scope, terms, regular price, linked offer, additional scope price and optional related service IDs.
- Website Settings retains the existing offer definition and its single pricing rule. The portal backend alone calculates the agreed project amount. Financial changes require the current portal admin role, including changes through the website form.
- `GET/PATCH /api/admin/sales-packages`: portal-admin-only catalogue and form saves.
- `GET /api/integration/sales-packages`: server-to-server, shared integration bearer; published packages only, no related service IDs.
- Website `/admin/packages` uses the existing login cookie to manage the portal catalogue. `/campaign/packages` renders its current public quotes. There is no browser-exposed integration secret.
- Website `/api/offers/live` retains its active-offer list and supplies the complete protected catalogue for configuration/expiry handling. The same `PORTFOLIO_INTEGRATION_SECRET` must exist in both environments. Backend `PORTFOLIO_WEBSITE_URL` must point to the matching website environment; website `PORTAL_API_URL` to the matching portal backend.

## Pricing and history

- First samples are one-time project bundles: Starter, Starter Plus, Starter Complete. Defaults apply only before the first catalogue save. A first mutation materializes all samples; archived samples cannot reappear.
- The starter offer is a fixed bundle price. Package `offerExtraPrice` is added to it for extra package scope; it is not a guessed universal discount. Other supported rules are an explicit fixed rupee discount and a percentage discount.
- Ineligible/expired/unpublished offers do not discount new quotes. Category and optional package restrictions are checked server-side. Scope/terms/price hashes invalidate stale forms.
- Extra project features are work outside the package scope. Optional admin discounts require a reason and appear separately from the offer benefit. The server checks the displayed final total before writing anything.
- `projectSnapshot.salesAgreement` freezes package, applied offer, dates, scope, terms, prices and extras. Old orders retain their existing snapshots; no historical benefit is fabricated or backfilled.
- A project has its existing payable bill(s) and one `project_final` summary; the summary is never an additional payment target. It is available before payment too. The shared PDF renderer prints the saved agreement for customer/admin/email alike.
- Optional creation keys deduplicate retried admin submissions. An incomplete earlier creation is reported for review rather than automatically creating a second project.
- Installments allocate integer paise and put the remainder in the final installment. Customer/admin previews use the same allocation.

## Validation and deployment

`node --test tests/salesPricing.test.js tests/projectCreateForm.test.js` uses isolated in-memory MongoDB and mocked website/mail boundaries. `TEST_SALES_BROWSER=1` adds the actual website package editor, actual admin project form and client agreement browser flow with fixture authentication and real isolated API/storage. No production clients or payments are created.

Deploy backend before website and portal frontend. Preserve the integration environment variables and use the production website origin there. Do not copy a local database URI or local website URL into deployment configuration. Production rollout and historical migration require their own review; the implementation does not rewrite existing customer orders.
