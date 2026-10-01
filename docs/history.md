Account history and receipts work with the session produced by `bun run starbucks login`. The history command uses native Node fetch, the saved cookie jar, and the SDK's read endpoints.

```sh
# Load every available page, saving the full result with mode 0600.
bun run starbucks history --all --output .starbucks/order-history.json

# Fetch one page; omit --output to print its JSON.
bun run starbucks history --offset 0 --limit 50

# Fetch a receipt using a historyId from the returned historyItems.
bun run starbucks history --receipt '<history-id>' --output .starbucks/order-receipt.json

# Related eGift reads.
bun run starbucks history --gifts --output .starbucks/egift-order-history.json
bun run starbucks history --gift-order '<order-id>' --output .starbucks/egift-order.json
```

The default session is `.starbucks/http-fetch-session.json`; override with `--session <file>`. Session-cookie updates are retained. No credential submission occurs during these reads. API failures stop the command without retries.

The capture `network-dump-2026-09-29T01-19-58-932Z` contains request `000057`, a successful POST to `/apiproxy/v1/orchestra/get-transaction-history`:

```json
{ "variables": { "offset": 0, "limit": 50 } }
```

Its response is `data.transactionHistoryV2`, containing `paging` and `historyItems`. The browser's account-history bundle, `000046.response.bin`, specifies the receipt and eGift operations below. Those three requests are code-derived contracts, not additional network requests present in the capture.

| Read                | Method and path                                         | Request body                            | SDK method                            |
| ------------------- | ------------------------------------------------------- | --------------------------------------- | ------------------------------------- |
| History page        | POST `/apiproxy/v1/orchestra/get-transaction-history`   | `{"variables":{"offset":0,"limit":50}}` | `transactionHistory({offset, limit})` |
| Receipt             | POST `/apiproxy/v1/orchestra/get-history-item-receipt`  | `{"variables":{"historyId":"..."}}`     | `historyReceipt(historyId)`           |
| eGift order list    | GET `/apiproxy/v1/account/history/egift/order-list`     | None                                    | `giftOrderHistory()`                  |
| eGift order details | POST `/apiproxy/v1/account/history/egift/order-details` | `{"orderId":"..."}`                     | `giftOrderDetails(orderId)`           |

The history and receipt requests use the normal Orchestra JSON wrapper. eGift details use a plain `orderId` body instead. The observed history request includes `Accept: application/json`, `Content-Type: application/json`, `X-Requested-With: XMLHttpRequest`, the Starbucks origin, and `/account/history` as referer. Authentication uses cookies from the saved session. This history request does not contain a device fingerprint or a risk-input object.

Pagination must use `paging.offset + paging.returned`. In the capture, `returned` is 50 but `historyItems.length` is 48. Advancing by visible item count would fetch the wrong next range. `transactionHistoryPages()` follows the browser's calculation and rejects a non-advancing page when more results remain.

```ts
const page = await client.transactionHistory({ offset: 0, limit: 50 });
for await (const page of client.transactionHistoryPages()) {
  // page.historyItems includes purchases, redemptions, reloads, and points activity.
}
const activity = await client.historyReceipt(historyId);
// activity.receipt includes purchasedItems, totals, tax, and receiptLines.
```

Live verification on 2026-09-29 reused the successful fetch-login session:

- History offsets 0, 50, and 100 all returned HTTP 200. Their consumed counts were 50, 50, and 21; the server reported a total of 121. The API delivered 114 unique visible entries. The reason some consumed records are omitted from `historyItems` is not exposed by the response.
- The 114 entries comprise 30 purchases, 44 redemptions, 17 reloads, and 23 points entries. Raw values and identifiers are preserved in `.starbucks/order-history.json`.
- A receipt for an eligible purchase returned HTTP 200 and is saved in `.starbucks/latest-order-receipt.json`.
- The eGift list returned HTTP 200 with zero orders. eGift details are implemented and fixture-tested, but not live-tested because no owned eGift order ID was available.

The bundle shows receipts for `Transaction` or `TransactionWithPoints` entries whose transaction type is `Purchase` or `Redemption`. Use an ID returned by your own history. Monetary values remain in their original API representation; no currency units are inferred.

Run `bun run test:history` for the request-shape, pagination, response-validation, and endpoint-boundary regression tests. Run `bun run check` for the full build, lint, formatting, and test suite.
