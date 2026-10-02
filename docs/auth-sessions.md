# Account recognition and payment authorization

Starbucks can recognize the signed-in account while requiring another password login before checkout. `auth status` and `auth refresh` can return `authenticated: true` while payment-method reads fail with `user:limited`. Those commands verify profile access; they do not verify full payment authorization.

## Two session lifetimes

The October 2, 2026 checkout capture shows two different lifetimes established by the OAuth callback:

| Cookie or metadata | Observed behavior                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.SbuxA0Auth`      | Full authorization cookie, issued with `Max-Age=1200` (20 minutes). Present on successful card-list and wallet requests after password login.                            |
| `.SbuxA0Extended`  | Longer-lived account session, issued with an expiry about 30 days later. Present before checkout when the full-auth cookie was absent.                                   |
| `.SbuxA0Oat`       | OAuth-related cookie, issued with `Max-Age=2592000` (30 days). Its exact server-side contents are opaque. Its presence alone does not establish payment authorization.   |
| `s_check`          | Frontend session metadata containing `short` and/or `extended` expiry timestamps. The website uses these timestamps to decide whether recent authentication is required. |

The recorded password form had `ulp-stay-signed-in=on`, but the callback still issued only 20 minutes of full authorization. “Stay signed in” therefore does not keep payment access active for the whole extended session. These are observed lifetimes, not guarantees that Starbucks will retain them across future implementations or accounts.

When full authorization expires, profile access can continue. In the checkout capture, member pricing also succeeded without `.SbuxA0Auth`; that does not establish permission to fetch payment methods or submit an order. The server's `authorize-operation` failure with `roleProvided: user:limited` and `roleRequired: user` is surfaced by the SDK as `REAUTHENTICATION_REQUIRED`.

## Checkout capture evidence

Source: capture `network-dump-2026-10-02T16-13-02-208Z`. Request IDs below belong to that capture. No capture files are runtime dependencies, and no external filesystem location is needed to use the CLI.

| Request                               | Observation                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `000031`, `get-user`                  | HTTP 200 with `.SbuxA0Extended` and `.SbuxA0Oat`, without `.SbuxA0Auth`. The frontend's session metadata contained only an extended expiry. |
| `000286`, `price-order`               | HTTP 200 with the same absence of full authorization.                                                                                       |
| `000310`, `/account/signin`           | Checkout navigated to sign-in with a return destination of `/menu/cart`. The sign-in response cleared existing Starbucks auth cookies.      |
| `000369`–`000374`                     | Auth logout, OAuth initialization, authorization, then the password page.                                                                   |
| `000394`                              | Password form submitted once with the vendor protection fields, Accertify token, fingerprint parts, and stay-signed-in enabled.             |
| `000397`–`000398`                     | Authorization resumed and the OAuth callback issued `.SbuxA0Auth` for 20 minutes, extended cookies, and fresh `s_check` metadata.           |
| `000481`, card-list; `000514`, wallet | Both returned HTTP 200 with `.SbuxA0Auth` present.                                                                                          |

There was no wallet request before the sign-in navigation in this capture. The website proactively gated checkout based on session state; it did not first receive a wallet 403. The captured shared frontend bundle checks the short/extended timestamps and implements the redirect to sign-in. Earlier wallet diagnostics separately established the `user:limited` failure; see the [wallet investigation](order-investigation.md#wallet-full-authorization-had-expired).

The saved CLI session inspected during this investigation had the same limited state: extended cookies remained, `.SbuxA0Auth` was absent, and `s_check` contained only the extended expiry. The October 1 successful local login trace recorded the full-auth cookie being issued at the callback. This is consistent with short authorization expiring after a successful login, rather than the login flow missing a payment permission. This describes the inspected snapshot, not the current state of every local session.

## Comparison with the CLI login

The browser's checkout login follows the same sequence as [the CLI login](fetch-login.md): sign-in page → auth logout → OAuth initialization → authorization with PKCE and fingerprint → password form → authorization resume → OAuth callback → post-sign-in page.

The browser requests audience `urn:openapi` and scope `offline_access openid profile email`. No checkout-specific scope, `prompt`, `max_age`, or `acr_values` parameter appears. The CLI follows the server-provided authorization URL rather than constructing a separate payment authorization request.

| Detail                 | Checkout browser flow                         | CLI login                                         |
| ---------------------- | --------------------------------------------- | ------------------------------------------------- |
| Return destination     | `/menu/cart`                                  | `/`                                               |
| Starting cookies       | Existing session, cleared by the sign-in page | Fresh cookie jar; adopted only after verification |
| Protection signals     | Generated by website scripts in the browser   | Generated from current website scripts in jsdom   |
| Follow-up verification | Proceeds to card-list and wallet reads        | Requires a successful `get-user` response         |

The return destination controls navigation after login. The capture provides no evidence that returning to the cart requests additional privileges. Both the captured browser callback and the successful local CLI login trace issued `.SbuxA0Auth`.

IP-dependent login acceptance is a separate issue. The two earlier October 2 captures showed successful profile access around a user-reported IP switch, but did not record full-auth renewal. The missing full-auth cookie explains the checkout behavior here without attributing it to an IP change.

## What the commands establish

| Command or SDK method                     | What success establishes                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth status`, `whoami`, `client.user()`  | Account-profile access through `get-user`.                                                                                                                                          |
| `auth refresh`, `client.refreshSession()` | Account-profile access and persistence of any returned cookie updates. Does not renew the 20-minute payment authorization through password login.                                   |
| `auth import`, `client.importSession()`   | Imported cookies passed the profile check. Their full authorization may already be absent or expired.                                                                               |
| `login`, `client.login()`                 | Password/OAuth flow completed and profile verification passed. The observed callback issues full authorization, but the implementation does not independently verify wallet access. |
| `order payments`                          | The selected session can read the wallet and list eligible existing MOP payments at that time. Does not establish order-submission acceptance.                                      |
| `client.hasSession()`                     | A saved session was loaded, or an injected transport owns authentication. It makes no server request and does not check current privileges.                                         |

The current CLI's `authenticated: true` output does not distinguish account recognition from full authorization. This is a reporting limitation; the documentation does not change that output or add automatic login.

When payment reads require reauthentication, run login and then verify payment access using the same session selection:

```sh
bun run starbucks login
bun run starbucks order payments
```

For a custom session, supply the same global `--session <file>` option to both commands. An imported session needs fresh full authorization as well. Repeating `auth refresh`, refreshing device fingerprints, or obtaining a successful price quote does not substitute for the password login observed here. Payment access remains subject to server authorization and its short lifetime.
