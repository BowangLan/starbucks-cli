# SDK, CLI, and Starbucks API reference

This documents the fetch-based SDK and manual browser login. Source: [CLI](../src/cli.ts), [client/transport](../src/client.ts), [cart helpers](../src/cart.ts), [types](../src/types.ts), and [endpoint allowlist](../src/safety.ts).

API endpoint paths below use **`https://www.starbucks.com`**. Login also uses **`https://auth.starbucks.com`**. API operations use standard `fetch`. Explicit `auth login` uses Playwright; failed API calls do not launch it.

**Verification:** public reads, imported-session account verification, and Card retrieval worked through production fetch. The new [fetch login runner](fetch-login.md) also completed credential login with fresh context, and its session loaded [history and receipts](history.md). Pricing previously returned 403/429; wallet returned 403. The low-level `login()` helper alone does not generate browser context. See [verification evidence](verification.md).

## CLI command → SDK → Starbucks API

Run commands with `bun run starbucks <command>`. Angle brackets indicate required values; square brackets indicate optional arguments.

| CLI command                                                                       | SDK calls                                | Starbucks HTTP request                                                                                                                   | Local behavior / output                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stores --place <place> [--lat <n> --lng <n>]`                                    | `stores(place, coordinates?)`            | `GET /apiproxy/v1/locations?place=…&lat=…&lng=…`                                                                                         | Prints store number, name, address, distance, open status, and mobile-ordering status. Both coordinates must be supplied together or omitted.                                              |
| `menu [--search <term>]`                                                          | `menu()` or `searchMenu(term)`           | `GET /apiproxy/v1/ordering/menu`                                                                                                         | Full menu, or locally filtered products. Search does **not** use a search endpoint.                                                                                                        |
| `product <id> [--form <form>] [--options]`                                        | `product(id, form)`                      | `GET /apiproxy/v1/ordering/{id}/{form}`                                                                                                  | Prints one product; `--options` projects its sizes and nested customization choices. Form defaults to `hot`.                                                                               |
| `auth status`                                                                     | `user()`                                 | `POST /apiproxy/v1/orchestra/get-user`                                                                                                   | Reads HTTP session file; requires nonempty `data.user.exId`. Prints `{authenticated:true, session}` only on success; otherwise exits with an error.                                        |
| `whoami`                                                                          | `user()`                                 | `POST /apiproxy/v1/orchestra/get-user`                                                                                                   | Prints the signed-in user profile (`data.user`) as JSON. Uses the default session or `--session <file>`; fails if the account is not authenticated.                                        |
| `auth import --file <file>`                                                       | `importCookieJar()` → `user()`           | `POST /apiproxy/v1/orchestra/get-user`                                                                                                   | Accepts serialized `tough-cookie` JSON, storage-state objects, or cookie arrays. Verifies consumer authentication before saving the jar to `--session`. Does not perform login.            |
| `auth login [--timeout <seconds>]`                                                | `loginWithBrowser(options)`              | Browser sign-in → authorization → login form → callback → signed-in page → `get-user`                                                    | User types credentials in visible Chromium. Saves cookies and closes browser after account verification. Default timeout 300 seconds; cancellation/failure preserves existing session.     |
| `cards`                                                                           | `cards()`                                | `POST /apiproxy/v1/orchestra/get-stored-value-card-list`                                                                                 | Prints nickname, last four digits, primary flag, and balance; omits full card number.                                                                                                      |
| `wallet`                                                                          | `wallet()`                               | `POST /apiproxy/v1/orchestra/get-starpay-wallet`                                                                                         | Prints payment type, last four digits, default/status, and stored-value-card count. Does not select a payment instrument.                                                                  |
| `store --place <place> --name <name> --lat <n> --lng <n>`                         | `stores(place, coordinates)`             | `GET /apiproxy/v1/locations?place=…&lat=…&lng=…`                                                                                         | Case-insensitive exact name match; requires `mobileOrdering.availability === "READY"`. Saves full store number in local cart. No store-selection API write.                                |
| `cart show`                                                                       | Local file read / `createCart()`         | **None**                                                                                                                                 | Prints the local cart. Missing file yields an empty cart with no store selected.                                                                                                           |
| `cart add --product <id> [customization flags]`                                   | `product()`, `createItem()`, `addItem()` | `GET /apiproxy/v1/ordering/{id}/{form}`                                                                                                  | Fetches product configuration, then adds/merges an item in local cart. No server cart-add API.                                                                                             |
| `cart decrease <index>`                                                           | `decreaseItem(cart, index)`              | **None**                                                                                                                                 | Zero-based index; subtracts one and removes the item when quantity reaches zero. Saves local cart.                                                                                         |
| `cart build --product <id> --store <number> [customization flags] [--out <file>]` | `product()`, `createItem()`, `toOrder()` | `GET /apiproxy/v1/ordering/{id}/{form}`                                                                                                  | Creates and validates a separate single-item draft. Default output `.starbucks/draft-cart.json`; does not update `--cart` unless explicitly given the same output path.                    |
| `cart quote [--file <file>] [--guest]`                                            | `quote(cart, mode)`                      | Member: `POST /apiproxy/v1/orchestra/price-order`; guest: `POST /apiproxy/v1/orchestra/price-order-guest`                                | Reads `--file` or current local cart. Prints quote and writes `.starbucks/latest-quote.json`. Both modes use the HTTP session file.                                                        |
| `cart preflight`                                                                  | `user()` → `quote(cart)` → `wallet()`    | Sequential POSTs: `/apiproxy/v1/orchestra/get-user` → `/apiproxy/v1/orchestra/price-order` → `/apiproxy/v1/orchestra/get-starpay-wallet` | Stops on first failure. Returns `checks`, `checksPassed`, and `orderSubmitted:false`; later checks are marked skipped. Does not verify final checkout acceptance or open a payment screen. |
| `order`                                                                           | None                                     | **None**                                                                                                                                 | Deliberately disabled; always exits with an error before network access.                                                                                                                   |
| `help [command]`, `--help`, `--version`                                           | None                                     | **None**                                                                                                                                 | Commander-generated usage/version output.                                                                                                                                                  |

### Global options and local files

Put global options before the command:

```sh
bun run starbucks --session .starbucks/my-http-session.json --cart .starbucks/my-cart.json cart quote
```

| Option             | Default                              | Used by                                                                                                              |
| ------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `--session <file>` | `.starbucks/http-fetch-session.json` | `auth status/import/login`, `whoami`, `cards`, `wallet`, `cart quote/preflight`. Public reads do not load this file. |
| `--cart <file>`    | `.starbucks/http-cart.json`          | `store`, `cart show/add/decrease/preflight`, and `cart quote` without `--file`.                                      |
| `-h, --help`       | —                                    | Displays help.                                                                                                       |
| `-V, --version`    | —                                    | Displays package CLI version.                                                                                        |

Session cookies, including response `Set-Cookie` updates, are saved after session-backed commands, even when the request fails. `auth import` and `auth login` only replace the destination after successful verification. Session/cart JSON writes are atomic with file mode 0600. Saved session files are HTTP cookie jars; storage-state imports are converted locally.

### Cart customization flags

These flags apply to **both** `cart add` and `cart build`:

| Flag                 | Default         | Behavior                                                                                                    |
| -------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `--product <id>`     | Required        | Positive integer product number, such as `407`.                                                             |
| `--form <form>`      | `hot`           | Alphabetic product form, lowercased for the URL.                                                            |
| `--size <size>`      | `Grande`        | Matches the product's size code case-insensitively.                                                         |
| `--milk <milk>`      | Product default | Matches a supported milk option case-insensitively, e.g. `Oatmilk`. Default milk is omitted from overrides. |
| `--shots <count>`    | Product default | Integer 1–12; **total shots**, not extra shots. Default shot count is omitted from overrides.               |
| `--quantity <count>` | `1`             | Integer 1–20. Merging identical items must keep the resulting quantity at most 20.                          |

`cart build` additionally requires `--store <full-number>` (e.g. `114-101752`) and accepts `--out <file>`. `cart add` uses the store already in the local cart; it can also add before store selection, but pricing requires a full store number. Neither command customizes arbitrary syrups, toppings, rewards, or delivery.

## SDK methods

Import from the package root (or `./dist/index.js` inside this checkout). The complete exports are [src/index.ts](../src/index.ts).

### Authentication functions

`loginWithBrowser(options?: BrowserLoginOptions): Promise<CookieJar>` is exported separately from `starbucks-web-sdk/login` ([source](../src/browser-login.ts)). It opens visible Chromium, waits for the redirect to `www.starbucks.com/rewards/my-rewards`, verifies `get-user` inside that browser, converts cookies to a fetch-compatible jar, optionally saves it, and closes the browser. It does not read or fill credentials and does not capture requests or screenshots.

Options: `sessionFile` (optional atomic mode-0600 save), `timeoutMs` (300000), `signal` (AbortSignal), and `launch` (optional custom browser launcher for embedding/testing). Timeout, window closure, account verification failure, and cancellation close the browser without replacing a saved session. Browser installation: `bunx playwright install chromium`.

The CLI uses this manual flow. Browser login establishes browser authentication; later fetch API access may still be rejected independently.

#### Experimental fetch-only login

Source: [src/auth.ts](../src/auth.ts). These are exported standalone functions.

| Function / type                                                | Behavior                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login(credentials: LoginCredentials, options?: LoginOptions)` | Returns `Promise<StarbucksClient>` only after the flow below and successful `get-user`. No automatic retry, script execution, fingerprint generation, or browser fallback.                                                                      |
| `LoginCredentials`                                             | Required `username` and `password` strings. SDK takes explicit values; the CLI does not use this function or read environment credentials.                                                                                                      |
| `LoginOptions`                                                 | `cookieJar`, injectable `fetch`, `timeoutMs` (25000), and `staySignedIn` (true). SDK callers may supply an existing jar.                                                                                                                        |
| `importCookieJar(input: unknown)`                              | Returns `Promise<CookieJar>`. Accepts a serialized jar, storage-state `{cookies: [...]}`, or cookie array. Browser-style imports preserve domain/host-only/path/expiry/security attributes and exclude non-Starbucks domains. No network calls. |

Login requests:

1. `GET www.starbucks.com/account/signin?ReturnUrl=%2F`.
2. Empty `POST www.starbucks.com/apiproxy/v1/account/a0/signin?returnUrl=%2F` with JSON content type. Response is a JSON string containing the authorization URL.
3. `GET auth.starbucks.com/authorize?...` using the returned state and PKCE challenge. The implementation does not append the browser-generated `x-fp` value.
4. Follow the server redirect to `GET auth.starbucks.com/u/login?state=...`. Parse server hidden fields with an HTML parser; verify hidden state matches the URL.
5. Form-encoded `POST` to that exact login URL with fresh hidden fields, `username`, `password`, and (by default) `ulp-stay-signed-in=on`. Does not synthesize `ulp-fp-part-*`, Accertify, Datadog, or dynamic vendor fields.
6. Follow allowlisted redirects through `/authorize/resume` and `www.starbucks.com/apiproxy/v1/oauth-callback?code=...&state=...`; callback state must equal the original authorization state.
7. Reach the Starbucks post-sign-in page and verify `POST /apiproxy/v1/orchestra/get-user`.

Cookies are processed on every response and scoped to each destination. Redirects never forward the credential body. Unexpected destinations, form/state changes, unsupported challenges, HTTP errors, and redirect limits terminate the flow. A returned login form does not trigger another credential submission. The experimental function does not write session files.

**Limitation:** this implements the HTTP transaction, not browser fingerprint/protection generation. Mock tests verify orchestration, not acceptance by Starbucks. The working imported-session path is not credential-only login.

### `StarbucksClient`

`new StarbucksClient(transport?: Transport)` defaults to `new HttpTransport()` with an empty cookie jar. `client.transport` is readable. The client itself does not read `.env`, session files, or cart files.

| Method                                                          | Return                             | Endpoint / behavior                                                                                                                                                               |
| --------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `menu(store?: Store)`                                           | `Promise<Menu>`                    | `GET /apiproxy/v1/ordering/menu`. With a Store, adds short `storeNumber`, `ownershipTypeCode`, and optional `timeZone`. CLI `menu` currently does not expose this store argument. |
| `searchMenu(term: string, store?: Store)`                       | `Promise<MenuProduct[]>`           | Calls `menu(store)`; recursively filters names case-insensitively and deduplicates by product number/form. No extra HTTP call.                                                    |
| `product(id: number, form = "hot")`                             | `Promise<Product>`                 | `GET /apiproxy/v1/ordering/{id}/{lowercase-form}`. Selects matching product from `products`; checks sizes/options exist.                                                          |
| `stores(place: string, coordinates?: {lat:number; lng:number})` | `Promise<StoreLocation[]>`         | `GET /apiproxy/v1/locations` with `place` and optional coordinates. Validates coordinate ranges.                                                                                  |
| `user()`                                                        | `Promise<Record<string, unknown>>` | POST `get-user`; returns `data.user` only when its consumer `exId` is present.                                                                                                    |
| `cards()`                                                       | `Promise<unknown>`                 | POST `get-stored-value-card-list`; returns `data.user.storedValueCardList`. Unlike CLI output, SDK data is not masked.                                                            |
| `wallet()`                                                      | `Promise<Record<string, unknown>>` | POST `get-starpay-wallet`; returns `data.starPayWallet`. Unlike CLI output, SDK data is not masked.                                                                               |
| `quote(cart: Cart, mode: "member" \| "guest" = "member")`       | `Promise<PriceQuote>`              | POST `price-order` or `price-order-guest`; builds body with `toOrder(cart)`. Requires returned `summary.price` to be numeric.                                                     |
| `operation(name: string, variables: unknown = {})`              | `Promise<Record<string, unknown>>` | POST `/apiproxy/v1/orchestra/{name}` with `{variables}`; returns `data`. Only operation names below are allowed. This is not an arbitrary GraphQL mutation interface.             |

All operation names in the last five rows use prefix `/apiproxy/v1/orchestra/`.

### Request bodies and response selection

Account and Card requests:

```json
{ "variables": {} }
```

Wallet request:

```json
{
  "variables": {
    "starPayWalletInput": {
      "riskInput": {
        "platform": "Web",
        "market": "US",
        "ccAgentName": "WebApp"
      }
    }
  }
}
```

Member/guest quote requests:

```ts
{
  variables: {
    order: toOrder(cart);
  }
}
```

The exact captured latte payload is in [latte-price-request.json](../tests/fixtures/latte-price-request.json), with an explanation in [API contracts](api.md). Quote payloads contain the full store number, base SKU, quantity, modifier SKUs/quantities, empty offers, in-store pickup, and transparent-pricing/loyalty flags. A quote can include an `orderId`; it is not proof of order submission.

### Generic operation allowlist

Each entry is a **POST** to `/apiproxy/v1/orchestra/{name}` through `operation(name, variables)`. Having an allowlisted name is not a claim that its full variable/response contract or authenticated HTTP replay has been verified.

| Name                         | Dedicated SDK wrapper        | Dedicated CLI command                             |
| ---------------------------- | ---------------------------- | ------------------------------------------------- |
| `get-user`                   | `user()`                     | `whoami`, `auth status/import`; part of preflight |
| `get-stored-value-card-list` | `cards()`                    | `cards`                                           |
| `get-starpay-wallet`         | `wallet()`                   | `wallet`; part of preflight                       |
| `price-order`                | `quote(cart)`                | `cart quote`; part of preflight                   |
| `price-order-guest`          | `quote(cart, "guest")`       | `cart quote --guest`                              |
| `get-user-mfa-factors`       | None; generic operation only | None                                              |
| `get-privacy-permissions`    | None; generic operation only | None                                              |
| `get-favorite-products`      | None; generic operation only | None                                              |
| `get-terms-acknowledgement`  | None; generic operation only | None                                              |
| `reward-programs`            | None; generic operation only | None                                              |

### `HttpTransport`

```ts
new HttpTransport({
  cookieJar, // optional tough-cookie CookieJar; defaults to empty
  fetch: customFetch, // optional; defaults to globalThis.fetch
  timeoutMs: 25000, // optional; default 25 seconds
});
```

- `request(path: string, body?: unknown): Promise<unknown>`: GET when body is `undefined`; otherwise POST with JSON serialization. Paths are restricted to the Starbucks origin and the allowlist.
- `cookieJar`: readable jar; handles domain/path/expiry and retains `Set-Cookie` responses. SDK callers persist it themselves if needed.
- Common headers: `accept: application/json`, `x-requested-with: XMLHttpRequest`, and matching cookies when available. POST additionally sets `content-type: application/json`, Starbucks `origin`, and `/menu/cart` referer.
- Redirects are rejected. There are no automatic retries or browser fallbacks.
- In addition to the named client methods, `request("/apiproxy/v1/ordering/pre-order-pickup-estimate/{shortStoreNumber}")` is allowlisted as GET. This has no dedicated client wrapper or CLI command; its response is untyped `unknown`.
- Raw `request` callers pass the complete body, including `{variables: …}` when needed. `operation` wraps variables for them.

### Local cart helpers — no API calls

| Export                                                      | Return       | Behavior                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createCart(storeNumber = "")`                              | `Cart`       | Empty local cart; validates nonempty store number format.                                                                                                                                        |
| `createItem(product: Product, options: Customization = {})` | `CartItem`   | Derives size/base SKU and milk/shot modifiers from fetched product data. SDK size defaults to product default (or first size), unlike the CLI's explicit Grande default. Quantity defaults to 1. |
| `addItem(cart: Cart, item: CartItem)`                       | `Cart`       | Returns a cloned cart; merges matching item keys, validates quantities/modifiers. Does not mutate input.                                                                                         |
| `decreaseItem(cart: Cart, index: number)`                   | `Cart`       | Returns a cloned cart after decrement/removal; rejects invalid index.                                                                                                                            |
| `toOrder(cart: Cart)`                                       | `OrderInput` | Validates nonempty cart/full store number and builds Starbucks' pricing request order object. Does not fetch, price, or submit.                                                                  |

### Errors and exported types

`StarbucksError(message, status?)` extends `Error` and exposes optional HTTP `status`. Exported `parseResponse(status, body)` parses JSON, rejecting non-2xx, non-JSON, and nonempty top-level GraphQL `errors`. Validation errors and underlying fetch/timeout failures may be ordinary errors, not `StarbucksError`.

Public TypeScript interfaces: `Transport`, `HttpTransportOptions`, `Customization`, `MenuProduct`, `MenuCategory`, `Menu`, `OptionSize`, `ProductOption`, `OptionCategory`, `RecipeOption`, `ProductSize`, `Product`, `Store`, `StoreLocation`, `Modifier`, `CartItem`, `Cart`, `OrderInput`, and `PriceQuote`. They describe the implemented subset, not complete Starbucks response schemas.

## Examples

Public SDK call:

```ts
import {
  StarbucksClient,
  createCart,
  createItem,
  addItem,
} from "./dist/index.js";

const api = new StarbucksClient();
const product = await api.product(407, "hot");
const cart = addItem(
  createCart("114-101752"),
  createItem(product, {
    size: "Grande",
    milk: "Oatmilk",
    shots: 3,
  }),
);
```

HTTP-session SDK call (requires valid cookies; does not log in):

```ts
import { CookieJar } from "tough-cookie";
import { StarbucksClient, HttpTransport } from "./dist/index.js";

const cookieJar = await CookieJar.deserialize(serializedJar);
const api = new StarbucksClient(new HttpTransport({ cookieJar }));
await api.user();
const quote = await api.quote(cart);
const updatedJar = await cookieJar.serialize();
```

CLI local-cart flow:

```sh
bun run starbucks store --place Seattle --name 'Two Union Square' --lat 47.6061389 --lng=-122.3328481
bun run starbucks cart add --product 407 --size Grande --milk Oatmilk --shots 3
bun run starbucks cart show
# Requires a valid imported HTTP session:
bun run starbucks cart quote
```

No `session start`, `--headed`, payment selection, card reload, rewards application, or order-submission implementation exists in the current runtime. `order` always fails before network access. `auth login` provides manual browser sign-in. The separate `bun run auth:fetch` runner has completed a live credential login with fresh script-generated context; see its [verification and limitations](fetch-login.md).
