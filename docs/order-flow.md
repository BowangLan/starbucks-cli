# Member order flow

The endpoint contracts were researched from browser observations and sanitized fixtures; the CLI/client runtime depends only on the credentials saved by `starbucks login` and current website scripts. Checkout review uses live reads and pricing; submission is a separate, explicitly enabled operation. **No order was placed during implementation or verification.** Submission and post-submit lookup were tested with sanitized responses and injected fetch.

## Review checkout and build the submit payload

```sh
bun run build
bun run starbucks login
bun run starbucks store --place 'Palo Alto' --name '3885 El Camino Real' --lat 37.412252 --lng=-122.135089
bun run starbucks cart add --product 1033 --form single
bun run starbucks order payments
bun run starbucks order review
bun run starbucks order build-submit
```

`order review` saves `.starbucks/prepared-order.json` with mode 0600 and prints a redacted review: café, items, payment type/last four, amount, tip, and expiration. It does **not** submit. `order build-submit` obtains fresh device context from current website scripts and constructs the submission envelope in `.starbucks/submit-order-request.json` without calling any order API or printing device/payment secrets. Use `--out` to change either output path. Global `--cart` and `--session` select local state.

`order review` refreshes account, store and in-café pickup availability, store menu, wallet, rewards, and pickup estimate, then obtains a fresh member quote. It stops at the first error. The quote must match the cart and mark every item `PURCHASABLE` and `isAvailable: true`. The captured quote expires after 300 seconds; `expiresIn` is interpreted as seconds and expiry is conservatively measured from the start of the pricing request. Changing cart or fulfillment requires reviewing again.

Payment selection uses the wallet's **MOP** action, not its reload/default fields. `--payment-index N` selects an index from `order payments`; otherwise the wallet must have exactly one MOP default. The successful capture used PayPal. The captured website bundle also maps credit/debit tender names to uppercase and Starbucks Cards to `SVC`, using `paymentInstrumentId` or `cardId` respectively. Stored-value balance checks include the tip; insufficient balance fails without reloading. `--tip` defaults to zero. Non-SVC payment requires the store to report `acceptsNonSvcMop: true`.

## Session-only runtime

`starbucks login` saves `.starbucks/http-fetch-session.json`. This is the only credential input to the CLI/client. There is no capture import command, request-context option, or implicit read of an old header file. Network dumps remain research material and sanitized test fixtures only.

Before a protected operation, the SDK downloads the current vendor/Iovation/Accertify scripts into an ephemeral FetchDOM context using the saved cookie jar. It first observes the vendor fetch hook locally. If that hook emits no proof, it uses the vendor form hook also used by `starbucks login`; FetchDOM intercepts that form locally and never sends it. Proof must contain all six core fields and its bootstrap token must match the freshly downloaded script. The optional `a0` field is retained when generated. Missing proof, timeouts, or bootstrap errors stop before the API request. No imported or cached proof is used as a fallback.

This fresh form-proof path has local synthetic integration coverage and offline vendor-script experiments. On October 1, 2026, the live Palo Alto cart quote succeeded using this path and the current `starbucks login` session. The previous seven-header replay result is not evidence for the current implementation. Live order submission remains untested.

`order build-submit` and explicitly confirmed `order submit` generate Iovation/Accertify risk automatically from the auth session. The `--risk-file` option remains available as a diagnostic override. The CLI uses Node 24.21+ because Bun cannot execute the vendor runtime reliably. SDK applications should call `await client.close()` in `finally` to release their ephemeral context.

Wallet's `REAUTHENTICATION_REQUIRED` means the current session lacks full account authorization: run `starbucks login` again, then `starbucks order payments` to verify wallet access. The observed full-auth cookie lasts 20 minutes, while extended account recognition lasts about 30 days. `auth status` and `auth refresh` can succeed with only profile access and do not establish payment permission. See [session lifetimes and checkout reauthentication](auth-sessions.md). No automatic credential resubmission, order retry, or browser fallback is performed.

## Captured contracts

| Capture request    | Endpoint                                                    | Implementation                                                                                |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `000026`, `000083` | POST `/apiproxy/v1/orchestra/get-user`                      | `user()` verifies member identity.                                                            |
| `000172`           | GET `/apiproxy/v1/ordering/1033/single`                     | `product()` supplies size and modifier SKUs; cart is local.                                   |
| `000244`           | GET `/apiproxy/v1/locations`                                | `stores()` refreshes café availability.                                                       |
| `000343`           | GET `/apiproxy/v1/ordering/menu`                            | `menu(store)` sends short store number, ownership type, timezone.                             |
| `000341`           | POST `/apiproxy/v1/orchestra/get-stored-value-card-list`    | Existing `cards()` read; wallet also includes SVC balances.                                   |
| `000344`           | POST `/apiproxy/v1/orchestra/get-starpay-wallet`            | `wallet(risk?)` sends Web/US/WebApp and optional fresh fingerprint.                           |
| `000374`           | POST `/apiproxy/v1/orchestra/reward-programs`               | `rewardPrograms()` reads reward definitions; this flow applies no rewards.                    |
| `000373`           | GET `/apiproxy/v1/ordering/pre-order-pickup-estimate/17011` | `pickupEstimate(fullStoreNumber)` returns raw estimate values.                                |
| `000372`, `000392` | POST `/apiproxy/v1/orchestra/price-order`                   | `quote(cart)` returns `PricedOrderV2`, cart availability, amount, order ID, expiry.           |
| `000425`           | POST `/apiproxy/v1/orchestra/submit-order`                  | `submitOrder(request, {confirm:true})`; separate transport capability required.               |
| `000426`           | GET `/apiproxy/v1/ordering/pickup-time/{orderId}/17011`     | `orderPickupTime()` / `orderStatus()` after acknowledged submission.                          |
| `000458`           | POST `/apiproxy/v1/orchestra/get-previous-orders`           | `previousOrders(fullStoreNumber, limit=40)` sends `locale: en-US`, short store number, limit. |

The other two application endpoints in the complete dump are `get-favorite-products` (`000080`, `000342`, variables `locale` plus optional short `storeNumber`) and `locations/static-map` (`000456`). They supply optional favorites and a map image; neither is required to prepare, submit, or look up the captured order. All 21 application requests have captured response bodies.

The submission body is:

```json
{
  "variables": {
    "subInp": {
      "orderId": "<fresh quote UUID>",
      "storeNumber": "17011-170949",
      "tenders": [
        { "id": "<selected wallet ID>", "tender": "PAYPAL", "amount": 4.25 }
      ],
      "tipAmount": 0
    },
    "risk": {
      "ccAgentName": "WebApp",
      "platform": "Web",
      "market": "US",
      "deviceFingerprint": "<fresh Iovation fingerprint>",
      "reputation": {
        "deviceFingerprint": "<same fresh Iovation fingerprint>",
        "ubaId": "<current Accertify token>"
      }
    }
  }
}
```

Captured success is `{data:{submitOrder:{__typename:"ServiceTime"}}}`. It contains no new order ID; use the priced order's ID for pickup lookup. Unknown union types, GraphQL errors, malformed responses, and transport failures never count as acceptance. Device-risk construction and tender mapping were also checked against the captured website bundles `000059` and `000061`.

## Explicit submission and status

`order submit --file <prepared-file> --confirm` **places a real order**. It is implemented but was never executed against Starbucks in this work. It checks quote expiry, the signed-in account, and the current wallet payment/balance before making one submission attempt. There is no automatic reprice, retry, card reload, or payment creation. The SDK requires both `new FetchStarbucksClient({allowOrderSubmission:true})` and `submitOrder(request, {confirm:true})`; generic `operation("submit-order")` remains blocked.

The CLI writes a private, exclusive journal at `.starbucks/order-attempts/<orderId>.json` before the request, preventing duplicate attempts from the same workspace, including copied draft files. It saves acceptance before the follow-up status read. A failed status read reports acceptance with status unavailable. If submission times out or cannot be confirmed, retain the order ID and reconcile status/history; do not delete the journal to retry. The SDK prevents repeated attempts for an order ID within a client instance; other SDK applications must persist their own attempt record.

```sh
bun run starbucks order status --id '<order UUID>' --store 17011-170949
bun run starbucks order previous --store 17011-170949 --out .starbucks/previous-orders.json
```

The pickup endpoint supplies a timestamp and wait estimates. It does **not** establish that a drink is ready, collected, or cancelled. A missing/error response is not proof that submission failed. The capture does not establish a separate lifecycle-status API. Previous orders can lag: the captured `000458` response did not yet include the just-submitted order. Existing transaction-history and receipt methods remain available for later reconciliation.

## SDK preparation

```ts
import {
  FetchStarbucksClient,
  FileSessionStore,
  prepareOrder,
  buildSubmissionRequest,
  summarizePreparedOrder,
} from "starbucks-web-sdk";

const client = new FetchStarbucksClient({
  session: new FileSessionStore(".starbucks/http-fetch-session.json"),
});
try {
  const prepared = await prepareOrder(client, cart);
  console.log(summarizePreparedOrder(prepared));
  const risk = await client.orderRisk();
  const request = buildSubmissionRequest(prepared, risk); // no order API call
  // Stop here for pre-submit verification.
} finally {
  await client.close();
}
```

The supported flow is authenticated US member ordering, immediate in-café pickup, one existing MOP wallet tender, and no reward redemption. Guest submission, new payment registration, reload, scheduled pickup, drive-through selection, multi-tender payment, and post-submit tipping were not established by this capture and remain outside this flow.

## Verification

Sanitized contracts are in `tests/fixtures/order-capture.json`. Tests cover the complete prepare → submit → status sequence using mock fetch, strict default submission blocking, local request building, stale/changed/unavailable carts, account/payment handling, insufficient balance including tips, ambiguous outcomes, duplicate attempts, and acceptance persistence when pickup lookup fails.

Earlier live checks passed wallet, pricing, and full preparation using replayed protection headers. That implementation has been removed because it required a network dump. The replacement uses only the auth session and current scripts. It passes local regression tests for fresh context, missing-proof rejection, ignored obsolete context files, preparation, and submission/status mocks. The October 1 live verification also passed wallet, pricing, full review, and local submit-payload construction. No order API was called for submission, and no order was submitted. See [verification status](verification.md).
