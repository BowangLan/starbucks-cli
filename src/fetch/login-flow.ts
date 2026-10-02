import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { CookieJar } from "tough-cookie";
import type { LoginCredentials } from "../client.js";
import { StarbucksError } from "../errors.js";
import { allowedLoginFlowRequest, AUTH_ORIGIN, ORIGIN } from "./policy.js";

export interface LoginFlowOptions {
  jar: CookieJar;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
  staySignedIn?: boolean;
}

type Node = DefaultTreeAdapterMap["node"];
function children(n: Node): Node[] {
  return "childNodes" in n ? n.childNodes : [];
}
function attr(n: Node, name: string): string | undefined {
  return "attrs" in n ? n.attrs.find((a) => a.name === name)?.value : undefined;
}
function descendants(n: Node): Node[] {
  return children(n).flatMap((c) => [c, ...descendants(c)]);
}
function tag(n: Node, name: string): boolean {
  return "tagName" in n && n.tagName === name;
}

/**
 * The sign-in redirect and form flow: fresh server state and cookies only.
 * It generates no protection tokens; login.ts supplies those through `fetch`.
 * Sends credentials at most once and never retries. The caller verifies the account.
 */
export async function runLoginFlow(
  credentials: LoginCredentials,
  options: LoginFlowOptions,
): Promise<void> {
  if (!credentials.username || !credentials.password)
    throw new Error("Username and password are required");
  const { jar, fetch: fetcher } = options;
  async function request(
    url: URL,
    method = "GET",
    body?: URLSearchParams,
    referer?: string,
  ) {
    if (!allowedLoginFlowRequest(url))
      throw new StarbucksError("Unexpected login destination");
    const cookie = await jar.getCookieString(url.href);
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 25000),
        headers: {
          accept: url.pathname.includes("/a0/signin")
            ? "application/json"
            : "text/html",
          ...(cookie ? { cookie } : {}),
          ...(referer ? { referer } : {}),
          ...(method === "POST"
            ? {
                origin: url.origin,
                "content-type": body
                  ? "application/x-www-form-urlencoded"
                  : "application/json",
              }
            : {}),
        },
        body,
      });
    } catch {
      throw new StarbucksError(
        "Login network request failed; no automatic retry",
      );
    }
    for (const cookie of response.headers.getSetCookie())
      await jar.setCookie(cookie, url.href);
    if (response.status >= 400)
      throw new StarbucksError(
        `Login ${url.pathname} returned HTTP ${response.status}; no automatic retry. Browser-generated signals may be required.`,
        response.status,
      );
    return response;
  }
  const start = new URL("/account/signin?ReturnUrl=%2F", ORIGIN);
  const initial = await request(start);
  if (initial.status !== 200)
    throw new StarbucksError(
      "Unexpected sign-in page response",
      initial.status,
    );
  const begin = await request(
    new URL("/apiproxy/v1/account/a0/signin?returnUrl=%2F", ORIGIN),
    "POST",
    undefined,
    start.href,
  );
  let authorize: unknown;
  try {
    authorize = await begin.json();
  } catch {
    throw new StarbucksError("Invalid authorization response");
  }
  if (typeof authorize !== "string")
    throw new StarbucksError("Missing authorization URL");
  let url: URL;
  try {
    url = new URL(authorize);
  } catch {
    throw new StarbucksError("Invalid authorization URL");
  }
  if (
    !allowedLoginFlowRequest(url) ||
    url.origin !== AUTH_ORIGIN ||
    url.pathname !== "/authorize"
  )
    throw new StarbucksError("Unexpected authorization destination");
  const state = url.searchParams.get("state");
  const callback = new URL("/apiproxy/v1/oauth-callback", ORIGIN).href;
  if (
    !state ||
    url.searchParams.get("redirect_uri") !== callback ||
    url.searchParams.get("response_type") !== "code" ||
    !url.searchParams.get("code_challenge") ||
    url.searchParams.get("code_challenge_method") !== "S256"
  )
    throw new StarbucksError("Invalid authorization transaction");
  let response = await request(url, "GET", undefined, start.href);
  let submitted = false,
    callbackSeen = false;
  for (let step = 0; step < 12; step++) {
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new StarbucksError("Missing login redirect");
      if (submitted && [307, 308].includes(response.status))
        throw new StarbucksError("Refusing credential-preserving redirect");
      const next = new URL(location, url);
      if (!allowedLoginFlowRequest(next))
        throw new StarbucksError("Unexpected login redirect destination");
      if (
        next.origin === ORIGIN &&
        next.pathname === "/apiproxy/v1/oauth-callback"
      ) {
        if (
          next.searchParams.get("state") !== state ||
          !next.searchParams.get("code")
        )
          throw new StarbucksError("Invalid OAuth callback state or code");
        callbackSeen = true;
      }
      const previous = url;
      url = next;
      response = await request(
        url,
        "GET",
        undefined,
        previous.origin + previous.pathname,
      );
      continue;
    }
    if (response.status !== 200)
      throw new StarbucksError("Unexpected login response", response.status);
    if (url.origin === AUTH_ORIGIN && url.pathname === "/u/login") {
      if (submitted)
        throw new StarbucksError(
          "Login did not complete; no automatic credential retry",
        );
      const tree = parse(await response.text());
      const forms = descendants(tree).filter(
        (n) =>
          tag(n, "form") &&
          descendants(n).some(
            (c) => tag(c, "input") && attr(c, "name") === "password",
          ),
      );
      if (
        forms.length !== 1 ||
        (attr(forms[0], "method") ?? "get").toLowerCase() !== "post"
      )
        throw new StarbucksError("Unsupported login form or challenge");
      const action = new URL(attr(forms[0], "action") || url.href, url);
      if (action.href !== url.href)
        throw new StarbucksError("Unexpected credential form destination");
      const fields = new URLSearchParams();
      for (const n of descendants(forms[0])) {
        if (
          tag(n, "input") &&
          attr(n, "type") === "hidden" &&
          attr(n, "name") &&
          attr(n, "disabled") === undefined
        )
          fields.append(attr(n, "name")!, attr(n, "value") ?? "");
      }
      if (
        !url.searchParams.get("state") ||
        fields.getAll("state").length !== 1 ||
        fields.get("state") !== url.searchParams.get("state")
      )
        throw new StarbucksError("Login form state mismatch");
      fields.set("username", credentials.username);
      fields.set("password", credentials.password);
      if (options.staySignedIn !== false)
        fields.set("ulp-stay-signed-in", "on");
      submitted = true;
      response = await request(url, "POST", fields, url.href);
      continue;
    }
    if (!callbackSeen || url.origin !== ORIGIN)
      throw new StarbucksError("Login challenge or unsupported continuation");
    return;
  }
  throw new StarbucksError("Login redirect limit exceeded");
}
