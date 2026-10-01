# Starbucks fetch SDK + CLI

**[Complete SDK + CLI reference and Starbucks endpoint mapping](docs/reference.md)** — every command, SDK method, flag, request body, and implementation limitation.

An unofficial TypeScript SDK and Node CLI (built and tested with Bun). Store/menu/cart/account API operations use standard `fetch`. **`auth login` uses a visible Playwright browser for manual sign-in**, then saves cookies and closes the browser. The browser is not used for other commands. Order submission is disabled by default and requires explicit opt-in. See the [captured order flow](docs/order-flow.md).

```sh
# .env contains STARBUCKS_USERNAME and STARBUCKS_PASSWORD
bun run auth:fetch
bun run starbucks auth status
```

`auth:fetch` saves the verified cookie jar to `.starbucks/http-fetch-session.json`. Subsequent CLI commands use that session and fetch any fresh context they need from the current website. No dump import, request-header file, or manual context export is required. The separate `auth login` command remains available for manual browser sign-in.

The CLI/client use only the auth session for credentials. Pricing and submission prepare fresh protection using current website scripts; no network dump or imported header file is read. The live Palo Alto review and pricing check passed on October 1, 2026; submission itself remains untested against Starbucks. See [verification](docs/verification.md).

Use Node 24.21+ and Bun 1.3.14+. `.node-version` pins the tested Node version:

```sh
bun install --frozen-lockfile
bun run build
bunx playwright install chromium
bun run test
bun run starbucks menu --search 'Caffè Latte'
bun run starbucks product 407 --form hot --options
bun run starbucks stores --place Seattle --lat 47.6061389 --lng=-122.3328481
```

Development checks use [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) and [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html):

```sh
bun run lint          # check source and tests
bun run lint:fix      # apply safe lint fixes
bun run format       # format code, configuration, and documentation
bun run format:check # check formatting without writing
bun run check        # lint, formatting, build, and tests
```

Generated output and private local state are excluded. Captured JSON fixtures are excluded from formatting.

Build a local cart. Starbucks' observed web flow maintains cart state locally and sends the cart to the pricing endpoint; no server cart-create/add endpoint was observed.

```sh
bun run starbucks store --place Seattle --name 'Two Union Square' --lat 47.6061389 --lng=-122.3328481
bun run starbucks cart add --product 407 --size Grande --milk Oatmilk --shots 3
bun run starbucks cart show
bun run starbucks cart decrease 0
```

The default cart file is `.starbucks/http-cart.json`; use `--cart <file>` to select another. Add merges identical items; decrease subtracts one and removes zero-quantity items. These commands do not synchronize with a website/browser cart. Store selection saves the full store number returned by the API.

Authenticated requests require session cookies. Import accepts serialized `tough-cookie` jars, storage-state objects, or exported cookie arrays and verifies them with a direct `get-user` request before saving:

```sh
bun run starbucks auth import --file /private/path/cookie-jar.json
bun run starbucks auth status
bun run starbucks whoami
bun run starbucks cards
bun run starbucks wallet
bun run starbucks cart quote
bun run starbucks cart preflight
```

The default HTTP session file is `.starbucks/http-fetch-session.json`; override with `--session <file>`. Requests use domain/path/expiry-aware cookies and retain response `Set-Cookie` updates. API errors do not automatically launch a browser or retry.

`whoami` prints the signed-in user profile as JSON. The SDK equivalent is `await client.user()`, which calls `POST /apiproxy/v1/orchestra/get-user` using the session cookies.

`cart preflight` fetches account status, a member price quote, and wallet data. It does not open a payment screen or establish final order acceptance. `cards` and `wallet` CLI outputs mask card numbers and omit payment secrets. SDK methods return the underlying API data.

A separate draft can be created and priced:

```sh
bun run starbucks cart build --product 407 --store 114-101752 --size Grande --milk Oatmilk --shots 3
bun run starbucks cart quote --file .starbucks/draft-cart.json
```

`--guest` explicitly selects guest pricing and still needs a valid guest HTTP session. No guest fingerprint or authentication proof is fabricated.

SDK example:

```ts
import { CookieJar } from "tough-cookie";
import {
  StarbucksClient,
  HttpTransport,
  createCart,
  createItem,
  addItem,
} from "./dist/index.js";

const publicApi = new StarbucksClient();
const product = await publicApi.product(407, "hot");
const cart = addItem(
  createCart("114-101752"),
  createItem(product, {
    size: "Grande",
    milk: "Oatmilk",
    shots: 3,
  }),
);

// Supply a previously obtained serialized HTTP jar; this is not a login flow.
const jar = await CookieJar.deserialize(serializedCookieJar);
const memberApi = new StarbucksClient(new HttpTransport({ cookieJar: jar }));
const quote = await memberApi.quote(cart);
console.log(quote.summary.priceLabel);
```

`HttpTransport` accepts an injectable fetch function and timeout. Its fixed-origin allowlist permits observed menu/store reads and read/quote operations, rejects payment mutations, and disallows API redirects. Member submission alone can be enabled with `allowOrderSubmission: true`; the CLI enables it only for `order submit --confirm`. The separate login function follows only allowlisted authentication redirects and validates callback state. Session/cart files are atomically saved with mode 0600. `.env` and `.starbucks/` remain ignored to keep local credentials and account data private.

The manual-login helper is a separate SDK entry point, loaded only when requested:

```ts
import { loginWithBrowser } from "starbucks-web-sdk/login";
import { StarbucksClient, HttpTransport } from "starbucks-web-sdk";

const cookieJar = await loginWithBrowser({
  sessionFile: ".starbucks/http-fetch-session.json",
});
const client = new StarbucksClient(new HttpTransport({ cookieJar }));
```

`loginWithBrowser` accepts `timeoutMs` and an AbortSignal. The root SDK import remains independent of Playwright. The older low-level fetch `login(credentials, options)` remains experimental; the CLI uses manual browser login. See the [authentication reference](docs/reference.md#authentication-functions).

An experimental credential login now also works with native Node `fetch` and a JavaScript DOM, without launching a browser:

```sh
# .env: STARBUCKS_USERNAME and STARBUCKS_PASSWORD
bun run auth:fetch
```

It runs the current vendor, Iovation, and Accertify scripts, keeps their cookies and per-origin storage consistent, and submits credentials once. A verified session is saved to `.starbucks/http-fetch-session.json`; redacted diagnostics go under `.starbucks/fetch-login/`. Use `bun run auth:fetch --prepare-only` to check context generation without submitting credentials. Node 24.21+ and Bun are required. See [fetch login verification](docs/fetch-login.md) for the observed result and limitations.

Read order/rewards history with that session:

```sh
bun run history --all --output .starbucks/order-history.json
bun run history --receipt '<history-id>' --output .starbucks/order-receipt.json
```

History, receipt lookup, and eGift-history reads are implemented in the SDK. See [history API contracts and commands](docs/history.md).

Review checkout and build its submit payload without placing the order:

```sh
bun run auth:fetch
bun run starbucks order payments
bun run starbucks order review
bun run starbucks order build-submit
```

Use the `store` and `cart add` commands above first. `order review` checks current café/menu availability, wallet payment eligibility, rewards, pickup estimates, and pricing, then writes a private review file. `order build-submit` generates fresh device context from the session and builds the actual submission payload locally without calling an order API. Only `order submit --confirm` sends it. `order status --id <uuid> --store <full-number>` reads pickup estimates for an existing order. Full contracts and submission behavior are in [the order-flow guide](docs/order-flow.md).

`bun run order:probe --cart <cart.json>` verifies wallet and pricing, exits nonzero on either failure, and cannot submit. Context is fetched/generated automatically and is never loaded from captures. `--risk-file` is an optional diagnostic override, not a setup requirement. Session expiry requires signing in again. See the [investigation](docs/order-investigation.md) for evidence and verification limits.
