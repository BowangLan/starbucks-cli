# Member order flow

Implemented from `network-dump-2026-09-29T02-09-20-076Z/tab-001`. Preparation uses live reads and pricing; submission is a separate, explicitly enabled operation. **No order was placed during implementation or verification.** Submission and post-submit lookup were tested with sanitized captured responses and an injected fetch implementation.

## Prepare without placing an order

```sh
bun run build
bun run starbucks order import-context --capture /path/to/network-dump-capture
bun run starbucks store --place 'Palo Alto' --name '3885 El Camino Real' --lat 37.412252 --lng=-122.135089
bun run starbucks cart add --product 1033 --form single
bun run order:context
bun run starbucks order payments --risk-file .starbucks/order-risk.json
bun run starbucks order prepare --risk-file .starbucks/order-risk.json
bun run starbucks order request --risk-file .starbucks/order-risk.json
```

`order prepare` saves `.starbucks/prepared-order.json` with mode 0600 and prints a redacted review: café, items, payment type/last four, amount, tip, and expiration. It does **not** submit. `order request` constructs the exact submission envelope in `.starbucks/submit-order-request.json` locally, without network calls or printing device/payment secrets. Use `--out` to change either output path. Global `--cart` and `--session` select local state.

Preparation refreshes account, store and in-café pickup availability, store menu, wallet, rewards, and pickup estimate, then obtains a fresh member quote. It stops at the first error. The quote must match the cart and mark every item `PURCHASABLE` and `isAvailable: true`. The captured quote expires after 300 seconds; `expiresIn` is interpreted as seconds and expiry is conservatively measured from the start of the pricing request. Changing cart or fulfillment requires preparing again.

Payment selection uses the wallet's **MOP** action, not its reload/default fields. `--payment-index N` selects an index from `order payments`; otherwise the wallet must have exactly one MOP default. The successful capture used PayPal. The captured website bundle also maps credit/debit tender names to uppercase and Starbucks Cards to `SVC`, using `paymentInstrumentId` or `cardId` respectively. Stored-value balance checks include the tip; insufficient balance fails without reloading. `--tip` defaults to zero. Non-SVC payment requires the store to report `acceptsNonSvcMop: true`.

`bun run order:context` runs the existing FetchDOM implementation with freshly downloaded vendor, Iovation, and Accertify scripts and the selected session cookie jar. It writes fresh risk context privately, without logging tokens. Its network policy excludes all account/order APIs and credential submission. This experimental helper uses the observed Accertify script URL; changes to Starbucks' scripts may require updating it. It needs Node 24.21+ and the development dependencies. Passing `--risk-file` to preparation is optional; submitting/building a submission request requires it. Context generation succeeding does not guarantee API acceptance.

The Iovation/Accertify risk body and the request protection headers are separate requirements. `order import-context --capture <directory>` extracts the seven `x-dq7hy5l1-*` headers from each operation's latest successful captured request. It saves `.starbucks/order-request-context.json` with mode 0600, without copying cookies or sending requests. The CLI loads this file when present; global `--request-context <file>` selects another file. The transport applies headers only to the exact matching pricing or submission route. Captured headers do not enable submission.

The importer supplies observed context; it does not renew that context. Its server-side lifetime is unknown. The current DOM helper does not generate these seven headers. If they expire, a new successful browser capture is needed. Wallet's `REAUTHENTICATION_REQUIRED` error instead means full account authorization expired: sign in again. In the verified session, the full authorization cookie lasted 20 minutes while extended profile access lasted longer. See the [investigation](order-investigation.md).

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

The other two application endpoints in the complete dump are `get-favorite-products` (`000080`, `000342`, variables `locale` plus optional short `storeNumber`) and `locations/static-map` (`000456`). They supply optional favorites and a map image; neither is required to prepare, submit, or look up the captured order. All 21 application requests have captured response bodies. `bun run order:audit-capture <directory>` inventories every request and emits API field paths, header names, cookie names, body hashes, and missing-body checks without response values.

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

`order submit --file <prepared-file> --risk-file <fresh-risk-file> --confirm` **places a real order**. It is implemented but was never executed against Starbucks in this work. It checks quote expiry, the signed-in account, and the current wallet payment/balance before making one submission attempt. There is no automatic reprice, retry, card reload, or payment creation. The SDK requires both `HttpTransport({allowOrderSubmission:true})` and `submitOrder(request, {confirm:true})`; generic `operation("submit-order")` remains blocked.

The CLI writes a private, exclusive journal at `.starbucks/order-attempts/<orderId>.json` before the request, preventing duplicate attempts from the same workspace, including copied draft files. It saves acceptance before the follow-up status read. A failed status read reports acceptance with status unavailable. If submission times out or cannot be confirmed, retain the order ID and reconcile status/history; do not delete the journal to retry. The SDK prevents repeated attempts for an order ID within a client instance; other SDK applications must persist their own attempt record.

```sh
bun run starbucks order status --id '<order UUID>' --store 17011-170949
bun run starbucks order previous --store 17011-170949 --out .starbucks/previous-orders.json
```

The pickup endpoint supplies a timestamp and wait estimates. It does **not** establish that a drink is ready, collected, or cancelled. A missing/error response is not proof that submission failed. The capture does not establish a separate lifecycle-status API. Previous orders can lag: the captured `000458` response did not yet include the just-submitted order. Existing transaction-history and receipt methods remain available for later reconciliation.

## SDK preparation

```ts
import {
  HttpTransport,
  StarbucksClient,
  prepareOrder,
  buildSubmissionRequest,
  summarizePreparedOrder,
  importOrderRequestContext,
} from "starbucks-web-sdk";

const requestContext = await importOrderRequestContext(captureDirectory);
const client = new StarbucksClient(
  new HttpTransport({ cookieJar, requestContext }),
);
const prepared = await prepareOrder(client, cart, { risk });
console.log(summarizePreparedOrder(prepared));
const request = buildSubmissionRequest(prepared, risk); // local only
// Stop here for pre-submit verification.
```

The supported flow is authenticated US member ordering, immediate in-café pickup, one existing MOP wallet tender, and no reward redemption. Guest submission, new payment registration, reload, scheduled pickup, drive-through selection, multi-tender payment, and post-submit tipping were not established by this capture and remain outside this flow.

## Verification

Sanitized contracts are in `tests/fixtures/order-capture.json`. Tests cover the complete prepare → submit → status sequence using mock fetch, strict default submission blocking, local request building, stale/changed/unavailable carts, account/payment handling, insufficient balance including tips, ambiguous outcomes, duplicate attempts, and acceptance persistence when pickup lookup fails.

After diagnosing the initial 403/429 failures, the production probe returned wallet 200 and pricing 200 for the captured croissant cart ($4.25, 300-second quote). The normal Bun CLI then completed preparation for a separate available Grande Caffè Americano at an open Honolulu café ($4.97): account, current store, menu, wallet, rewards, pickup estimate, and pricing all passed. The captured Palo Alto café was closed during this final check, so its availability guard remains enforced. `order request` built the submission envelope locally with zero network requests. No submit-order or post-submit pickup-time request was sent. Evidence and remaining limitations are in the [investigation](order-investigation.md) and [verification status](verification.md).
