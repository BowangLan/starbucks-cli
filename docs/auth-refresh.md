# Auth session refresh

```sh
bun run starbucks auth refresh
bun run starbucks --session .starbucks/my-session.json auth refresh
```

The SDK method is `await client.refreshSession()`. It sends one `POST https://www.starbucks.com/apiproxy/v1/orchestra/get-user` with the captured JSON body `{}` and existing scoped cookies. It verifies `data.user.exId`, then immediately saves the updated cookie jar atomically with mode 0600. Cookie names are discovered from responses rather than hardcoded. The CLI prints only `{ authenticated: true, session: "…" }`, without cookie values or account data.

A missing session fails before network I/O. HTTP errors, redirects, malformed responses, and unauthenticated profiles fail without retries. Updates are staged in a cloned jar, so a rejected refresh does not replace the saved session. No username/password, browser, protection scripts, capture import, or checkout request is needed.

## Capture comparison

Compared these local captures, using request bodies, complete `request-headers`/`response-headers` events, and response bodies:

- `network-dump-2026-10-02T15-43-49-200Z`: user-reported same IP.
- `network-dump-2026-10-02T15-52-52-346Z`: user-reported switched IP.

| Observation                          | Same IP                                          | Switched IP                                                        |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------ |
| Initial document                     | `GET /`, HTTP 200                                | `GET /`, HTTP 200                                                  |
| Account request                      | `000028`: `POST /apiproxy/v1/orchestra/get-user` | `000031`: same endpoint and method                                 |
| Account body                         | `{}`                                             | `{}`                                                               |
| Account response                     | HTTP 200, 3,171 bytes, signed-in user            | HTTP 200, byte-identical user response                             |
| Auth cookies sent                    | `.SbuxA0Extended`, `.SbuxA0Oat`                  | Same names, different values                                       |
| Starbucks response cookie            | `tiWQK2tY`, same value as request                | Identical `Set-Cookie` to the first capture, same value as request |
| OAuth/sign-in/token-refresh requests | None observed                                    | None observed                                                      |

The auth-related request and response behavior is the same across the reported IP switch. The full dumps differ in telemetry order/count, timestamps, request IDs, and some cookie values. Besides the two auth cookies, `s_check` and two Google Analytics cookie values differ between captures. No bearer authorization or vendor protection headers accompany the account request.

Neither dump contains a response setting `.SbuxA0Extended`, `.SbuxA0Oat`, or `s_check`. Those values changed between the captures, but their rotation happened outside the recorded requests. The captures therefore establish successful use of existing auth cookies after the reported IP switch, not an observed credential-renewal protocol. The IP change itself is user-provided context rather than a fact established by these network events.

The captured website bundle also checks the `s_check` short/extended timestamps and uses `get-user` to fetch the account profile. The CLI uses that observed account endpoint and retains whatever cookie updates Starbucks returns. It does not invent an OAuth refresh endpoint, replay captured tokens, or claim that the auth credentials rotated when they did not.

## Limits and verification

Starbucks distinguishes long-lived account recognition from short-lived payment authorization. The checkout capture issued `.SbuxA0Auth` for 20 minutes even with stay-signed-in enabled. `auth refresh` and `auth status` can succeed after that cookie expires while wallet reads require login. See [session lifetimes and checkout reauthentication](auth-sessions.md) for the capture evidence, comparison with CLI login, and command semantics.

A successful refresh confirms account-profile access. It does not guarantee expired-token renewal or full checkout authorization: an account with role `user:limited` may still need sign-in. If Starbucks rejects the session, use `starbucks login` or import cookies from a signed-in session with `starbucks auth import --file <file>`.

Automated tests cover the exact captured body, cookie scoping, immediate private persistence, successful responses without rotation, rejected responses with cookie deletions, no retries, missing sessions, and CLI output. Tests use synthetic credentials; this change does not make a live request with the private capture cookies. The two supplied browser captures are the live evidence for the IP comparison.
