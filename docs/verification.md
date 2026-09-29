# Verification status

The CLI uses a visible browser for manual sign-in and standard fetch for all other operations. Order submission is disabled.

## Local checks

Run `bun run test` to build the SDK/CLI and run the automated tests. Tests cover cart construction, request restrictions, cookie handling, authentication transactions, and browser-login lifecycle behavior, including failed verification, timeout, cancellation, and manual window closure.

These tests use fixtures and synthetic responses. They do not establish live Starbucks API availability.

## Live observations

Observed on September 25, 2026:

- Public menu/product reads and Seattle store selection succeeded. A local Grande Caffè Latte cart with Oatmilk and 3 total shots was built from live product data.
- Imported browser cookies were verified through the production CLI. Account status and Starbucks Card reads succeeded through fetch.
- Pricing returned HTTP 403/429, and wallet access returned 403. A complete fetch preflight has not succeeded.
- The experimental SDK `login()` transaction is mock-tested, but live credential-only login remains unverified. An earlier direct credential submission returned 429.
- Manual browser login follows the observed signed-in redirect and account verification flow. Its lifecycle was additionally checked in Chromium with intercepted synthetic responses.

Successful browser login does not guarantee that subsequent fetch operations will be accepted. Session cookies can expire, and these observations are not reliability guarantees. Local cart commands do not synchronize with the website cart. API errors do not trigger automatic retries or browser fallback.

Observed on September 29, 2026 UTC:

- The new `bun run auth:fetch` flow generated fresh context using the current page scripts and native Node fetch. Its single credential POST returned 302, OAuth completed, and authenticated `get-user` returned 200. See [fetch login verification](fetch-login.md).
- The resulting session loaded all three transaction-history pages with HTTP 200, returning 114 unique visible entries. A purchase receipt and the empty eGift order list also returned 200. See [history contracts and verification](history.md).
- The missing `src/preflight.ts` module has been restored. The full SDK/CLI build succeeds, and `auth status` verifies the fetch-login session. Regression tests exercise the built CLI's startup and account verification.

## Reproduction

```sh
bun run test
bun run starbucks auth login
bun run starbucks auth status
bun run starbucks cart show
bun run starbucks cart quote
bun run starbucks cart preflight
```

See the [SDK + CLI reference](reference.md) for setup and command details, and [API contracts](api.md) for request shapes. Sanitized test fixtures remain in `tests/fixtures/`.
