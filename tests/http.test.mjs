import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { CookieJar } from "tough-cookie";
import { HttpTransport, StarbucksClient } from "../dist/index.js";

test("authenticated requests use fetch, scope cookies, encode bodies, and retain Set-Cookie", async () => {
  const jar = new CookieJar();
  await jar.setCookie(
    "session=private; Path=/; Secure; HttpOnly",
    "https://www.starbucks.com",
  );
  await jar.setCookie("foreign=secret; Path=/", "https://other.example");
  await jar.setCookie(
    "expired=secret; Max-Age=0; Path=/",
    "https://www.starbucks.com",
  );
  const calls = [];
  const client = new StarbucksClient(
    new HttpTransport({
      cookieJar: jar,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ data: { user: { exId: "fixture" } } }),
          {
            headers: {
              "set-cookie": "session=rotated; Secure; HttpOnly; Path=/",
            },
          },
        );
      },
    }),
  );
  await client.user();
  assert.equal(
    calls[0].url,
    "https://www.starbucks.com/apiproxy/v1/orchestra/get-user",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.cookie, "session=private");
  assert.deepEqual(JSON.parse(calls[0].init.body), { variables: {} });
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(
    await jar.getCookieString("https://www.starbucks.com/"),
    "session=rotated",
  );
});
test("public GET has no body and no session requirement", async () => {
  const transport = new HttpTransport({
    fetch: async (_, init) => {
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(init.headers.cookie, undefined);
      return Response.json({ menus: [] });
    },
  });
  assert.deepEqual(await new StarbucksClient(transport).menu(), { menus: [] });
});
test("fetch never runs for disallowed destinations or order submission", async () => {
  let calls = 0;
  const transport = new HttpTransport({
    fetch: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  for (const path of [
    "https://evil.example/apiproxy/v1/orchestra/get-user",
    "/apiproxy/v1/orchestra/place-order",
  ])
    await assert.rejects(
      transport.request(path, { variables: {} }),
      /not permitted/,
    );
  assert.equal(calls, 0);
});
test("auth failure and rate limits are surfaced without retries", async () => {
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    const transport = new HttpTransport({
      fetch: async () => {
        calls++;
        return new Response("{}", { status });
      },
    });
    await assert.rejects(
      transport.request("/apiproxy/v1/orchestra/get-user", {}),
      (e) => e.status === status,
    );
    assert.equal(calls, 1);
  }
});
test("browser runtime is isolated to explicit login entry point", async () => {
  const pkg = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url)),
  );
  assert.ok(pkg.dependencies.playwright);
  assert.equal(pkg.exports["./login"].import, "./dist/browser-login.js");
  for (const file of await fs.readdir(new URL("../src/", import.meta.url))) {
    if (file === "browser-login.ts") continue;
    const text = await fs.readFile(
      new URL("../src/" + file, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      text,
      /from\s+["'][^"']*(?:playwright|puppeteer|child_process|browser\.js|service\.js)["']/,
    );
  }
  const root = await fs.readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!root.includes("browser-login"));
  const files = await fs.readdir(new URL("../dist/", import.meta.url));
  assert.ok(!files.some((f) => /^(browser|service)\./.test(f)));
});

test("limited member authorization is surfaced as a sign-in requirement instead of generic 403", async () => {
  const client = new StarbucksClient(
    new HttpTransport({
      fetch: async () =>
        Response.json(
          {
            roleProvided: "user:limited",
            roleRequired: "user",
            type: "authorize-operation",
          },
          { status: 403 },
        ),
    }),
  );
  await assert.rejects(client.wallet(), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, "REAUTHENTICATION_REQUIRED");
    assert.match(error.message, /Full sign-in required/);
    assert.match(error.message, /Sign in again/);
    return true;
  });
});

test("captured protection headers reach only their exact operation, with live session cookies retained", async () => {
  const headers = Object.fromEntries(
    ["a", "a0", "b", "c", "d", "f", "z"].map((suffix) => [
      "x-dq7hy5l1-" + suffix,
      "fixture-" + suffix,
    ]),
  );
  const jar = new CookieJar();
  await jar.setCookie(
    "session=fresh; Secure; Path=/",
    "https://www.starbucks.com/",
  );
  const calls = [];
  const transport = new HttpTransport({
    cookieJar: jar,
    requestContext: {
      version: 1,
      operations: {
        "price-order": { capturedAt: "2026-09-29T02:10:00Z", headers },
      },
    },
    fetch: async (url, init) => {
      const supplied = new Headers(init.headers);
      const pricing = new URL(url).pathname.endsWith("/price-order");
      if (pricing)
        assert.ok(
          init.headers instanceof Headers,
          "Protected requests use the verified Headers serialization",
        );
      calls.push(String(url));
      assert.equal(supplied.get("cookie"), "session=fresh");
      for (const [key, value] of Object.entries(headers))
        assert.equal(supplied.get(key), pricing ? value : null);
      return Response.json({ data: {} });
    },
  });
  await transport.request("/apiproxy/v1/orchestra/price-order", {
    variables: {},
  });
  await transport.request("/apiproxy/v1/orchestra/get-starpay-wallet", {
    variables: {},
  });
  await assert.rejects(
    transport.request("/apiproxy/v1/orchestra/submit-order", { variables: {} }),
    /submission is disabled/,
  );
  assert.equal(calls.length, 2);
});
