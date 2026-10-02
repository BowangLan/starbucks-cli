# SDK, CLI, and Starbucks API reference

This documents the fetch-based SDK and CLI. The [order-flow reference](order-flow.md) documents the full member checkout, submission, status APIs, and fresh risk-context runner. Source: [CLI](../src/cli.ts), [client interface](../src/client.ts), [fetch client](../src/fetch/client.ts), [cart helpers](../src/cart.ts), [types](../src/types.ts), and [allowlists](../src/fetch/policy.ts).

Layers: domain modules (`types`, `cart`, `order`, `order-validation`, `preflight`) make no network calls. `StarbucksClient` ([src/client.ts](../src/client.ts)) is the interface the CLI and domain code use. `FetchStarbucksClient` ([src/fetch/](../src/fetch/)) implements it: session store, sign-in, transport, allowlists, and the jsdom runner for protection scripts.

API endpoint paths below use **`https://www.starbucks.com`**. Login also uses **`https://auth.starbucks.com`**. API operations use standard `fetch`. No browser is used.

**Verification:** earlier wallet/pricing successes used captured header replay. That runtime dependency has been removed. On October 1, 2026, the client generated fresh context from the auth session and passed live wallet, pricing, and checkout-review checks. Live submission acceptance remains unverified. See [verification](verification.md).

## CLI command → SDK → Starbucks API

Run commands with `bun run starbucks <command>`. Angle brackets indicate required values; square brackets indicate optional arguments.

Order commands need only the cookie jar saved by `starbucks login` (plus the user's cart). Protected requests generate context from current website scripts; no capture or imported header file is read. Device risk is generated automatically when building or submitting the order; `--risk-file` remains an optional diagnostic override. See [order preparation](order-flow.md).

| CLI command                                                                       | SDK calls                                 | Starbucks HTTP request                                                                                                                   | Local behavior / output                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stores --place <place> [--lat <n> --lng <n>]`                                    | `stores(place, coordinates?)`             | `GET /apiproxy/v1/locations?place=…&lat=…&lng=…`                                                                                         | Prints store number, name, address, distance, open status, and mobile-ordering status. Both coordinates must be supplied together or omitted.                                                                                                                      |
| `menu [--search <term>]`                                                          | `menu()` or `searchMenu(term)`            | `GET /apiproxy/v1/ordering/menu`                                                                                                         | Full menu, or locally filtered products. Search does **not** use a search endpoint.                                                                                                                                                                                |
| `product <id> [--form <form>] [--options]`                                        | `product(id, form)`                       | `GET /apiproxy/v1/ordering/{id}/{form}`                                                                                                  | Prints one product; `--options` projects its sizes and nested customization choices. Form defaults to `hot`.                                                                                                                                                       |
| `auth status`                                                                     | `user()`                                  | `POST /apiproxy/v1/orchestra/get-user`                                                                                                   | Reads HTTP session file; requires nonempty `data.user.exId`. Prints `{authenticated:true, session}` only on success; otherwise exits with an error.                                                                                                                |
| `whoami`                                                                          | `user()`                                  | `POST /apiproxy/v1/orchestra/get-user`                                                                                                   | Prints the signed-in user profile (`data.user`) as JSON. Uses the default session or `--session <file>`; fails if the account is not authenticated.                                                                                                                |
| `auth refresh`                                                                    | `refreshSession()`                        | `POST /apiproxy/v1/orchestra/get-user` with `{}`                                                                                         | Verifies the saved session and immediately saves returned cookies. Requires no username/password. A rejected refresh preserves the saved file. Does not guarantee expired-token renewal or full checkout authorization. See [capture comparison](auth-refresh.md). |
| `auth import --file <file>`                                                       | `importSession(input)`                    | `POST /apiproxy/v1/orchestra/get-user`                                                                                                   | Accepts serialized `tough-cookie` JSON, storage-state objects, or cookie arrays. Verifies consumer authentication before saving the jar to `--session`. Does not perform login.                                                                                    |
| `login [--prepare-only] [--verbose]`                                              | `login(credentials, options)`             | Sign-in page and vendor scripts (jsdom) → authorization → login form → callback → `get-user`                                             | Reads `STARBUCKS_USERNAME`/`STARBUCKS_PASSWORD` (`bun run starbucks` loads `.env`). Sends credentials once; `--prepare-only` stops before that. Saves the session only after account verification. May fail after an IP address change.                            |
| `cards`                                                                           | `cards()`                                 | `POST /apiproxy/v1/orchestra/get-stored-value-card-list`                                                                                 | Prints nickname, last four digits, primary flag, and balance; omits full card number.                                                                                                                                                                              |
| `wallet`                                                                          | `wallet()`                                | `POST /apiproxy/v1/orchestra/get-starpay-wallet`                                                                                         | Prints payment type, last four digits, default/status, and stored-value-card count. Does not select a payment instrument.                                                                                                                                          |
| `store --place <place> --name <name> --lat <n> --lng <n>`                         | `stores(place, coordinates)`              | `GET /apiproxy/v1/locations?place=…&lat=…&lng=…`                                                                                         | Case-insensitive exact name match; requires `mobileOrdering.availability === "READY"`. Saves full store number in local cart. No store-selection API write.                                                                                                        |
| `cart show`                                                                       | Local file read / `createCart()`          | **None**                                                                                                                                 | Prints the local cart. Missing file yields an empty cart with no store selected.                                                                                                                                                                                   |
| `cart add --product <id> [customization flags]`                                   | `product()`, `createItem()`, `addItem()`  | `GET /apiproxy/v1/ordering/{id}/{form}`                                                                                                  | Fetches product configuration, then adds/merges an item in local cart. No server cart-add API.                                                                                                                                                                     |
| `cart decrease <index>`                                                           | `decreaseItem(cart, index)`               | **None**                                                                                                                                 | Zero-based index; subtracts one and removes the item when quantity reaches zero. Saves local cart.                                                                                                                                                                 |
| `cart build --product <id> --store <number> [customization flags] [--out <file>]` | `product()`, `createItem()`, `toOrder()`  | `GET /apiproxy/v1/ordering/{id}/{form}`                                                                                                  | Creates and validates a separate single-item draft. Default output `.starbucks/draft-cart.json`; does not update `--cart` unless explicitly given the same output path.                                                                                            |
| `cart quote [--file <file>] [--guest]`                                            | `quote(cart, mode)`                       | Member: `POST /apiproxy/v1/orchestra/price-order`; guest: `POST /apiproxy/v1/orchestra/price-order-guest`                                | Reads `--file` or current local cart. Prints quote and writes `.starbucks/latest-quote.json`. Both modes use the HTTP session file.                                                                                                                                |
| `cart preflight`                                                                  | `user()` → `quote(cart)` → `wallet()`     | Sequential POSTs: `/apiproxy/v1/orchestra/get-user` → `/apiproxy/v1/orchestra/price-order` → `/apiproxy/v1/orchestra/get-starpay-wallet` | Stops on first failure. Returns `checks`, `checksPassed`, and `orderSubmitted:false`; later checks are marked skipped. Does not verify final checkout acceptance or open a payment screen.                                                                         |
| `order review/build-submit/payments/submit/status/previous`                       | See [order-flow reference](order-flow.md) | Captured checkout and status APIs                                                                                                        | Review stops before submission; build-submit only creates the local payload; submit requires explicit opt-in.                                                                                                                                                      |
| `help [command]`, `--help`, `--version`                                           | None                                      | **None**                                                                                                                                 | Commander-generated usage/version output.                                                                                                                                                                                                                          |

### Global options and local files

Put global options before the command:

```sh
bun run starbucks --session .starbucks/my-http-session.json --cart .starbucks/my-cart.json cart quote
```

| Option             | Default                              | Used by                                                                                                                                                   |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--session <file>` | `.starbucks/http-fetch-session.json` | `auth status/import/refresh`, `login`, `whoami`, `cards`, `wallet`, `cart quote/preflight`, `order` network commands. Public reads do not load this file. |
| `--cart <file>`    | `.starbucks/http-cart.json`          | `store`, `cart show/add/decrease/preflight`, and `cart quote` without `--file`.                                                                           |
| `-h, --help`       | —                                    | Displays help.                                                                                                                                            |
| `-V, --version`    | —                                    | Displays package CLI version.                                                                                                                             |

Session cookies, including response `Set-Cookie` updates, are saved after session-backed commands, even when the request fails. `login`, `auth import`, and `auth refresh` only replace the destination after successful verification. Session/cart JSON writes are atomic with file mode 0600. Saved session files are HTTP cookie jars; storage-state imports are converted locally.

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

### Fetch login and sessions

Source: [src/fetch/login.ts](../src/fetch/login.ts) (protection scripts in jsdom), [src/fetch/login-flow.ts](../src/fetch/login-flow.ts) (redirects and form), [src/fetch/session.ts](../src/fetch/session.ts) (stores and cookie import).

| Method / type                                                         | Behavior                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.login(credentials: LoginCredentials, options?: LoginOptions)` | Runs the current vendor, Iovation, and Accertify scripts in jsdom, then the flow below, then verifies `get-user`. On success the client adopts the new cookies and saves them to its store; a failure leaves the saved session untouched. Returns `{ authenticated, traceFile? }`. |
| `LoginOptions`                                                        | `prepareOnly` (stop before sending credentials), `staySignedIn` (true), `stateDir` (cooldown file and redacted trace; omit to write nothing), `onProgress`, `onDiagnostic`.                                                                                                        |
| `client.refreshSession()`                                             | Clones the existing cookie jar, sends `get-user` with `{}`, requires `data.user.exId`, then adopts and immediately persists returned cookies. Returns `Promise<void>`. A failure leaves the saved session untouched. No sign-in, protection scripts, redirects, or retries.        |
| `client.importSession(input: unknown)`                                | Converts with `importCookieJar`, verifies `get-user`, then replaces the saved session.                                                                                                                                                                                             |
| `importCookieJar(input: unknown)`                                     | Returns `Promise<CookieJar>`. Accepts a serialized jar, storage-state `{cookies: [...]}`, or cookie array. Browser-style imports preserve domain/host-only/path/expiry/security attributes and exclude non-Starbucks domains. No network calls.                                    |
| `FileSessionStore(file)`, `MemorySessionStore(jar?)`                  | `SessionStore` implementations: `load()` returns the jar or `undefined` for no session; `save(jar)` writes atomically with mode 0600 (file store).                                                                                                                                 |

Login requests:

1. `GET www.starbucks.com/account/signin?ReturnUrl=%2F`.
2. Empty `POST www.starbucks.com/apiproxy/v1/account/a0/signin?returnUrl=%2F` with JSON content type. Response is a JSON string containing the authorization URL.
3. `GET auth.starbucks.com/authorize?...` using the returned state and PKCE challenge, with the Iovation fingerprint generated in jsdom appended as `x-fp`.
4. Follow the server redirect to `GET auth.starbucks.com/u/login?state=...`. Parse server hidden fields with an HTML parser; verify hidden state matches the URL.
5. Form-encoded `POST` to that exact login URL with fresh hidden fields, `username`, `password`, and (by default) `ulp-stay-signed-in=on`. The page's own submit hooks, running in jsdom, add the vendor `X-DQ7Hy5L1-*`, `ulp-uba-id`, and `ulp-fp-part-*` fields; credentials are not sent unless all of them are present and their tokens agree.
6. Follow allowlisted redirects through `/authorize/resume` and `www.starbucks.com/apiproxy/v1/oauth-callback?code=...&state=...`; callback state must equal the original authorization state.
7. Reach the Starbucks post-sign-in page and verify `POST /apiproxy/v1/orchestra/get-user`.

Cookies are processed on every response and scoped to each destination. Redirects never forward the credential body. Unexpected destinations, form/state changes, unsupported challenges, HTTP errors, and redirect limits terminate the flow. A returned login form does not trigger another credential submission. With `stateDir`, a cooldown file enforces at least 60 seconds between credential attempts and honors longer `Retry-After` values.

**Authorization lifetime:** the observed `.SbuxA0Auth` cookie lasts 20 minutes, while extended cookies last about 30 days. Profile verification by `auth status`, `auth refresh`, `auth import`, or `login` does not independently establish payment access. `authenticated: true` can coexist with `user:limited`; use `login` followed by `order payments` when wallet access requires reauthentication. See [session lifetimes and checkout reauthentication](auth-sessions.md).

**Limitation:** Starbucks may reject the fetch login after the machine switches to a different IP address. Mock tests cover the redirect flow; live acceptance depends on the server. `auth import --file <file>` accepts cookies exported from a signed-in browser session instead.

### `StarbucksClient` and `FetchStarbucksClient`

`StarbucksClient` is an interface. `new FetchStarbucksClient(options?)` implements it:

```ts
new FetchStarbucksClient({
  session: new FileSessionStore(file), // optional; defaults to an in-memory store with no session
  fetch: customFetch, // optional; defaults to globalThis.fetch
  timeoutMs: 25000, // optional; default 25 seconds
  allowOrderSubmission: false, // default; only explicitly enable for a real purchase
});
```

The client loads cookies from the store on first use and saves refreshed cookies in `close()`. Browsing methods (`menu`, `searchMenu`, `product`, `stores`, `pickupEstimate`) work without a session. Account and ordering methods throw `NotSignedInError` (`code: "NOT_SIGNED_IN"`) before any request when the store has no session. `hasSession()` reports which applies. The client does not read `.env` or cart files.

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

| Name                         | Dedicated SDK wrapper                | Dedicated CLI command                             |
| ---------------------------- | ------------------------------------ | ------------------------------------------------- |
| `get-user`                   | `user()`                             | `whoami`, `auth status/import`; part of preflight |
| `get-stored-value-card-list` | `cards()`                            | `cards`                                           |
| `get-starpay-wallet`         | `wallet()`                           | `wallet`; part of preflight                       |
| `price-order`                | `quote(cart)`                        | `cart quote`; part of preflight                   |
| `price-order-guest`          | `quote(cart, "guest")`               | `cart quote --guest`                              |
| `get-user-mfa-factors`       | None; generic operation only         | None                                              |
| `get-privacy-permissions`    | None; generic operation only         | None                                              |
| `get-favorite-products`      | None; generic operation only         | None                                              |
| `get-terms-acknowledgement`  | None; generic operation only         | None                                              |
| `reward-programs`            | `rewardPrograms()`                   | Part of `order review`                            |
| `get-previous-orders`        | `previousOrders(storeNumber, limit)` | `order previous`                                  |

### HTTP behavior

The fetch client sends every API call through an internal `HttpTransport` ([src/fetch/transport.ts](../src/fetch/transport.ts)); it is not part of the public SDK.

- GET when there is no body; otherwise POST with JSON serialization. Paths are restricted to the Starbucks origin and the allowlist.
- The cookie jar handles domain/path/expiry and retains `Set-Cookie` responses; the client persists it through its session store.
- Common headers: `accept: application/json`, `x-requested-with: XMLHttpRequest`, and matching cookies when available. POST additionally sets `content-type: application/json`, Starbucks `origin`, and `/menu/cart` referer.
- Redirects are rejected. There are no automatic retries or browser fallbacks.
- `GET /apiproxy/v1/ordering/pre-order-pickup-estimate/{shortStoreNumber}` is wrapped by `pickupEstimate(fullStoreNumber)` and `cart pickup`, returning `PickupEstimate`.
- `operation(name, variables)` (on `FetchStarbucksClient`) wraps variables as `{variables: …}`.

### Local cart helpers — no API calls

| Export                                                      | Return       | Behavior                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createCart(storeNumber = "")`                              | `Cart`       | Empty local cart; validates nonempty store number format.                                                                                                                                        |
| `createItem(product: Product, options: Customization = {})` | `CartItem`   | Derives size/base SKU and milk/shot modifiers from fetched product data. SDK size defaults to product default (or first size), unlike the CLI's explicit Grande default. Quantity defaults to 1. |
| `addItem(cart: Cart, item: CartItem)`                       | `Cart`       | Returns a cloned cart; merges matching item keys, validates quantities/modifiers. Does not mutate input.                                                                                         |
| `decreaseItem(cart: Cart, index: number)`                   | `Cart`       | Returns a cloned cart after decrement/removal; rejects invalid index.                                                                                                                            |
| `toOrder(cart: Cart)`                                       | `OrderInput` | Validates nonempty cart/full store number and builds Starbucks' pricing request order object. Does not fetch, price, or submit.                                                                  |

### Errors and exported types

`StarbucksError(message, status?, code?)` extends `Error` and exposes optional HTTP `status`. Subclasses: `NotSignedInError`, `LoginError` (with optional `traceFile`), and `OrderSubmissionDisabledError`. Exported `parseResponse(status, body)` parses JSON, rejecting non-2xx, non-JSON, and nonempty top-level GraphQL `errors`. Validation errors and underlying fetch/timeout failures may be ordinary errors, not `StarbucksError`.

Public TypeScript interfaces: `StarbucksClient`, `FetchClientOptions`, `SessionStore`, `LoginCredentials`, `LoginOptions`, `LoginResult`, `Customization`, `MenuProduct`, `MenuCategory`, `Menu`, `OptionSize`, `ProductOption`, `OptionCategory`, `RecipeOption`, `ProductSize`, `Product`, `Store`, `StoreLocation`, `Modifier`, `CartItem`, `Cart`, `OrderInput`, and `PriceQuote`. They describe the implemented subset, not complete Starbucks response schemas.

## Examples

Public SDK call:

```ts
import {
  FetchStarbucksClient,
  createCart,
  createItem,
  addItem,
} from "./dist/index.js";

const api = new FetchStarbucksClient();
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

Signed-in SDK call using the CLI's saved session:

```ts
import { FetchStarbucksClient, FileSessionStore } from "./dist/index.js";

const api = new FetchStarbucksClient({
  session: new FileSessionStore(".starbucks/http-fetch-session.json"),
});
try {
  await api.user();
  const quote = await api.quote(cart);
} finally {
  await api.close(); // saves refreshed cookies
}
```

CLI local-cart flow:

```sh
bun run starbucks store --place Seattle --name 'Two Union Square' --lat 47.6061389 --lng=-122.3328481
bun run starbucks cart add --product 407 --size Grande --milk Oatmilk --shots 3
bun run starbucks cart show
# Requires a valid imported HTTP session:
bun run starbucks cart quote
```

No `session start`, `--headed`, card reload, or rewards application is implemented. Existing-wallet payment selection, preparation, explicitly enabled member submission, and pickup lookup are documented in the [order-flow reference](order-flow.md). The default transport rejects submission. `login` (`bun run starbucks login`) signs in with fetch; see its [verification and limitations](fetch-login.md).
