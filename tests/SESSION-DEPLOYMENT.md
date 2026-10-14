# Session verification handoff

## Evidence and limits

- A production browser received a fresh signin cookie, then sent the same token to
  `/api/user-details`, which answered `Invalid token. Please login again.`
- Read-only inspection of the affected local Firefox Developer Edition profile
  confirmed both `.merasoftware.com` and `api.merasoftware.com` token cookies at `/`.
  Actual API checks returned 200 for the shared cookie alone, 401 invalid-token for
  the host-only cookie alone, and 401 when the host-only cookie preceded the shared
  cookie. Token values were never printed or persisted by the diagnostic. This
  confirms legacy-cookie shadowing in the affected profile; a global signing-key
  mismatch is not supported by these results.
- Both owner-provided test accounts passed live Firefox login/logout and A/B/A/B
  switching in a clean profile. A seeded legacy API host-only cookie reproduced
  signin success followed by invalid-token 401; logout left that cookie behind.
  The affected-profile check above connects that reproduction to the actual incident.
- The live portal has independently reproduced stale-response logout and stale-role
  routing failures. Existing local frontend changes address those failures.

## Prepared backend change

All four token issuers and auth middleware use `helpers/sessionToken.js` for HS256,
the existing exact `TOKEN_SECRET_KEY` bytes, 365-day expiry and shared cookie options.
Startup rejects missing/blank signing configuration. Verification logs a closed-list
reason only; it never logs the token, claims or signing key.
Signin and logout also expire the legacy API host-only cookie when shared-domain
cookies are configured, preventing the two scopes from coexisting after login.

Run `node --test tests/sessionToken.test.js`. Tests use synthetic accounts, a local
HTTP server and mocked model methods; no database or production credentials are used.

## Production checks before declaring the incident resolved

1. Deploy the reviewed cookie migration to the actual backend service for
   `api.merasoftware.com`. Preserve the existing signing key. Record the deployed
   commit and retain the previous deploy as the rollback reference.
2. When the prepared change is deployed, inspect `Session token rejected:` logs.
   `invalid_signature` indicates wrong key bytes or altered token; `expired`,
   `not_active`, `malformed` and `invalid_algorithm` require different corrections.
3. Confirm runtime cookie domain is `.merasoftware.com` and path is `/`.
4. Deploy only reviewed frontend session changes, preserving unrelated portfolio work.
5. In Firefox test fresh login, portal entry, logout, account switch (including
   admin to customer), portal entry and refresh. Verify the newly issued cookie is
   the one sent and user-details returns the correct account with HTTP 200.

Local refactoring alone does not correct divergent production secrets or routing.
