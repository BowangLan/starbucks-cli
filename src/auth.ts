import { Cookie, CookieJar } from "tough-cookie";
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { HttpTransport, StarbucksClient, StarbucksError } from "./client.js";
import type { HttpTransportOptions } from "./client.js";
import { ORIGIN } from "./safety.js";

const AUTH_ORIGIN = "https://auth.starbucks.com";
export interface LoginCredentials {
  username: string;
  password: string;
}
export interface LoginOptions extends HttpTransportOptions {
  staySignedIn?: boolean;
}

/** Convert a cookie jar, storage-state object, or cookie export without executing browser code. */
export async function importCookieJar(input: unknown): Promise<CookieJar> {
  if (
    input &&
    typeof input === "object" &&
    "version" in input &&
    typeof input.version === "string" &&
    input.version.startsWith("tough-cookie@")
  ) {
    return CookieJar.deserialize(
      input as Parameters<typeof CookieJar.deserialize>[0],
    );
  }
  const cookies = Array.isArray(input)
    ? input
    : input && typeof input === "object" && "cookies" in input
      ? input.cookies
      : undefined;
  if (!Array.isArray(cookies))
    throw new Error(
      "Expected a cookie jar, storage-state object, or cookie array",
    );
  const jar = new CookieJar();
  for (const c of cookies) {
    if (!c || typeof c.domain !== "string")
      throw new Error("Invalid cookie export");
    const domain = c.domain.replace(/^\./, "");
    if (domain !== "starbucks.com" && !domain.endsWith(".starbucks.com"))
      continue;
    if (
      typeof c.name !== "string" ||
      typeof c.value !== "string" ||
      typeof c.path !== "string" ||
      !c.path.startsWith("/")
    )
      throw new Error("Invalid cookie export");
    const cookie = new Cookie({
      key: c.name,
      value: c.value,
      domain,
      path: c.path,
      hostOnly: !c.domain.startsWith("."),
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      ...(typeof c.expires === "number" && c.expires > 0
        ? { expires: new Date(c.expires * 1000) }
        : {}),
      ...(typeof c.sameSite === "string"
        ? { sameSite: c.sameSite.toLowerCase() }
        : {}),
    });
    await jar.setCookie(cookie, `https://${domain}${c.path}`);
  }
  return jar;
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

/** Fresh server state and cookies only; no generated protection tokens or automatic retries. */
export async function login(
  credentials: LoginCredentials,
  options: LoginOptions = {},
): Promise<StarbucksClient> {
  if (!credentials.username || !credentials.password)
    throw new Error("Username and password are required");
  const jar = options.cookieJar ?? new CookieJar();
  const fetcher = options.fetch ?? globalThis.fetch;
  const client = new StarbucksClient(
    new HttpTransport({ ...options, cookieJar: jar }),
  );
  const allowed = (u: URL): boolean =>
    !u.username &&
    !u.password &&
    ((u.origin === ORIGIN &&
      [
        "/account/signin",
        "/apiproxy/v1/account/a0/signin",
        "/apiproxy/v1/oauth-callback",
        "/account/post-signin",
        "/rewards/my-rewards",
        "/",
      ].includes(u.pathname)) ||
      (u.origin === AUTH_ORIGIN &&
        ["/authorize", "/u/login", "/authorize/resume"].includes(u.pathname)));
  async function request(
    url: URL,
    method = "GET",
    body?: URLSearchParams,
    referer?: string,
  ) {
    if (!allowed(url)) throw new StarbucksError("Unexpected login destination");
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
    !allowed(url) ||
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
      if (!allowed(next))
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
    await client.user();
    return client;
  }
  throw new StarbucksError("Login redirect limit exceeded");
}
