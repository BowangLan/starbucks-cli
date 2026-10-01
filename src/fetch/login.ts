import fs from "node:fs/promises";
import { CookieJar } from "tough-cookie";
import type { LoginCredentials, LoginOptions, LoginResult } from "../client.js";
import { LoginError } from "../errors.js";
import { writePrivate } from "../files.js";
import { FetchDOM, pause } from "./dom.mjs";
import { runLoginFlow } from "./login-flow.js";
import { allowedContextRequest, retryNotBefore } from "./policy.js";
import { HttpTransport, verifyAccount } from "./transport.js";

export interface FetchLoginOptions extends LoginOptions {
  jar: CookieJar;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

class PrepareOnlyStop extends Error {}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/**
 * Sign in with fetch alone: the website's own protection scripts run in jsdom
 * so the credential form carries the fields a browser would send. Results vary
 * with the egress IP address; browser login is the fallback.
 */
export async function fetchLogin(
  credentials: LoginCredentials,
  options: FetchLoginOptions,
): Promise<LoginResult> {
  const { username, password } = credentials;
  if (!username || !password)
    throw new Error("Username and password are required");
  const submit = !options.prepareOnly;
  const jar = options.jar;
  const send = options.fetch ?? globalThis.fetch;
  const progress = options.onProgress ?? (() => {});
  const debug = options.onDiagnostic ?? (() => {});
  const variant = "full";

  const base = options.stateDir;
  const cooldownPath = base && `${base}/next-attempt.json`;
  const setCooldown = async (notBefore: number) => {
    if (cooldownPath) await writePrivate(cooldownPath, { notBefore });
  };
  if (base) await fs.mkdir(base, { recursive: true, mode: 0o700 });
  if (submit && cooldownPath) {
    const cooldown = JSON.parse(
      await fs.readFile(cooldownPath, "utf8").catch(() => "{}"),
    );
    if (cooldown.notBefore > Date.now())
      throw new LoginError(
        `Wait ${Math.ceil((cooldown.notBefore - Date.now()) / 1000)} seconds before trying again.`,
      );
  }
  const dir = base ? await fs.mkdtemp(`${base}/fresh-`) : undefined;
  if (dir) await fs.chmod(dir, 0o700);

  const trace: Record<string, unknown>[] = [],
    stages: Record<string, unknown>[] = [];
  let credentialPosts = 0,
    fingerprint: string | undefined,
    initialWindow: any,
    authWindow: any,
    initialPrepared = false,
    preparationError: unknown;
  const tokenChecks: Record<string, string | undefined> = {};
  const ponosTokens = new Map<string | undefined, string | null>();
  const bootstrapTokens = new Map<string, string | undefined>();

  async function network(input: unknown, init: any = {}): Promise<Response> {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (!allowedContextRequest(url, method)) {
      // Ignore optional analytics resources, never send them credentials or request state.
      if (init.resource === "script" && method === "GET") {
        trace.push({ blockedResource: url.origin + url.pathname });
        return new Response("", { status: 200 });
      }
      throw new Error("Unexpected fetch login destination or method");
    }
    if (
      method === "POST" &&
      url.origin === "https://auth.starbucks.com" &&
      url.pathname === "/u/login"
    ) {
      if (!submit || ++credentialPosts !== 1)
        throw new Error("Credential submission limit");
      await setCooldown(Date.now() + 60000);
      progress("Signing in...");
    }
    if (url.pathname === "/apiproxy/v1/orchestra/get-user")
      progress("Verifying account...");
    const headers = new Headers(init.headers);
    headers.set("user-agent", USER_AGENT);
    headers.set("accept-language", "en-US,en;q=0.9");
    headers.set(
      "sec-ch-ua",
      '"Chromium";v="153", "Not=A?Brand";v="24", "Google Chrome";v="153"',
    );
    headers.set("sec-ch-ua-mobile", "?0");
    headers.set("sec-ch-ua-platform", '"macOS"');
    const source = init.referer
      ? new URL(init.referer)
      : headers.has("referer")
        ? new URL(headers.get("referer")!)
        : null;
    if (source) {
      headers.set(
        "referer",
        source.origin === url.origin ? source.href : source.origin + "/",
      );
      headers.set(
        "sec-fetch-site",
        source.origin === url.origin
          ? "same-origin"
          : source.hostname.endsWith("starbucks.com") &&
              url.hostname.endsWith("starbucks.com")
            ? "same-site"
            : "cross-site",
      );
    } else headers.set("sec-fetch-site", "none");
    headers.set(
      "sec-fetch-dest",
      init.resource === "script"
        ? "script"
        : init.resource === "iframe"
          ? "iframe"
          : init.document
            ? "document"
            : "empty",
    );
    headers.set(
      "sec-fetch-mode",
      init.document ? "navigate" : init.resource ? "no-cors" : "cors",
    );
    if (init.origin && (!init.resource || method === "POST"))
      headers.set("origin", init.origin);
    const cookie = await jar.getCookieString(url.href);
    if (cookie) headers.set("cookie", cookie);
    else headers.delete("cookie");
    const started = Date.now();
    const response = await send(url, {
      method,
      body: init.body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 25000),
    });
    for (const value of response.headers.getSetCookie())
      await jar.setCookie(value, url.href);
    const entry = {
      time: new Date().toISOString(),
      method,
      endpoint: url.origin + url.pathname,
      status: response.status,
      elapsedMs: Date.now() - started,
      queryKeys: [...url.searchParams.keys()],
      retryAfter: response.headers.get("retry-after"),
      setCookies: response.headers
        .getSetCookie()
        .map((v) => v.split("=", 1)[0]),
    };
    trace.push(entry);
    debug(entry);
    if (response.status === 429)
      await setCooldown(retryNotBefore(response.headers.get("retry-after")));
    if (
      dir &&
      url.origin === "https://auth.starbucks.com" &&
      url.pathname === "/u/login" &&
      method === "POST" &&
      response.status >= 400
    ) {
      // Capture the rejection so a failure explains itself instead of only a code.
      const body = await response
        .clone()
        .text()
        .catch(() => "");
      await writePrivate(`${dir}/u-login-error.json`, {
        status: response.status,
        statusText: response.statusText,
        location: response.headers.get("location"),
        retryAfter: response.headers.get("retry-after"),
        correlationId: response.headers.get("x-correlation-id"),
        requestId: response.headers.get("x-request-id"),
        body: body
          .replaceAll(username, "<REDACTED>")
          .replaceAll(password, "<REDACTED>"),
      });
    }
    if (
      url.pathname === "/vendor/static/vendor2.js" &&
      !url.search &&
      response.status === 200
    ) {
      const code = await response.clone().text();
      bootstrapTokens.set(url.origin, code.match(/init\("([^"]+)"/)?.[1]);
    }
    if (url.hostname === "ponos.zeronaught.com" && response.status === 200)
      ponosTokens.set(init.origin ?? source?.origin, url.searchParams.get("b"));
    if (url.hostname === "prod.accdab.net" && url.pathname === "/beacon/gt") {
      const body = JSON.parse(
        Buffer.from(String(init.body), "base64").toString(),
      );
      if (response.status === 200) tokenChecks.gtClientToken = body.ctkn;
      stages.push({
        registrationStatus: response.status,
        deviceKeys: Object.keys(body.sesn ?? {}),
      });
    }
    if (
      url.hostname === "prod.accdab.net" &&
      url.pathname === "/beacon/et" &&
      response.status === 204
    )
      tokenChecks.etClientToken = url.searchParams.get("t") ?? undefined;
    return response;
  }
  const dom = new FetchDOM({ request: network, jar, userAgent: USER_AGENT });
  function stage(value: Record<string, unknown>) {
    stages.push(value);
    debug(value);
  }
  async function prepareInitial(url: URL) {
    const accSrc =
      "https://prod.accdab.net/cdn/cs/F3YqEeKYX8DMWEu7kxZT1ymCLP4.js";
    const scripts = ['<script src="/vendor/static/vendor2.js"></script>'];
    scripts.push(
      `<script src="${accSrc}"></script>`,
      '<script src="/weblx/assets/iovation-first-third.js"></script>',
    );
    initialWindow = dom.open(
      `<!doctype html><html><head>${scripts.join("")}</head><body></body></html>`,
      url.href,
      (window: any) => {
        window.IGLOO = {
          loader: { uri_hook: "/iojs", version: "general5" },
          bb_callback(value: string, complete: boolean) {
            window.io_value = value;
            window.io_complete = complete;
          },
        };
      },
    );
    await dom.settle(5500);
    fingerprint = initialWindow.io_value;
    stage({
      stage: "initial-context",
      variant,
      fingerprintComplete: !!initialWindow.io_complete,
      fingerprintLength: fingerprint?.length ?? 0,
      riskTokenPresent: !!initialWindow._bcn?.getToken(),
      ponosSeen: ponosTokens.has(url.origin),
    });
    if (
      !fingerprint ||
      !initialWindow.io_complete ||
      !initialWindow._bcn?.getToken()
    )
      throw new Error(
        "Initial context did not complete; credentials not submitted",
      );
    initialWindow._bcn?.flush();
    await dom.settle(100);
  }
  async function preparedForm(fields: URLSearchParams) {
    const form =
      authWindow.document.querySelector('form[data-form-primary="true"]') ??
      authWindow.document.querySelector("form");
    if (!form) throw new Error("Missing credential form");
    for (const [name, value] of fields) {
      let input = [...form.elements].find((e: any) => e.name === name);
      if (!input) {
        input = authWindow.document.createElement("input");
        input.type = "hidden";
        input.name = name;
        form.appendChild(input);
      }
      if (input.type === "checkbox") input.checked = value === "on";
      else input.value = value;
    }
    const before = dom.submissions.length;
    form.submit();
    for (let n = 0; n < 60 && dom.submissions.length === before; n++)
      await pause(100);
    const submission = dom.submissions[before];
    if (!submission)
      throw new Error(
        `Page submit hooks failed (${authWindow.page_error_code ?? "no form submission"})`,
      );
    const fresh: URLSearchParams = submission.fields;
    if (
      fresh.get("state") !== fields.get("state") ||
      fresh.get("username") !== username ||
      fresh.get("password") !== password
    )
      throw new Error("Prepared form transaction/credential mismatch");
    const origin = "https://auth.starbucks.com";
    const f = fresh.get("X-DQ7Hy5L1-f");
    const token = fresh.get("ulp-uba-id");
    const cookieToken = (await jar.getCookies(origin)).find(
      (c) => c.key === "_bcnctkn",
    )?.value;
    stage({
      stage: "prepared-form",
      fields: [...fresh].map(([name, value]) => ({
        name,
        ...(["username", "password"].includes(name)
          ? {}
          : { length: value.length }),
      })),
      bootstrapEqualsPonosEqualsForm:
        !!f &&
        f === bootstrapTokens.get(origin) &&
        f === ponosTokens.get(origin),
      registrationEqualsCookieEqualsBeaconEqualsForm:
        !!token &&
        token === tokenChecks.gtClientToken &&
        token === cookieToken &&
        token === tokenChecks.etClientToken,
      domErrors: [...dom.errors],
    });
    if (
      !["a", "z", "d", "c", "b", "f"].every((suffix) =>
        fresh.get(`X-DQ7Hy5L1-${suffix}`),
      ) ||
      f !== bootstrapTokens.get(origin) ||
      f !== ponosTokens.get(origin)
    )
      throw new Error(
        "Vendor context is incomplete; credentials not submitted",
      );
    if (
      !token ||
      token !== tokenChecks.gtClientToken ||
      token !== cookieToken ||
      token !== tokenChecks.etClientToken ||
      ![...fresh.keys()].some((k) => k.startsWith("ulp-fp-part-"))
    )
      throw new Error("Risk context is incomplete; credentials not submitted");
    if (!submit)
      throw new PrepareOnlyStop(
        "Preparation verified; dry run stopped before credential POST",
      );
    await dom.settle(100);
    return fresh;
  }
  const fetcher = async (input: unknown, init: any = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/apiproxy/v1/account/a0/signin") {
      const res = await network("https://auth.starbucks.com/logout", {
        referer: "https://www.starbucks.com/",
        document: true,
      });
      if (res.status !== 200) throw new Error("Unexpected logout status");
    }
    if (
      url.origin === "https://auth.starbucks.com" &&
      url.pathname === "/authorize" &&
      fingerprint
    )
      url.searchParams.set("x-fp", fingerprint);
    if (url.pathname === "/u/login" && init.method === "POST") {
      try {
        init = { ...init, body: await preparedForm(init.body) };
      } catch (error) {
        preparationError = error;
        throw error;
      }
    }
    const res = await network(url, {
      ...init,
      document: !url.pathname.includes("/apiproxy/"),
    });
    if (
      url.pathname === "/account/signin" &&
      res.status === 200 &&
      !initialPrepared
    ) {
      initialPrepared = true;
      await prepareInitial(url);
    }
    if (
      url.pathname === "/u/login" &&
      (init.method ?? "GET") === "GET" &&
      res.status === 200
    ) {
      const html = await res.clone().text();
      authWindow = dom.open(html, url.href);
      await dom.settle(3500);
      stage({
        stage: "auth-context",
        fingerprintLength: authWindow.io_value?.length ?? 0,
        riskTokenPresent: !!authWindow._bcn?.getToken(),
        ponosSeen: ponosTokens.has(url.origin),
      });
    }
    return res;
  };

  let result: Record<string, unknown> = {};
  const traceFile = dir && `${dir}/trace.json`;
  try {
    progress("Preparing sign-in...");
    await runLoginFlow(credentials, {
      jar,
      fetch: fetcher as typeof globalThis.fetch,
      timeoutMs: options.timeoutMs,
      staySignedIn: options.staySignedIn,
    });
    // Verify through the same browser-like requests the sign-in used.
    await verifyAccount(
      new HttpTransport({
        cookieJar: jar,
        fetch: fetcher as typeof globalThis.fetch,
        timeoutMs: options.timeoutMs,
      }),
    );
    result = { authenticated: true };
    return { authenticated: true, traceFile };
  } catch (error) {
    const failure = preparationError ?? error;
    if (failure instanceof PrepareOnlyStop) {
      result = { authenticated: false, prepared: true };
      return { authenticated: false, traceFile };
    }
    const message =
      failure instanceof Error
        ? failure.message
            .replaceAll(username, "<REDACTED>")
            .replaceAll(password, "<REDACTED>")
            .replace(/https?:\/\/\S+/g, "<url>")
        : "Unknown failure";
    result = { authenticated: false, error: message };
    throw new LoginError(message, traceFile);
  } finally {
    dom.close();
    if (traceFile)
      await writePrivate(traceFile, {
        submit,
        variant,
        credentialPosts,
        trace,
        stages,
        result,
      });
  }
}
