# Observed Starbucks web contracts

For the current command-by-command and SDK-method mapping, see the **[SDK + CLI reference](reference.md)**. This page also includes historical endpoints observed during browser development; observation does not imply runtime support.

Captured from the real website on 2026-09-25. The SDK is implemented by hand; no inferred OpenAPI or external reverse-engineering tool is used.

| Operation | Observed request | Response / behavior |
|---|---|---|
| Sign-in bootstrap | `POST /apiproxy/v1/account/a0/signin?returnUrl=...` | Redirect information for the hosted login |
| Consumer sign-in | Form POST on `https://auth.starbucks.com/u/login` | Hosted form followed by `/authorize/resume` and `/apiproxy/v1/oauth-callback`; SDK transaction and limitations are documented in the reference |
| Stores | `GET /apiproxy/v1/locations?place=Seattle&lat=47.6061389&lng=-122.3328481` | Array of `{distance, store}` records; store has both an ID and full `storeNumber` |
| Menu | `GET /apiproxy/v1/ordering/menu` | `{menus: [...]}` with recursive categories |
| Store menu | Same endpoint, with `storeNumber=114`, `ownershipTypeCode=CO`, `timeZone=GMT-07:00 America/Los_Angeles` | Availability at the selected store |
| Product | `GET /apiproxy/v1/ordering/407/hot` | `{products: [...]}` with size SKUs, default recipes, nested modifier categories |
| Pickup estimate | `GET /apiproxy/v1/ordering/pre-order-pickup-estimate/114` | Current pickup estimate; observed but not exposed as a dedicated SDK method |
| Consumer account | `POST /apiproxy/v1/orchestra/get-user` with `{variables:{}}` | `data.user`, including consumer `exId`; presence is checked for authenticated status |
| Starbucks Cards | `POST /apiproxy/v1/orchestra/get-stored-value-card-list` with `{variables:{}}` | `data.user.storedValueCardList` |
| Wallet | `POST /apiproxy/v1/orchestra/get-starpay-wallet` | `data.starPayWallet`; tested with `starPayWalletInput.riskInput` containing platform `Web`, market `US`, and ccAgentName `WebApp`, without a deviceFingerprint |
| Member pricing | `POST /apiproxy/v1/orchestra/price-order` | `data.priceOrder`, with line items, tax, total, currency and expiration |
| Guest pricing | `POST /apiproxy/v1/orchestra/price-order-guest` | Same pricing envelope; tested in the initial guest browser session |

Starbucks orchestrator endpoints accept an operation-specific `{variables: ...}` envelope. They are not a general public GraphQL endpoint in this implementation. The SDK never sends arbitrary queries or mutations.

The browser's pricing request for the test drink was:

```json
{
  "variables": {
    "order": {
      "cart": {
        "items": [{
          "quantity": 1,
          "commerce": {"sku": "42"},
          "childItems": [
            {"quantity": 3, "commerce": {"sku": "55"}},
            {"quantity": 1, "commerce": {"sku": "11112911"}}
          ],
          "key": "407/hot:Grande::82(3)(a)::2122556(1)(a)-0"
        }],
        "offers": []
      },
      "fulfillment": {
        "consumptionType": "CONSUME_OUT_OF_STORE",
        "collectionType": "IN_STORE"
      },
      "storeNumber": "114-101752",
      "enableTransparentPricing": true,
      "enableNextGenLoyalty": true
    }
  }
}
```

The builder derives those SKUs from the live product response; they are not hardcoded into the implementation. `42` is this product's Grande SKU, `55` its espresso-shot modifier, and `11112911` oatmilk. Default milk/shots are omitted from overrides. The 3-shot modifier specifies the total shot count, not “three extra shots.”

The menu/estimate uses short store number `114`; the quote uses full store number `114-101752`. The location ID is a different identifier. The SDK preserves this distinction.

Adding/customizing an item did not produce a server cart-write call. Starbucks persists the cart in IndexedDB: database `keyval-store`, store `keyval`, key `ordering`. The JSON envelope contains `data.cart.current`, `data.selectedStore`, and other state. Product configuration is also reflected in `__cart__-407/hot` local storage. That storage was evidence used during development. The SDK keeps its own local Cart value; CLI add/decrease/store modify a private JSON file. No runtime IndexedDB access or UI automation is used.

Quote responses can include `orderId` and `expiresIn: 300`. The ID identifies a priced order/preparation result; receiving it is not evidence that an order was submitted. The UI still requires Checkout → Choose payment → a later confirmation. The fetch-only SDK stops at read/quote operations and has no submission method or payment chooser.

Direct account/price requests outside the active browser encountered HTTP 429; some website requests returned transient 500/502/503. Consumer session expiration also redirected the development browser back to login. These are historical discovery observations, not evidence of fetch-only authentication success. The runtime uses direct fetch with an RFC cookie jar and endpoint allowlisting. API calls reject redirects; the separate login function follows allowlisted authentication redirects and verifies states. There are no automatic retries or browser fallbacks. Fresh browser-cookie import now verified account and Card reads through fetch; pricing returned 403/429 and wallet 403. The credential login transaction is implemented and mock-tested, but browser fingerprint/protection generation is absent and live credential-only success remains unverified. See [current verification](verification.md).
