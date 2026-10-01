import fs from "node:fs/promises";
import { CookieJar } from "tough-cookie";
import { login } from "../src/auth.ts";
import { writePrivate } from "../src/files.ts";
import { FetchDOM, pause } from "./fetch-dom.mjs";
import { allowedContextRequest, retryNotBefore } from "./fetch-policy.mjs";

function fail(message) {
  console.error(`Sign-in failed: ${message}`);
  process.exit(1);
}

const flags = new Set(process.argv.slice(2));
if (flags.has("--help")) {
  console.log(
    "Usage: bun run auth:fetch [--prepare-only] [--verbose]\n\nSign in with STARBUCKS_USERNAME and STARBUCKS_PASSWORD from .env.\n\n  --prepare-only  Check sign-in preparation without submitting credentials\n  --verbose       Show redacted request diagnostics\n  --help          Show this help",
  );
  process.exit(0);
}
if ([...flags].some((flag) => !["--prepare-only", "--verbose"].includes(flag)))
  fail("Unknown option. Use --help for available options.");
const submit = !flags.has("--prepare-only");
const verbose = flags.has("--verbose");
const debug = (value) => {
  if (verbose) console.error(JSON.stringify(value));
};
const variant = "full";
const username = process.env.STARBUCKS_USERNAME;
const password = process.env.STARBUCKS_PASSWORD;
if (!username || !password)
  fail("Set STARBUCKS_USERNAME and STARBUCKS_PASSWORD in .env.");
const base = ".starbucks/fetch-login";
await fs.mkdir(base, { recursive: true, mode: 0o700 });
const cooldownPath = `${base}/next-attempt.json`;
if (submit) {
  const cooldown = JSON.parse(
    await fs.readFile(cooldownPath, "utf8").catch(() => "{}"),
  );
  if (cooldown.notBefore > Date.now())
    fail(
      `Wait ${Math.ceil((cooldown.notBefore - Date.now()) / 1000)} seconds before trying again.`,
    );
}
const dir = await fs.mkdtemp(`${base}/fresh-`);
await fs.chmod(dir, 0o700);
const jar = new CookieJar();
const trace = [],
  stages = [];
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
let credentialPosts = 0,
  fingerprint,
  initialWindow,
  authWindow,
  initialPrepared = false,
  preparationError;
const tokenChecks = {};
const ponosTokens = new Map();
const bootstrapTokens = new Map();
async function network(input, init = {}) {
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
    await writePrivate(cooldownPath, { notBefore: Date.now() + 60000 });
    console.error("Signing in...");
  }
  if (url.pathname === "/apiproxy/v1/orchestra/get-user")
    console.error("Verifying account...");
  const headers = new Headers(init.headers);
  headers.set("user-agent", userAgent);
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
      ? new URL(headers.get("referer"))
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
  const response = await fetch(url, {
    method,
    body: init.body,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(25000),
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
    setCookies: response.headers.getSetCookie().map((v) => v.split("=", 1)[0]),
  };
  trace.push(entry);
  debug(entry);
  if (response.status === 429) {
    await writePrivate(cooldownPath, {
      notBefore: retryNotBefore(response.headers.get("retry-after")),
    });
  }
  if (
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
    tokenChecks.etClientToken = url.searchParams.get("t");
  return response;
}
const dom = new FetchDOM({ request: network, jar, userAgent });
function stage(value) {
  stages.push(value);
  debug(value);
}
async function prepareInitial(url) {
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
    (window) => {
      window.IGLOO = {
        loader: { uri_hook: "/iojs", version: "general5" },
        bb_callback(value, complete) {
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
async function preparedForm(fields) {
  const form =
    authWindow.document.querySelector('form[data-form-primary="true"]') ??
    authWindow.document.querySelector("form");
  if (!form) throw new Error("Missing credential form");
  for (const [name, value] of fields) {
    let input = [...form.elements].find((e) => e.name === name);
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
  const fresh = submission.fields;
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
      !!f && f === bootstrapTokens.get(origin) && f === ponosTokens.get(origin),
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
    throw new Error("Vendor context is incomplete; credentials not submitted");
  if (
    !token ||
    token !== tokenChecks.gtClientToken ||
    token !== cookieToken ||
    token !== tokenChecks.etClientToken ||
    ![...fresh.keys()].some((k) => k.startsWith("ulp-fp-part-"))
  )
    throw new Error("Risk context is incomplete; credentials not submitted");
  if (!submit)
    throw new Error(
      "Preparation verified; dry run stopped before credential POST",
    );
  await dom.settle(100);
  return fresh;
}
async function fetcher(input, init = {}) {
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
}
let result;
const startedAt = Date.now();
try {
  console.error("Preparing sign-in...");
  await login({ username, password }, { cookieJar: jar, fetch: fetcher });
  await writePrivate(
    ".starbucks/http-fetch-session.json",
    await jar.serialize(),
  );
  result = {
    authenticated: true,
    sessionFile: ".starbucks/http-fetch-session.json",
  };
} catch (error) {
  const failure = preparationError ?? error;
  result = {
    authenticated: false,
    error:
      failure instanceof Error
        ? failure.message
            .replaceAll(username, "<REDACTED>")
            .replaceAll(password, "<REDACTED>")
            .replace(/https?:\/\/\S+/g, "<url>")
        : "Unknown failure",
  };
  process.exitCode = submit || !result.error.includes("dry run") ? 1 : 0;
} finally {
  dom.close();
  const traceFile = `${dir}/trace.json`;
  await writePrivate(traceFile, {
    submit,
    variant,
    credentialPosts,
    trace,
    stages,
    result,
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.authenticated) {
    console.log(`Signed in successfully (${elapsed}s).`);
    console.log(`Session saved to ${result.sessionFile}`);
  } else if (!submit && process.exitCode === 0) {
    console.log(
      `Sign-in checks passed (${elapsed}s). No credentials submitted.`,
    );
  } else {
    console.error(`Sign-in failed: ${result.error}`);
  }
  if (verbose || process.exitCode === 1) console.error(`Details: ${traceFile}`);
}
