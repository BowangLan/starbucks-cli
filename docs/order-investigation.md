# Wallet 403 and pricing 429 investigation

The initial checkout was failing. Both failures were reproduced independently before changing the implementation. Live verification on September 29, 2026 UTC now passes wallet and pricing, and the production CLI completed preparation through a fresh quote. No order was submitted.

## Complete capture audit

Source: `network-dump-2026-09-29T02-09-20-076Z/tab-001/events.jsonl`, SHA-256 `e5364f8525c664709d5519c8f8ad89f07faf05f511a977d6ea2c9435f5cf56a3`.

- 2,699 events, 478 requests, 317 saved response bodies.
- 21 application requests across 14 unique application endpoints; every application response body is present.
- Account, product, locations, store menu, cards, wallet, rewards, pricing, submit, pickup estimate, post-submit pickup lookup, and previous orders are covered in the [contract table](order-flow.md#captured-contracts).
- Favorites and static-map requests are optional presentation data. Other requests supply documents/assets, maps, consent/analytics, or device context. The two recorded WebSocket connections go to Iovation, not an order-status service.
- Captured bundles `000059` (shared), `000061` (core), and `000367` (cart) establish reauthentication handling, device-risk construction, payment mapping, quote expiry in seconds, submission construction, and pickup lookup. `000047`/`000063` supply the request protection bootstrap/runtime.
- The SDK's croissant pricing body exactly equals captured request `000392`. Both captured pricing requests and submission carry seven protection headers: `x-dq7hy5l1-a`, `-a0`, `-b`, `-c`, `-d`, `-f`, and `-z`. Wallet has none. The captured `-f` value equals the bootstrap initialization token.

Reproduce the inventory without network access:

```sh
bun run order:audit-capture /path/to/network-dump-capture
```

The private report `.starbucks/order-capture-audit.json` contains request IDs, endpoint inventory, all JSON field paths and types, header/cookie names, and body hashes. It omits body and credential values.

## Wallet: full authorization had expired

The 403 body was exactly the authorization failure with `roleProvided: user:limited`, `roleRequired: user`, and `type: authorize-operation`. The session lacked an active `.SbuxA0Auth` cookie while extended cookies still allowed profile reads. Adding a fresh device fingerprint did not fix authorization. The captured website handles this error by offering reauthentication.

Running the existing `bun run auth:fetch` flow restored full authorization. The same wallet request then returned HTTP 200. The observed full-auth cookie lifetime was 20 minutes; extended profile access remained available longer. The SDK now exposes this failure as `StarbucksError.code === "REAUTHENTICATION_REQUIRED"` with an explicit sign-in instruction. Generic 403 responses remain generic errors.

## Pricing: missing request protection and transport serialization

The failing response was HTTP 429 with zero body bytes and no `Retry-After`. The request body matched the successful capture. Matching ordinary browser headers did not fix it. The native SDK was missing all seven vendor protection headers.

Controlled comparisons, each limited to pricing and without submission:

| Context                                                                                | Result                     |
| -------------------------------------------------------------------------------------- | -------------------------- |
| Fresh full authorization, native request, no protection headers                        | 429                        |
| Captured protection/browser headers and captured non-auth cookies, fresh authorization | 200, valid `PricedOrderV2` |
| Same headers, fresh session cookies                                                    | 200                        |
| Only the seven protection headers added to normal SDK headers, fresh cookies           | 200                        |
| Integrated protection headers passed as a plain object with protection fields first    | 429                        |
| Same integrated context passed through a `Headers` object                              | 200                        |

The final transport preserves the verified `Headers` serialization for protected requests. The exact server rule behind the serialization difference is unknown. Header values alone were not enough in the failing integrated test.

The new local importer stores only these seven headers separately for pricing and submission. It does not import account cookies. The transport validates and copies the context, scopes headers to their exact operation, and retains the existing default submission block.

Fresh vendor-script DOM experiments installed fetch/XHR hooks but emitted zero protection headers across absolute/relative fetch, browser-style options, and XHR variants. Debugger inspection exposed missing DOM capabilities; supplying media-query evaluation did not restore header generation. Those experimental shims were not shipped. Generating Iovation/Accertify risk context is therefore not evidence that request protection is ready.

## Final live results

At 06:15 UTC, `bun run order:probe --cart .starbucks/order-flow-test-cart.json` returned wallet 200 and pricing 200: one Butter Croissant, $4.25, `expiresIn: 300`. The report has `checksPassed: true` and `orderSubmitted: false`.

The original café `17011-170949` was closed (`NOT_READY`, in-café pickup unavailable). A separate verification cart used an available Grande Caffè Americano at open café `26926-246085` in Honolulu. The normal `bun run starbucks ... order prepare` command completed at 06:15 UTC with a $4.97 quote. This exercised current account, store, menu, wallet, rewards, pickup estimate, and pricing. `order request` then constructed its submission envelope locally with `networkRequests: 0`.

Private evidence: `.starbucks/order-probe.json` (failing baseline), `.starbucks/order-probe-fixed.json` (passing final probe), `.starbucks/order-flow-final-verification.json`, and the clearly marked `.starbucks/order-debug/` diagnostic directory. Test carts are separate from `.starbucks/http-cart.json`.

Captured protection context may expire or be invalidated; automatic generation/renewal is not implemented. Full authorization must also remain valid. The probe stops on the first failure, exits nonzero, and persists a cooldown on 429. Submission acceptance and post-submit status remain tested with mocks only, as requested. No live submission was sent, and no real order was placed.
