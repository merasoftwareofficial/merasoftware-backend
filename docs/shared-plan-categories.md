# Shared main categories for plans — 30 October 2026

## Behaviour

New plan editors in the portal and website choose an active main project category directly. Creating a category uses the project-category validation/storage, preserves the plan draft and selects the newly saved category. Portal Project Categories and plan creation share `ProjectCategoryDialog` / `ProjectCategoryForm`; the website has its own equivalent dialog because the apps have separate builds. New categories default to admin-only, unpriced. Creating a plan in a category does not change project-order eligibility or restrict a plan's purchase eligibility.

New plans store the permanent key in `servicePlan.categoryKey` and the explicit relationship in `servicePlan.projectCategoryKey`. The latter distinguishes new main-category assignments from historical independent plan categories that happen to have the same key. No extra plan-category row is created. New assignments require active main categories; an edit may retain its existing archived assignment.

`helpers/planProjectCategories.js` is the shared read adapter for admin and public catalogues. Explicit old links map to main keys and current labels. Unlinked old categories remain separate; key/name similarity never infers a relationship. A legacy/main key collision is represented as `legacy:<key>` in catalogue responses until explicitly mapped. That display key is not written to products. The admin mapping panel can explicitly link unlinked legacy categories with revision checks. A subsequent normal plan edit may persist its selected main assignment. Existing product/order data is not bulk rewritten. Unknown or archived historical groups continue to fall back to the existing More plans handling; plan sale eligibility is unchanged.

Both portal customer discovery and website public plan pages receive the same main-category grouping. Main-category usage includes assigned plans and explicitly linked old plans. Shared category name checks reject a duplicate existing label, in addition to the existing unique permanent-key enforcement. Concurrent creates using the same key have one winner.

## API and deployment

Admin plan catalogue returns `categories` (main categories plus unmapped legacy compatibility groups), full `projectCategories`, and `legacyCategories` for explicit mapping. Website category creation proxies `{ target: "category", action: "save_project_category", creating: true, ...mainCategoryFields }` through the existing plan endpoint. The backend checks the current active admin, then delegates to `saveProjectCategory`. Portal category creation continues to use the existing main-category API.

Deploy backend first, then portal and website together. Existing on-sale plans, prices, quotes and purchased snapshots are retained. No production data changes or bulk migration were run. Backups: `E:/Allprojects/backup/<repo>/shared-plan-categories-20261030`, including SHA-256 manifests.

## Verification

84 isolated backend tests pass:

    node --test tests/planCatalogue.test.js tests/planCategories.test.js tests/projectCategories.test.js tests/servicePlanPricing.test.js tests/customerPlanCatalogue.test.js tests/planCheckoutPortal.test.js tests/flexiblePlansPhase1.test.js tests/flexiblePlansAudit.test.js tests/servicePlansP1.test.js

Real portal and website editors bundled in a browser against real controllers and disposable Mongo pass:

    cd ../frontend
    node tests/shared-plan-categories.browser.cjs

Covers existing main selection, cancel without writes, new shared category, automatic selection, draft preservation, no accidental parent-plan submission and successful main-linked plan save. Backend tests also cover legacy read mapping without database rewrites, key collision separation, archived assignments, role checks, duplicates/concurrent creation and plan usage. Fixture CSS is stubbed, so these are interaction checks rather than screenshot/layout checks.

Targeted ESLint and website TypeScript checks are run separately. Older generated Next route types referenced a deleted campaign route; regenerating types for both configured build directories resolves that stale generated reference.
