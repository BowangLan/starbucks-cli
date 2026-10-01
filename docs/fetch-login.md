The fetch-only login succeeded on 2026-09-29 at 01:10 UTC using the configured `.env` credentials. One credential POST returned 302, the OAuth callback established a session, and `get-user` returned 200 with a populated account. No browser or WebSocket was used. No captured credential, fingerprint, protection payload, or account-session cookie was replayed.

Run from the repository root with Node 24.21 or newer and Bun:

```sh
bun install --frozen-lockfile
bun run auth:fetch
```

The command reads `STARBUCKS_USERNAME` and `STARBUCKS_PASSWORD` from `.env`. It bundles only the auth runner and its SDK dependencies, then uses Node's native fetch.

Terminal output shows preparation, sign-in, account verification, and the saved session path. Detailed redacted traces are still saved privately. Add `--verbose` to print request diagnostics; failures include the trace-file path for inspection.

`bun run auth:fetch --prepare-only` performs context preparation and checks without submitting credentials. `bun run test:fetch` runs the offline regression tests. Each login invocation can submit credentials once. There are no automatic retries; a persistent cooldown enforces at least 60 seconds between credential attempts and honors longer `Retry-After` values.

The working sequence is:

1. Fetch the sign-in page and run the current vendor bootstrap/runtime, Accertify SDK/iframe, and Iovation SDK in jsdom.
2. Complete Ponos requests and Accertify `/gt` registration; retain cookies plus origin-scoped local/session storage. Obtain a fresh Iovation callback fingerprint.
3. Fetch auth logout, initialize OAuth, and attach the fingerprint to `/authorize` as `x-fp`.
4. Run the current auth page scripts with the same context. In the successful fetch run, Accertify used `/at` to associate its cached server token with the auth-page context.
5. Let the page's submission hooks generate protection fields, pack the fingerprint cookies, fill the Accertify client token, and flush events. Verify bootstrap/Ponos/form token equality and registration/cookie/beacon/form token equality.
6. Submit the `.env` credentials, follow allowlisted OAuth redirects, validate state, and require an authenticated `get-user` result before saving.

The session is written privately to `.starbucks/http-fetch-session.json`. Logs under `.starbucks/fetch-login/` include endpoint paths, status, field names/lengths, and consistency checks. They exclude credential, cookie, token, authorization-state, and account values.

The successful experiment's redacted local trace is `.starbucks/debug-fetch-login/fresh-GTpydo/trace.json`. `/u/login` returned 302 in 2,311 ms; `get-user` returned 200. All six vendor fields were freshly generated, both Ponos responses returned 200, Accertify registration returned 200, association returned 204, and behavioral beacons returned 204. The trace establishes a working combination; it does not isolate which missing signal caused each earlier 429.

This remains experimental. It executes the site's current JavaScript in a DOM emulator; it is not a static HTTP form replay. The emulator implements the document-write and cross-origin message behavior needed by these scripts and routes observed resource, XHR, fetch, and beacon traffic through the same bounded fetch transport. It omits WebSockets, canvas/WebGL, and optional analytics. Those omissions did not prevent the observed login. Endpoint names and page scripts can change, and one success does not establish reliability across other accounts or environments.

The standard CLI can verify the saved fetch-login session:

```sh
bun run starbucks auth status
```
