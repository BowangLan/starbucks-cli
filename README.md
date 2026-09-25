# Starbucks fetch SDK + CLI

**[Complete SDK + CLI reference and Starbucks endpoint mapping](docs/reference.md)** — every command, SDK method, flag, request body, and implementation limitation.

An unofficial TypeScript SDK and Bun CLI. Store/menu/cart/account API operations use standard `fetch`. **`auth login` uses a visible Playwright browser for manual sign-in**, then saves cookies and closes the browser. The browser is not used for other commands. Order submission is disabled.

```sh
bun run starbucks auth login
```

Enter your username and password in the browser. The CLI waits for the signed-in redirect, verifies the account in that browser, writes `.starbucks/http-session.json` privately, and closes it automatically. It does not read credentials from `.env`, fill the form, or record login traffic. Closing the window or pressing Ctrl+C cancels without replacing the existing session. Default timeout is five minutes; use `auth login --timeout 600` for ten minutes.

Successful browser login does not guarantee that every later fetch operation will be accepted. Account/Card reads have succeeded with imported cookies; pricing and wallet have previously returned 403/429. See [verification](docs/verification.md).

Use Bun 1.3.14 or newer:

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
bun run starbucks cards
bun run starbucks wallet
bun run starbucks cart quote
bun run starbucks cart preflight
```

The default HTTP session file is `.starbucks/http-session.json`; override with `--session <file>`. Requests use domain/path/expiry-aware cookies and retain response `Set-Cookie` updates. API errors do not automatically launch a browser or retry.

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

`HttpTransport` accepts an injectable fetch function and timeout. Its fixed-origin allowlist permits observed menu/store reads and read/quote operations, rejects order/payment mutations, and disallows API redirects. The separate login function follows only allowlisted authentication redirects and validates callback state. Session/cart files are atomically saved with mode 0600. `.env` and `.starbucks/` remain ignored to keep local credentials and account data private.

The manual-login helper is a separate SDK entry point, loaded only when requested:

```ts
import { loginWithBrowser } from "starbucks-web-sdk/login";
import { StarbucksClient, HttpTransport } from "starbucks-web-sdk";

const cookieJar = await loginWithBrowser({
  sessionFile: ".starbucks/http-session.json",
});
const client = new StarbucksClient(new HttpTransport({ cookieJar }));
```

`loginWithBrowser` accepts `timeoutMs` and an AbortSignal. The root SDK import remains independent of Playwright. The older low-level fetch `login(credentials, options)` remains experimental; the CLI uses manual browser login. See the [authentication reference](docs/reference.md#authentication-functions).
