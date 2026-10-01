# Verification status

The CLI uses standard fetch for sign-in and all other operations. Order submission is disabled by default; the explicitly enabled path is tested only with mocked fetch. No order was placed during development.

## Local checks

Run `bun run test` to build the SDK/CLI and run the automated tests. Tests cover cart construction, request restrictions, cookie handling, authentication transactions, and session persistence.

These tests use fixtures and synthetic responses. They do not establish live Starbucks API availability.

## Live observations

Observed on September 25, 2026:

- Public menu/product reads and Seattle store selection succeeded. A local Grande Caffè Latte cart with Oatmilk and 3 total shots was built from live product data.
- Imported browser cookies were verified through the production CLI. Account status and Starbucks Card reads succeeded through fetch.
- Pricing returned HTTP 403/429, and wallet access returned 403. A complete fetch preflight has not succeeded.
- The experimental SDK `login()` transaction is mock-tested, but live credential-only login remains unverified. An earlier direct credential submission returned 429.

Session cookies can expire, and these observations are not reliability guarantees. Local cart commands do not synchronize with the website cart. API errors do not trigger automatic retries.

Observed on September 29, 2026 UTC:

- The new `bun run starbucks login` flow generated fresh context using the current page scripts and native Node fetch. Its single credential POST returned 302, OAuth completed, and authenticated `get-user` returned 200. See [fetch login verification](fetch-login.md).
- The resulting session loaded all three transaction-history pages with HTTP 200, returning 114 unique visible entries. A purchase receipt and the empty eGift order list also returned 200. See [history contracts and verification](history.md).
- The missing `src/preflight.ts` module has been restored. The full SDK/CLI build succeeds, and `auth status` verifies the fetch-login session. Regression tests exercise the built CLI's startup and account verification.

## Current session-only implementation

The runtime capture importer, header-file option, and automatic header-file loading have been removed. CLI/client protected requests now use the cookie jar saved by `starbucks login` and scripts fetched from the current website. Device risk is generated automatically; no risk file is required. The CLI runs under Node 24.21+ because Bun cannot execute the vendor runtime reliably.

Local tests cover ignoring obsolete dump-derived files, generating fresh context using synthetic website scripts, Request-object handling, isolating context requests from order APIs, rejecting incomplete proof, and the full order flow with mock submission/status. Offline vendor-script experiments generated the six core form-proof fields; the optional `a0` field was not generated.

Observed October 1, 2026 UTC using the session freshly saved by `starbucks login`:

- The read-only wallet and pricing probe passed. Both APIs returned HTTP 200, and pricing returned a USD 9.70 quote for the saved cart at store `17011-170949` with a 300-second lifetime.
- `order review` passed its account, store/availability, menu, wallet, rewards, pickup-estimate, and pricing checks. It selected the wallet's default PayPal tender and reported a $9.70 total with no tip.
- `order build-submit` generated fresh session context and constructed the submission payload locally. It made zero order API requests. No order was submitted and no post-submit status request was sent.

The previous replay-based HTTP 200 results remain historical and are not the evidence for this session-only result. Submission acceptance and post-submit pickup lookup remain mock-tested only.

## Historical order-flow verification (superseded replay implementation, September 29, 2026 UTC)

- The supplied capture establishes member submission (`submit-order` → `ServiceTime`), pickup lookup, and previous-orders contracts. A sanitized fixture drives the complete SDK and CLI flow offline.
- The full dump audit covered 478 requests, including all 21 application requests across 14 endpoints. All application response bodies were present.
- Wallet's initial 403 reported `user:limited` authorization. Fresh sign-in restored full authorization and wallet returned 200. Profile access alone is insufficient. The SDK now identifies this error as `REAUTHENTICATION_REQUIRED`.
- Pricing initially returned an empty 429. Adding the seven captured request protection headers, scoped to pricing and serialized through `Headers`, produced a valid live quote. The production diagnostic then returned wallet 200 and pricing 200 for the captured $4.25 croissant cart.
- The normal Bun CLI completed live preparation through a $4.97 quote for a separate available Americano cart at an open Honolulu café. The captured Palo Alto café was closed during final verification. The test preserved the user's default cart.
- Fresh Iovation/Accertify risk context was generated, and the actual submission envelope was constructed locally with zero network requests. Device-risk generation does not generate the seven request protection headers; imported protection context has an unknown server-side lifetime.
- No live submit-order or post-submit pickup-time request was sent. Live submission acceptance remains unverified by design.

See the [order-flow guide](order-flow.md) for command usage and the [403/429 investigation](order-investigation.md) for controlled comparisons, evidence, and remaining limits.

## Reproduction

```sh
bun run test
bun run starbucks login
bun run starbucks auth status
bun run starbucks cart show
bun run starbucks cart quote
bun run starbucks cart preflight
```

See the [SDK + CLI reference](reference.md) for setup and command details, and [API contracts](api.md) for request shapes. Sanitized test fixtures remain in `tests/fixtures/`.
